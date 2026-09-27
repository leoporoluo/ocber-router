/**
 * OpenCode provider 自动同步 —— 把本机端点写成 `~/.config/opencode/opencode.json`
 * 里的一个 provider（id `ocber`），这样 OpenChamber / OpenCode / Casleo 的模型
 * 选择里能直接看到本路由器的模型与组合，不需要手动复制配置。
 *
 * 由本地服务执行（服务本来就是有用户权限的普通进程，写这个文件不需要面板的
 * filesystem 能力）：只改 `providers.ocber` 这一个键，其它内容原样保留；
 * 写盘走「临时文件 + rename」原子替换；文件不是合法 JSON 时**不动**它，
 * 只把错误报给面板。
 *
 * 配置形状对齐 Casleo 写出来的 `providers` 段（本机实测可用的形态）。
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'

import type { App } from './app.ts'
import type { OpencodeSyncView } from '../shared/types.ts'

export const OPENCODE_PROVIDER_ID = 'ocber'

/** OpenCode 配置文件路径（与本机 Casleo 用的同一份）。 */
export function opencodeConfigPath(): string {
  return join(homedir(), '.config', 'opencode', 'opencode.json')
}

/** 目录长度归一：上游/兜底表的 context_length 有「k」和「tokens」两种口径。 */
function normalizeContext(value: number | undefined): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return undefined
  return value < 10_000 ? value * 1000 : value
}

/** 上游配置里的占位项，不是可直选的模型。 */
const HIDDEN_MODEL_IDS = new Set(['default'])

interface ProviderModel {
  modelID: string
  name: string
  limit?: { context: number }
  capabilities: { tools: boolean; input: string[]; output: string[] }
}

/**
 * provider 里要暴露的模型：
 *   - 只写 `别名/模型`（不写裸名，否则 OpenCode 的模型选择里每个模型出现两次）
 *   - 没账号的供应商整个跳过（模型当前不可用，见 app.supplierHasAccounts）
 *   - 组合永远带上（前提：至少一个目标可解析）
 */
function buildModels(app: App): Record<string, ProviderModel> {
  const out: Record<string, ProviderModel> = {}
  const add = (id: string, context?: number): void => {
    if (HIDDEN_MODEL_IDS.has(id)) return
    const limit = normalizeContext(context)
    out[id] = {
      modelID: id,
      name: id,
      ...(limit !== undefined ? { limit: { context: limit } } : {}),
      capabilities: { tools: true, input: ['text', 'image'], output: ['text'] },
    }
  }

  if (app.settings.get().opencodeSyncMode !== 'combos') {
    for (const supplier of app.activeRuntimes()) {
      const alias = app.aliasOf(supplier.module.id)
      for (const model of app.modelViews(supplier.module.id)) {
        if (!model.enabled) continue
        add(`${alias}/${model.id}`, model.context_length)
      }
    }
  }
  for (const combo of app.comboViews()) {
    // 至少一个目标可解析就收录：请求时会自动跳过无效目标
    if (combo.targets.some((t) => t.ok)) add(combo.name)
  }
  return out
}

/** 同步一次。force=true 时即使关闭自动同步、或内容没变也写。 */
export function syncOpencode(app: App, force = false): OpencodeSyncView {
  const settings = app.settings.get()
  const path = opencodeConfigPath()

  const view = (extra?: Partial<OpencodeSyncView>): OpencodeSyncView => ({
    enabled: settings.opencodeSync,
    mode: settings.opencodeSyncMode,
    path,
    exists: existsSync(path),
    syncedAt: settings.opencodeSyncedAt,
    modelCount: 0,
    ...extra,
  })

  if (!settings.opencodeSync && !force) return view()

  const models = buildModels(app)
  const modelCount = Object.keys(models).length
  const signature = createHash('sha1')
    .update(JSON.stringify({ endpoint: app.endpoint(), mode: settings.opencodeSyncMode, models: Object.keys(models).sort() }))
    .digest('hex')
  if (!force && signature === settings.opencodeSignature) {
    return view({ modelCount, syncedAt: settings.opencodeSyncedAt })
  }

  try {
    let config: Record<string, unknown>
    if (existsSync(path)) {
      const raw = readFileSync(path, 'utf8')
      const parsed = raw.trim() === '' ? {} : (JSON.parse(raw) as unknown)
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return view({ modelCount, error: 'opencode.json 不是 JSON 对象，已跳过（未改动）' })
      }
      config = parsed as Record<string, unknown>
    } else {
      config = { $schema: 'https://opencode.ai/config.json' }
    }

    const existing = config.providers
    const providers: Record<string, unknown> =
      existing !== null && typeof existing === 'object' && !Array.isArray(existing) ? { ...(existing as Record<string, unknown>) } : {}

    const activeKey = app.keys.requireApiKey ? app.keys.firstActiveKey() : undefined
    providers[OPENCODE_PROVIDER_ID] = {
      name: 'OCBer Router',
      package: 'aisdk:@ai-sdk/openai-compatible',
      settings: {
        baseURL: app.endpoint(),
        ...(activeKey !== undefined ? { apiKey: activeKey } : {}),
      },
      models,
    }
    config.providers = providers

    const dir = dirname(path)
    if (dir !== '' && dir !== '.') mkdirSync(dir, { recursive: true })
    const tmp = `${path}.ocber.tmp`
    writeFileSync(tmp, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 })
    renameSync(tmp, path)

    const syncedAt = Date.now()
    app.settings.setOpencodeSyncState(signature, syncedAt)
    return view({ modelCount, syncedAt, exists: true })
  } catch (err) {
    return view({ modelCount, error: (err as Error).message })
  }
}
