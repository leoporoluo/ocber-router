/**
 * 本地冒烟测试：用宿主约定的环境变量把 service/main.js 拉起来，验证
 *   - 管理端口鉴权、/api/state、/v1/models、未知模型 404、对外端口绑定
 *   - 没账号的供应商：模型不列出、不进 provider
 *   - opencode.json provider 同步：新增 providers.ocber、保留其它 provider、
 *     只写 `别名/模型` + 组合（不写裸名，避免重复）、组合进入两张表
 *   - 大请求体（>8MB）与 gzip 请求体都能正常解析（不再误报「不是合法 JSON」）
 *
 *   node scripts/smoke.mjs
 */
import { spawn } from 'node:child_process'
import { gzipSync } from 'node:zlib'
import http from 'node:http'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const adminPort = 39000 + Math.floor(Math.random() * 2000)
const token = 'smoke-token'
const dataDir = mkdtempSync(join(tmpdir(), 'ocber-smoke-data-'))
const homeDir = mkdtempSync(join(tmpdir(), 'ocber-smoke-home-'))

// 假的用户 opencode.json：同步时除了 providers.ocber，其它必须原样保留
const opencodeDir = join(homeDir, '.config', 'opencode')
mkdirSync(opencodeDir, { recursive: true })
const opencodeFile = join(opencodeDir, 'opencode.json')
const originalProviders = {
  keepme: { name: 'keepme', package: 'aisdk:@ai-sdk/openai-compatible', settings: { baseURL: 'https://keep.me/v1' }, models: { m1: { modelID: 'm1', name: 'm1' } } },
  other: { name: 'other', settings: { baseURL: 'https://other.example/v1' } },
}
writeFileSync(opencodeFile, JSON.stringify({ $schema: 'https://opencode.ai/config.json', provider: {}, providers: originalProviders }, null, 2))

const child = spawn(process.execPath, [join(root, 'service', 'main.js')], {
  cwd: root,
  env: {
    ...process.env,
    OPENCHAMBER_SERVICE_PORT: String(adminPort),
    OPENCHAMBER_SERVICE_TOKEN: token,
    OCBER_DATA_DIR: dataDir,
    HOME: homeDir,
    USERPROFILE: homeDir,
  },
  stdio: ['ignore', 'pipe', 'pipe'],
})

let output = ''
child.stdout.on('data', (d) => (output += d.toString()))
child.stderr.on('data', (d) => (output += d.toString()))

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function waitReady() {
  for (let i = 0; i < 100; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${adminPort}/health`, { headers: { Authorization: `Bearer ${token}` } })
      if (r.ok) return
    } catch {
      // not up yet
    }
    await sleep(150)
  }
  throw new Error(`service did not become ready\n${output}`)
}

const admin = (path, init = {}) =>
  fetch(`http://127.0.0.1:${adminPort}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, ...(init.body ? { 'Content-Type': 'application/json' } : {}) },
  })

function readConfig() {
  return JSON.parse(readFileSync(opencodeFile, 'utf8'))
}

