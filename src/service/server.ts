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

import { App } from './app.ts'
import { handleAdmin } from './admin.ts'
import { handleChat, writeJson } from './chat.ts'

const MAX_BODY = 8 * 1024 * 1024
const PORT_FALLBACK_TRIES = 20

async function readJsonBody(req: http.IncomingMessage): Promise<Record<string, unknown> | undefined> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const buf = chunk as Buffer
    size += buf.length
    if (size > MAX_BODY) return undefined
    chunks.push(buf)
  }
  if (chunks.length === 0) return {}
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    return parsed !== null && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : undefined
  } catch {
    return undefined
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
        const body = await readJsonBody(req)
        if (body === undefined) {
          writeJson(res, 400, { error: { message: '请求体不是合法 JSON', type: 'invalid_request_error', param: null, code: null } })
          return
        }
        await handleChat(app, res, body)
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

/** /v1/models：别名全名 + 无歧义的裸名 + 组合名。 */
function modelList(app: App): Array<{ id: string; object: string; created: number; owned_by: string }> {
  const out = new Map<string, { id: string; object: string; created: number; owned_by: string }>()
  const bare = new Map<string, number>()
  const active = app.activeRuntimes()
  for (const r of active) {
    for (const m of app.enabledModelIds(r.module.id)) {
      bare.set(m, (bare.get(m) ?? 0) + 1)
      out.set(`${app.aliasOf(r.module.id)}/${m}`, { id: `${app.aliasOf(r.module.id)}/${m}`, object: 'model', created: 0, owned_by: r.module.id })
    }
  }
  for (const [m, count] of bare) {
    if (count === 1) out.set(m, { id: m, object: 'model', created: 0, owned_by: 'ocber-router' })
  }
  for (const combo of app.comboViews()) {
    if (combo.targets.length > 0 && combo.targets.every((t) => t.ok)) {
      out.set(combo.name, { id: combo.name, object: 'model', created: 0, owned_by: 'combo' })
    }
  }
  return [...out.values()]
}
