/**
 * HTTP 服务：两个回环监听。
 *
 *   1) 管理端口（宿主分配，OPENCHAMBER_SERVICE_PORT）—— 只给扩展面板通过
 *      宿主代理访问，每个请求必须带 `Authorization: Bearer <SERVICE_TOKEN>`。
 *      路由：GET /health、/api/*。
 *
 *   2) 对外端口（settings.port，默认 3080，冲突自动顺延）—— OpenAI 兼容端点，
 *      给 Claude Code / Cline / OpenCode 之类的外部客户端用。鉴权由
 *      `requireApiKey` + 库内 key 决定（默认关，与 9router 一致）。
 *
 * 两个监听都只绑 127.0.0.1。对外端口是「服务自己额外开的」，不在 guest 契约里，
 * 但它就是一个普通 Node 进程的额外 loopback 监听，不越权、不外泄。
 */
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { brotliDecompressSync, gunzipSync, inflateSync } from 'node:zlib'

import { App } from './app.ts'
import { handleAdmin } from './admin.ts'
import { handleChat, writeJson } from './chat.ts'

const MAX_BODY = 64 * 1024 * 1024
const PORT_FALLBACK_TRIES = 20

interface BodyResult {
  ok: boolean
  body?: Record<string, unknown>
  /** 给客户端看的原因（失败时）。 */
  error?: string
  /** 给服务日志看的技术细节。 */
  detail?: string
}

/**
 * 读请求体。
 *
 * 上限放宽到 64MB 并支持 `content-encoding: gzip/deflate/br`：OpenCode 发来的
 * 会话上下文里可能带多张图片（base64），旧的 8MB 上限会把请求误判成
 * 「请求体不是合法 JSON」。
 * 失败原因要能分辨：太大 / 解压失败 / JSON 坏了 / 不是对象。
 */
async function readJsonBody(req: http.IncomingMessage): Promise<BodyResult> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const buf = chunk as Buffer
    size += buf.length
    if (size > MAX_BODY) {
      return {
        ok: false,
        error: `请求体超过上限（${Math.round(MAX_BODY / 1024 / 1024)}MB）`,
        detail: `content-length=${req.headers['content-length'] ?? '?'} read=${size}`,
      }
    }
    chunks.push(buf)
  }
  if (chunks.length === 0) return { ok: true, body: {} }

  let raw = Buffer.concat(chunks)
  const encoding = String(req.headers['content-encoding'] ?? '').trim().toLowerCase()
  try {
    if (encoding === 'gzip') raw = gunzipSync(raw)
    else if (encoding === 'deflate') raw = inflateSync(raw)
    else if (encoding === 'br') raw = brotliDecompressSync(raw)
  } catch (err) {
    return { ok: false, error: `请求体解压失败（${encoding}）`, detail: (err as Error).message }
  }

  const text = raw.toString('utf8').replace(/^\uFEFF/, '')
  try {
    const parsed = JSON.parse(text) as unknown
    if (parsed === null || typeof parsed !== 'object') {
      return { ok: false, error: '请求体不是 JSON 对象', detail: `type=${typeof parsed}` }
    }
    return { ok: true, body: parsed as Record<string, unknown> }
  } catch (err) {
    return {
      ok: false,
      error: '请求体不是合法 JSON',
      detail: `${(err as Error).message} | content-type=${req.headers['content-type'] ?? '?'} encoding=${encoding || 'identity'} length=${raw.length} head=${JSON.stringify(text.slice(0, 120))}`,
    }
  }
}

function listen(server: http.Server, port: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const onError = (err: Error): void => {
      server.off('listening', onListening)
      reject(err)
    }
    const onListening = (): void => {
      server.off('error', onError)
      const addr = server.address() as AddressInfo | null
      resolve(addr?.port ?? port)
    }
    server.once('error', onError)
    server.once('listening', onListening)
    server.listen(port, '127.0.0.1')
  })
}

function closeServer(server: http.Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()))
}

function bearer(req: http.IncomingMessage): string {
  const raw = req.headers.authorization ?? ''
  return raw.startsWith('Bearer ') ? raw.slice(7) : ''
}

export interface StartedServer {
  publicPort: number
  close(): Promise<void>
}

