/**
 * 面板管理 API（走宿主 serviceRequest 代理到服务回环端口）。
 * 全部 JSON；长操作走 /api/jobs 异步任务 + 轮询，避免撞 20s RPC 超时。
 */
import type { IncomingMessage, ServerResponse } from 'node:http'

import type { App } from './app.ts'
import type { JobType, Period } from '../shared/types.ts'
import { writeJson } from './chat.ts'

export interface AdminDeps {
  app: App
  /** 修改对外端口，返回实际绑定的端口。 */
  rebindPort: (port: number) => Promise<number>
}

const PERIODS: Period[] = ['today', '24h', '7d', '30d']

function readPeriod(url: URL): Period {
  const p = url.searchParams.get('period')
  return PERIODS.includes(p as Period) ? (p as Period) : 'today'
}

async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const buf = chunk as Buffer
    size += buf.length
    if (size > 8 * 1024 * 1024) throw new Error('body too large')
    chunks.push(buf)
  }
  if (chunks.length === 0) return {}
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    return parsed !== null && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

const str = (v: unknown): string => (typeof v === 'string' ? v : '')
const bool = (v: unknown): boolean => v === true
const strArray = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [])

export async function handleAdmin(deps: AdminDeps, req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
  const { app } = deps
  const path = url.pathname
  const method = req.method ?? 'GET'

  // GET /api/state
  if (method === 'GET' && path === '/api/state') {
    writeJson(res, 200, app.state())
    return
  }

  // GET /api/stats
  if (method === 'GET' && path === '/api/stats') {
    const period = readPeriod(url)
    writeJson(res, 200, { period, stats: app.usage.stats(period), recent: app.usage.recentList(20) })
    return
  }

  // GET /api/stats/chart
  if (method === 'GET' && path === '/api/stats/chart') {
    const period = readPeriod(url)
    writeJson(res, 200, { period, buckets: app.usage.chart(period) })
    return
  }

  // POST /api/stats/clear
  if (method === 'POST' && path === '/api/stats/clear') {
    app.usage.clear()
    writeJson(res, 200, { ok: true })
    return
  }

  // POST /api/jobs  { type, supplierId }
  if (method === 'POST' && path === '/api/jobs') {
    const body = await readBody(req)
    const type = str(body.type) as JobType
    const supplierId = str(body.supplierId)
    if (!['login', 'checkin', 'models'].includes(type) || app.runtimeById(supplierId) === undefined) {
      writeJson(res, 400, { error: '非法任务参数' })
      return
    }
    writeJson(res, 200, app.startJob(type, supplierId))
    return
  }

  // GET /api/jobs/:id
  const jobMatch = /^\/api\/jobs\/([0-9a-f]+)$/.exec(path)
  if (method === 'GET' && jobMatch !== null) {
    const job = app.job(jobMatch[1]!)
    if (job === undefined) {
      writeJson(res, 404, { error: '任务不存在或已过期' })
      return
    }
    writeJson(res, 200, job)
    return
  }

  // GET /api/suppliers/:id
  const detailMatch = /^\/api\/suppliers\/([^/]+)$/.exec(path)
  if (method === 'GET' && detailMatch !== null) {
    const detail = app.supplierDetail(decodeURIComponent(detailMatch[1]!))
    if (detail === undefined) {
      writeJson(res, 404, { error: '供应商不存在' })
      return
    }
    writeJson(res, 200, detail)
    return
  }

  // GET /api/keys
  if (method === 'GET' && path === '/api/keys') {
    writeJson(res, 200, { keys: app.keys.list(), requireApiKey: app.keys.requireApiKey })
    return
  }

  // POST /api/keys  { name }
  if (method === 'POST' && path === '/api/keys') {
    const body = await readBody(req)
    const entry = app.keys.create(str(body.name))
    writeJson(res, 200, { entry: { ...entry, masked: entry.key.slice(0, 6) + '…' + entry.key.slice(-4) } })
    return
  }

  // POST /api/keys/toggle  { id, isActive }
  if (method === 'POST' && path === '/api/keys/toggle') {
    const body = await readBody(req)
    writeJson(res, 200, { ok: app.keys.setActive(str(body.id), bool(body.isActive)) })
    return
  }

  // POST /api/keys/delete  { id }
  if (method === 'POST' && path === '/api/keys/delete') {
    const body = await readBody(req)
    writeJson(res, 200, { ok: app.keys.remove(str(body.id)) })
    return
  }

  // POST /api/settings  { requireApiKey?, port? }
  if (method === 'POST' && path === '/api/settings') {
    const body = await readBody(req)
    if (body.requireApiKey !== undefined) app.keys.requireApiKey = bool(body.requireApiKey)
    if (body.port !== undefined) {
      const port = Number(body.port)
      if (!Number.isInteger(port) || port <= 0 || port >= 65536) {
        writeJson(res, 400, { error: '端口非法' })
        return
      }
      app.settings.setPort(port)
      const actual = await deps.rebindPort(port)
      writeJson(res, 200, { ok: true, port: actual, settings: app.settingsView() })
      return
    }
    writeJson(res, 200, { ok: true, settings: app.settingsView() })
    return
  }

  // 供应商级操作
  const supplierOp = /^\/api\/suppliers\/([^/]+)\/(.+)$/.exec(path)
  if (method === 'POST' && supplierOp !== null) {
    const id = decodeURIComponent(supplierOp[1]!)
    const op = supplierOp[2]!
    if (app.runtimeById(id) === undefined) {
      writeJson(res, 404, { error: '供应商不存在' })
      return
    }
    const body = await readBody(req)
    switch (op) {
      case 'enabled':
        app.config.setEnabled(id, bool(body.enabled))
        writeJson(res, 200, { ok: true })
        return
      case 'alias': {
        const alias = str(body.alias).trim()
        if (alias !== '') {
          const conflict = app.runtimes.find((r) => r.module.id !== id && app.aliasOf(r.module.id) === alias)
          if (conflict !== undefined) {
            writeJson(res, 409, { error: `别名 ${alias} 已被 ${conflict.module.id} 占用` })
            return
          }
        }
        app.config.setAlias(id, alias)
        writeJson(res, 200, { ok: true, alias: app.aliasOf(id) })
        return
      }
      case 'accounts/remove':
        app.creds.remove(id, str(body.uid))
        app.config.clearCredits(id, str(body.uid))
        writeJson(res, 200, { ok: true })
        return
      case 'pool-order':
        app.config.setPoolOrder(id, strArray(body.uids))
        writeJson(res, 200, { ok: true })
        return
      case 'models/toggle':
        app.config.setModelEnabled(id, str(body.id), bool(body.enabled))
        writeJson(res, 200, { ok: true })
        return
      case 'models/all':
        app.config.setAllModelsEnabled(id, bool(body.enabled), app.modelViews(id).map((m) => m.id))
        writeJson(res, 200, { ok: true })
        return
      case 'models/custom':
        app.config.addCustomModel(id, str(body.id))
        writeJson(res, 200, { ok: true })
        return
      case 'models/custom/remove':
        app.config.removeCustomModel(id, str(body.id))
        writeJson(res, 200, { ok: true })
        return
      default:
        writeJson(res, 404, { error: `未知操作 ${op}` })
        return
    }
  }

  // POST /api/combos/set  { name, targets }
  if (method === 'POST' && path === '/api/combos/set') {
    const body = await readBody(req)
    const name = str(body.name)
    if (name.trim() === '') {
      writeJson(res, 400, { error: '组合名不能为空' })
      return
    }
    app.combos.set(name, strArray(body.targets))
    writeJson(res, 200, { ok: true, combo: app.resolveCombo(name) })
    return
  }

  // POST /api/combos/remove  { name }
  if (method === 'POST' && path === '/api/combos/remove') {
    const body = await readBody(req)
    writeJson(res, 200, { ok: app.combos.remove(str(body.name)) })
    return
  }

  writeJson(res, 404, { error: `未知接口 ${method} ${path}` })
}
