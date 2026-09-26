/**
 * 本地冒烟测试：用宿主约定的环境变量把 service/main.js 拉起来，验证
 *   - 管理端口鉴权、/api/state、/v1/models、未知模型 404、对外端口绑定
 *   - opencode.json provider 同步：新增 providers.ocber、保留其它 provider、
 *     组合进入 /v1/models 与 provider 模型表
 *
 *   node scripts/smoke.mjs
 */
import { spawn } from 'node:child_process'
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
  await sleep(1200) // 等后台目录预热落定（无账号时用内置兜底表，很快）

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

  // ---- opencode provider 同步 ----
  const state2 = await (await admin('/api/state')).json()
  check('opencode sync wrote provider', state2.opencode?.exists === true && state2.opencode?.modelCount > 0, JSON.stringify(state2.opencode))
  check('opencode sync reported no error', state2.opencode?.error === undefined, String(state2.opencode?.error))

  const cfg = readConfig()
  check('existing provider keepme preserved', JSON.stringify(cfg.providers?.keepme) === JSON.stringify(originalProviders.keepme))
  check('existing provider other preserved', JSON.stringify(cfg.providers?.other) === JSON.stringify(originalProviders.other))
  check('native provider key untouched', JSON.stringify(cfg.provider) === '{}')
  check('providers.ocber written', typeof cfg.providers?.ocber?.settings?.baseURL === 'string' && cfg.providers.ocber.settings.baseURL.endsWith('/v1'), JSON.stringify(cfg.providers?.ocber?.settings))
  check('ocber models non-empty', Object.keys(cfg.providers?.ocber?.models ?? {}).length > 0)

  const comboRes = await admin('/api/combos/set', { method: 'POST', body: JSON.stringify({ name: 'smoke-combo', targets: ['glm-5.3'] }) })
  const combo = await comboRes.json()
  check('combo target resolves (bare model name)', combo.combo?.targets?.[0]?.ok === true, JSON.stringify(combo.combo))

  await admin('/api/opencode/sync', { method: 'POST' })
  const cfg2 = readConfig()
  check('combo synced into provider models', Object.keys(cfg2.providers?.ocber?.models ?? {}).includes('smoke-combo'))
  check('keepme still preserved after second sync', JSON.stringify(cfg2.providers?.keepme) === JSON.stringify(originalProviders.keepme))

  const models2 = await (await fetch(`${base}/v1/models`)).json()
  check('combo listed in /v1/models', models2.data.some((m) => m.id === 'smoke-combo'))

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