export async function startServer(app: App, serviceToken: string, adminPort: number): Promise<StartedServer> {
  // ---- 管理端口（宿主分配） ----
  const adminServer = http.createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1')
      if (bearer(req) !== serviceToken) {
        writeJson(res, 401, { error: 'unauthorized' })
        return
      }
      if (req.method === 'GET' && url.pathname === '/health') {
        writeJson(res, 200, { ok: true, version: app.state().version })
        return
      }
      if (url.pathname.startsWith('/api/')) {
        try {
          await handleAdmin({ app, rebindPort }, req, res, url)
        } catch (err) {
          writeJson(res, 500, { error: (err as Error).message })
        }
        return
      }
      writeJson(res, 404, { error: 'not found' })
    })()
  })

  // 先在管理端口上挂起 rebindPort（它只被 /api/settings 调用）
  let publicServer: http.Server | null = null
  const rebindPort = async (port: number): Promise<number> => {
    if (publicServer !== null) {
      await closeServer(publicServer)
      publicServer = null
    }
    const next = http.createServer(publicServerHandler)
    const actual = await listenPublic(next, port)
    publicServer = next
    app.endpointPort = actual
    return actual
  }

  await listen(adminServer, adminPort)

  // ---- 对外端口（OpenAI 兼容） ----
  publicServer = http.createServer(publicServerHandler)
  const publicPort = await listenPublic(publicServer, app.settings.get().port || 3080)
  app.endpointPort = publicPort

  function publicServerHandler(req: http.IncomingMessage, res: http.ServerResponse): void {
    void (async () => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1')
      if (req.method === 'GET' && (url.pathname === '/health' || url.pathname === '/')) {
        writeJson(res, 200, { ok: true, endpoint: `http://127.0.0.1:${app.endpointPort}/v1` })
        return
      }
      if (!app.keys.verify(bearer(req))) {
        writeJson(res, 401, { error: { message: '无效的 API Key', type: 'invalid_request_error', param: null, code: 'invalid_api_key' } })
        return
      }
      if (req.method === 'GET' && url.pathname === '/v1/models') {
        writeJson(res, 200, { object: 'list', data: modelList(app) })
        return
      }
      if (req.method === 'POST' && url.pathname === '/v1/chat/completions') {
        const parsed = await readJsonBody(req)
        if (!parsed.ok || parsed.body === undefined) {
          console.error(`[ocber-router] /v1/chat/completions body rejected: ${parsed.error ?? 'unknown'} | ${parsed.detail ?? ''}`)
          writeJson(res, 400, {
            error: { message: parsed.error ?? '请求体不合法', type: 'invalid_request_error', param: null, code: null },
          })
          return
        }
        await handleChat(app, res, parsed.body)
        return
      }
      writeJson(res, 404, { error: { message: `未知端点 ${req.method} ${url.pathname}`, type: 'invalid_request_error', param: null, code: null } })
    })()
  }

  return {
    publicPort,
    close: async () => {
      await Promise.all([closeServer(adminServer), publicServer !== null ? closeServer(publicServer) : Promise.resolve()])
    },
  }
}

/** 端口占用时顺延尝试，最终回落到系统临时端口。 */
async function listenPublic(server: http.Server, preferred: number): Promise<number> {
  const base = Number.isInteger(preferred) && preferred > 0 ? preferred : 3080
  for (let i = 0; i < PORT_FALLBACK_TRIES; i += 1) {
    const candidate = base + i
    if (candidate >= 65536) break
    try {
      return await listen(server, candidate)
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw err
    }
  }
  return listen(server, 0)
}

/**
 * /v1/models：只暴露 `别名/模型` 全名 + 组合名。
 *
 * 不再输出「裸模型名」：同一份列表同时喂给 OpenCode 的 provider 配置，
 * 裸名与全名并存会让模型选择里每个模型出现两次（2026-09-27 反馈）。
 * 需要裸名调用的客户端仍可直接请求（路由层兼容），只是不列出。
 */
function modelList(app: App): Array<{ id: string; object: string; created: number; owned_by: string }> {
  const out = new Map<string, { id: string; object: string; created: number; owned_by: string }>()
  for (const r of app.activeRuntimes()) {
    for (const m of app.enabledModelIds(r.module.id)) {
      const id = `${app.aliasOf(r.module.id)}/${m}`
      out.set(id, { id, object: 'model', created: 0, owned_by: r.module.id })
    }
  }
  for (const combo of app.comboViews()) {
    if (combo.targets.some((t) => t.ok)) {
      out.set(combo.name, { id: combo.name, object: 'model', created: 0, owned_by: 'combo' })
    }
  }
  return [...out.values()]
}
