/**
 * 本地冒烟测试：用宿主约定的环境变量把 service/main.js 拉起来，验证
 * 管理端口鉴权、/api/state、/v1/models、未知模型的 404，以及对外端口绑定。
 *
 *   node scripts/smoke.mjs
 */
import { spawn } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const adminPort = 39000 + Math.floor(Math.random() * 2000)
const token = 'smoke-token'
const dataDir = mkdtempSync(join(tmpdir(), 'ocber-smoke-'))

const child = spawn(process.execPath, [join(root, 'service', 'main.js')], {
  cwd: root,
  env: {
    ...process.env,
    OPENCHAMBER_SERVICE_PORT: String(adminPort),
    OPENCHAMBER_SERVICE_TOKEN: token,
    OCBER_DATA_DIR: dataDir,
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

  const stateRes = await fetch(`http://127.0.0.1:${adminPort}/api/state`, { headers: { Authorization: `Bearer ${token}` } })
  const state = await stateRes.json()
  check('GET /api/state', stateRes.status === 200, `status=${stateRes.status}`)
  check('two suppliers', Array.isArray(state.suppliers) && state.suppliers.length === 2)
  check('endpoint port bound', Number.isInteger(state.endpointPort) && state.endpointPort > 0, JSON.stringify(state.endpointPort))

  const base = `http://127.0.0.1:${state.endpointPort}`
  await sleep(600) // 等后台目录预热落定（无账号时用内置兜底表，很快）
  const modelsRes = await fetch(`${base}/v1/models`)
  const models = await modelsRes.json()
  check('GET /v1/models', modelsRes.status === 200 && models.object === 'list', `status=${modelsRes.status}`)
  check(
    'alias-prefixed models present',
    Array.isArray(models.data) && models.data.some((m) => m.id.startsWith('codebuddy/')),
    JSON.stringify(models.data?.slice(0, 3)),
  )

  const unknown = await fetch(`${base}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'definitely-not-a-model', messages: [{ role: 'user', content: 'hi' }] }),
  })
  check('unknown model → 404', unknown.status === 404, `status=${unknown.status}`)

  const health = await fetch(`${base}/health`)
  check('public /health', health.status === 200, `status=${health.status}`)

  console.log(failures === 0 ? '\nSMOKE OK' : `\nSMOKE FAILED (${failures})`)
} catch (err) {
  failures++
  console.error(`SMOKE ERROR: ${err.message}`)
} finally {
  child.kill()
  await sleep(300)
  process.exit(failures === 0 ? 0 : 1)
}
