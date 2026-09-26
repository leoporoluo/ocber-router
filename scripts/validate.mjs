/**
 * 安装前自检：模拟 OpenChamber「设置 → 扩展」的清单解析与文件检查，
 * 在本地先把 `invalid-manifest` / `missing-build` 这类错误挡下来。
 *
 *   node scripts/validate.mjs
 */
import { readFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))

const { parseManifestJson } = await import('@openchamber/sdk/schemas')

let failures = 0
function check(name, ok, detail = '') {
  if (ok) console.log(`  ok   ${name}`)
  else {
    failures++
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

const parsed = parseManifestJson(JSON.stringify(pkg))
check('manifest parses', parsed.ok === true, parsed.ok ? '' : JSON.stringify(parsed.error))
if (parsed.ok) {
  const contributes = parsed.manifest.contributes ?? {}
  const panel = contributes.panel
  check('panel id', panel?.id === 'ocber-router', String(panel?.id))
  check('panel entry declared', typeof panel?.entry === 'string')
  if (typeof panel?.entry === 'string') {
    const htmlPath = join(root, panel.entry)
    check('panel html exists', existsSync(htmlPath), panel.entry)
    if (existsSync(htmlPath)) {
      const html = readFileSync(htmlPath, 'utf8')
      const scripts = [...html.matchAll(/<script[^>]+src=["']([^"']+)["']/g)].map((m) => m[1])
      check('panel html has scripts', scripts.length > 0)
      for (const src of scripts) check(`panel script ${src}`, existsSync(join(root, dirname(panel.entry), src)))
    }
  }
  const service = contributes.service
  check('service declared', service !== undefined && service.runtime === 'host')
  if (service?.entry) check('service bundle exists', existsSync(join(root, service.entry)), service.entry)
  check('engines floor', typeof parsed.manifest.engines?.openchamber === 'string', String(parsed.manifest.engines?.openchamber))
  check('version semver', /^\d+\.\d+\.\d+$/.test(pkg.version), pkg.version)
}

console.log(failures === 0 ? '\nVALIDATE OK' : `\nVALIDATE FAILED (${failures})`)
process.exit(failures === 0 ? 0 : 1)