let failures = 0
function check(name, condition, detail = '') {
  if (condition) {
    console.log(`  ok   ${name}`)
  } else {
    failures++
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

try {
  await waitReady()

  const unauth = await fetch(`http://127.0.0.1:${adminPort}/api/state`)
  check('admin requires bearer', unauth.status === 401, `status=${unauth.status}`)

  const stateRes = await admin('/api/state')
  const state = await stateRes.json()
  check('GET /api/state', stateRes.status === 200, `status=${stateRes.status}`)
  check('two suppliers', Array.isArray(state.suppliers) && state.suppliers.length === 2)
  check('endpoint port bound', Number.isInteger(state.endpointPort) && state.endpointPort > 0, JSON.stringify(state.endpointPort))

  const base = `http://127.0.0.1:${state.endpointPort}`
  await sleep(1200) // 等后台目录预热落定

  // 两个供应商都没有账号 → 没有可列出的模型
  const models = await (await fetch(`${base}/v1/models`)).json()
  check('no-account suppliers expose no models', models.data.length === 0, JSON.stringify(models.data.slice(0, 4)))

  const unknown = await fetch(`${base}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'definitely-not-a-model', messages: [{ role: 'user', content: 'hi' }] }),
  })
  check('unknown model → 404', unknown.status === 404, `status=${unknown.status}`)

  // ---- opencode provider 同步 ----
  const state2 = await (await admin('/api/state')).json()
  check('opencode sync reported no error', state2.opencode?.error === undefined, String(state2.opencode?.error))

  const cfg = readConfig()
  check('existing provider keepme preserved', JSON.stringify(cfg.providers?.keepme) === JSON.stringify(originalProviders.keepme))
  check('existing provider other preserved', JSON.stringify(cfg.providers?.other) === JSON.stringify(originalProviders.other))
  check('native provider key untouched', JSON.stringify(cfg.provider) === '{}')
  check('providers.ocber written', typeof cfg.providers?.ocber?.settings?.baseURL === 'string' && cfg.providers.ocber.settings.baseURL.endsWith('/v1'), JSON.stringify(cfg.providers?.ocber?.settings))
  check('no-account supplier models stay out of provider', Object.keys(cfg.providers?.ocber?.models ?? {}).length === 0, JSON.stringify(Object.keys(cfg.providers?.ocber?.models ?? {})))

  // 组合：别名形式在任何账号状态下都可解析
  const comboRes = await admin('/api/combos/set', { method: 'POST', body: JSON.stringify({ name: 'smoke-combo', targets: ['codebuddy/glm-5.3', 'codebuddy-en/glm-5.3'] }) })
  const combo = await comboRes.json()
  check('combo targets resolve', (combo.combo?.targets ?? []).every((t) => t.ok), JSON.stringify(combo.combo))

  await admin('/api/opencode/sync', { method: 'POST' })
  const cfg2 = readConfig()
  const ids = Object.keys(cfg2.providers?.ocber?.models ?? {})
  check('combo synced into provider models', ids.includes('smoke-combo'), JSON.stringify(ids))
  check('combos-only mode writes nothing else', ids.length === 1, JSON.stringify(ids))
  check('no bare duplicate of a model id', !ids.includes('glm-5.3'), JSON.stringify(ids))
  check('placeholder "default" filtered out', !ids.includes('codebuddy/default'))
  check('keepme preserved after second sync', JSON.stringify(cfg2.providers?.keepme) === JSON.stringify(originalProviders.keepme))

  const models2 = await (await fetch(`${base}/v1/models`)).json()
  check('combo listed in /v1/models', models2.data.some((m) => m.id === 'smoke-combo'))
  check('no alias models listed (combos only)', !models2.data.some((m) => m.id.includes('/')), JSON.stringify(models2.data.map((m) => m.id)))
  check('exactly the combos are listed', models2.data.length === 1 && models2.data[0].id === 'smoke-combo', JSON.stringify(models2.data.map((m) => m.id)))

  // ---- 请求体：大 body 与 gzip 都要能解析 ----
  const bigText = 'x'.repeat(9 * 1024 * 1024)
  const bigBody = JSON.stringify({ model: 'codebuddy/glm-5.3', stream: false, messages: [{ role: 'user', content: bigText }] })
  const bigRes = await fetch(`${base}/v1/chat/completions`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: bigBody })
  const bigJson = await bigRes.json().catch(() => ({}))
  check('9MB body parsed (not "invalid JSON")', bigRes.status !== 400 || !String(bigJson?.error?.message ?? '').includes('不是合法 JSON'), `status=${bigRes.status} msg=${bigJson?.error?.message}`)
  check('9MB body routed to 503 (no accounts)', bigRes.status === 503, `status=${bigRes.status}`)

  const gzRes = await fetch(`${base}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Content-Encoding': 'gzip' },
    body: gzipSync(Buffer.from(JSON.stringify({ model: 'codebuddy/glm-5.3', stream: false, messages: [{ role: 'user', content: 'hi' }] }))),
  })
  check('gzip body accepted (503, not 400)', gzRes.status === 503, `status=${gzRes.status}`)

  const health = await fetch(`${base}/health`)
  check('public /health', health.status === 200, `status=${health.status}`)

  // ---- TPS 仪表盘：起一个假的事件流，验证速率/校准/上一轮 ----
  const sseServer = http.createServer((req, res) => {
    if (!(req.url ?? '').startsWith('/api/global/event')) {
      res.writeHead(404)
      res.end()
      return
    }
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' })
    const send = (event) => res.write(`data: ${JSON.stringify(event)}\n\n`)
    send({ type: 'session.execution.started', data: { sessionID: 'ses_smoke' } })
    let i = 0
    const timer = setInterval(() => {
      i += 1
      send({ type: 'session.text.delta', data: { sessionID: 'ses_smoke', assistantMessageID: 'msg_1', ordinal: 0, delta: 'x'.repeat(100) } })
      if (i >= 20) {
        clearInterval(timer)
        send({ type: 'session.step.ended', data: { sessionID: 'ses_smoke', assistantMessageID: 'msg_1', tokens: { output: 500, reasoning: 0 } } })
        send({ type: 'session.execution.succeeded', data: { sessionID: 'ses_smoke' } })
      }
    }, 40)
    req.on('close', () => clearInterval(timer))
  })
  const ssePort = await new Promise((resolve) => sseServer.listen(0, '127.0.0.1', () => resolve(sseServer.address().port)))

  await admin('/api/tps/watch', { method: 'POST', body: JSON.stringify({ origin: `http://127.0.0.1:${ssePort}`, sessionId: 'ses_smoke', title: 'smoke' }) })
  await sleep(1400)
  const tps1 = await (await admin('/api/tps')).json()
  check('tps connection live', tps1.connection === 'live', String(tps1.connection))
  check('tps counted streamed chars', tps1.chars > 0, JSON.stringify(tps1.chars))
  check('tps charsPerSecond > 0', tps1.charsPerSecond > 0, String(tps1.charsPerSecond))
  check('tps tokensPerSecond > 0', tps1.tokensPerSecond > 0, String(tps1.tokensPerSecond))
  check('tps last turn recorded', tps1.lastTurn !== null && tps1.lastTurn.tokens > 0, JSON.stringify(tps1.lastTurn))
  check('tps session id echoed', tps1.sessionId === 'ses_smoke', String(tps1.sessionId))
  sseServer.close()

  // ---- 单块回复：生成时间退化为毫秒级时要用整轮耗时兜底，不能算出几千 tok/s ----
  const chunkedServer = http.createServer((req, res) => {
    if (!(req.url ?? '').startsWith('/api/global/event')) {
      res.writeHead(404)
      res.end()
      return
    }
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' })
    const send = (event) => res.write(`data: ${JSON.stringify(event)}\n\n`)
    send({ type: 'session.execution.started', data: { sessionID: 'ses_chunk' } })
    send({ type: 'session.text.delta', data: { sessionID: 'ses_chunk', assistantMessageID: 'msg_c', ordinal: 0, delta: 'x'.repeat(1000) } })
    setTimeout(() => {
      send({ type: 'session.step.ended', data: { sessionID: 'ses_chunk', assistantMessageID: 'msg_c', tokens: { output: 250, reasoning: 0 } } })
      send({ type: 'session.execution.succeeded', data: { sessionID: 'ses_chunk' } })
    }, 500)
    req.on('close', () => {})
  })
  const chunkedPort = await new Promise((resolve) => chunkedServer.listen(0, '127.0.0.1', () => resolve(chunkedServer.address().port)))
  await admin('/api/tps/watch', { method: 'POST', body: JSON.stringify({ origin: `http://127.0.0.1:${chunkedPort}`, sessionId: 'ses_chunk', title: 'chunk' }) })
  await sleep(1200)
  const tps2 = await (await admin('/api/tps')).json()
  check(
    'single-chunk turn falls back to wall time (not inflated)',
    tps2.lastTurn !== null && tps2.lastTurn.tokensPerSecond > 0 && tps2.lastTurn.tokensPerSecond < 5000,
    JSON.stringify(tps2.lastTurn),
  )
  chunkedServer.close()

  console.log(failures === 0 ? '\nSMOKE OK' : `\nSMOKE FAILED (${failures})`)
} catch (err) {
  failures++
  console.error(`SMOKE ERROR: ${err.message}`)
} finally {
  child.kill()
  await sleep(300)
  process.exit(failures === 0 ? 0 : 1)
}
