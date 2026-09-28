/**
 * 本地服务的 JSON 持久化 —— 凭证 / 供应商配置 / 密钥 / 设置 / 组合。
 *
 * 全部落盘在「扩展安装目录」下的 `data/`（卸载扩展即一并删除）。可用
 * OCBER_DATA_DIR 覆盖。刻意不用 SQLite：服务跑在 Electron 的 Node 里，
 * `node:sqlite` 是实验特性、跨宿主版本不稳，而这里的量级（几十个账号、
 * 几十个 key）用 JSON 绰绰有余。
 *
 * 写盘一律「临时文件 + rename」原子替换，跟 dsh-router 的落盘风格一致。
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomBytes } from 'node:crypto'

import type { CredentialStoreLike, SupplierConfigStoreLike } from './suppliers/codebuddy/contract.ts'

/**
 * 扩展根目录。从文件自身位置向上查找含 package.json 的目录，扩展装在
 * 哪儿都能正确定位（产物为 `service/main.js`，源码为 `src/service/store.ts`）。
 */
function resolveExtensionDir(): string {
  let dir = dirname(fileURLToPath(import.meta.url))
  for (let i = 0; i < 5; i += 1) {
    if (existsSync(join(dir, 'package.json'))) return dir
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return dirname(dirname(fileURLToPath(import.meta.url)))
}

/** 数据目录。 */
export function resolveDataDir(): string {
  const override = (process.env.OCBER_DATA_DIR ?? '').trim()
  if (override !== '') return override
  return join(resolveExtensionDir(), 'data')
}

/** 原子写 JSON。 */
function writeJson(file: string, value: unknown): void {
  try {
    const dir = dirname(file)
    if (dir !== '' && dir !== '.') mkdirSync(dir, { recursive: true })
    const tmp = `${file}.tmp`
    writeFileSync(tmp, JSON.stringify(value, null, 2), { mode: 0o600 })
    renameSync(tmp, file)
  } catch {
    // 持久化失败不阻断运行
  }
}

function readJson<T>(file: string): T | undefined {
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as T
  } catch {
    return undefined
  }
}

// ---------------------------------------------------------------------------
// 凭证
// ---------------------------------------------------------------------------

/** { supplierId: { uid: blob } } */
type CredentialsFile = Record<string, Record<string, unknown>>

/** 凭证库（不透明 blob，供应商定义格式）。 */
export class CredentialStore implements CredentialStoreLike {
  private file: string
  private data: CredentialsFile = {}

  constructor(dataDir: string) {
    this.file = join(dataDir, 'credentials.json')
    const raw = readJson<CredentialsFile>(this.file)
    if (raw !== undefined && typeof raw === 'object' && raw !== null) this.data = raw
  }

  list(supplierId: string): string[] {
    const bucket = this.data[supplierId]
    return bucket === undefined ? [] : Object.keys(bucket)
  }

  get<T = unknown>(supplierId: string, uid: string): T | undefined {
    return this.data[supplierId]?.[uid] as T | undefined
  }

  save(supplierId: string, uid: string, blob: unknown): void {
    const bucket = this.data[supplierId] ?? {}
    bucket[uid] = blob
    this.data[supplierId] = bucket
    writeJson(this.file, this.data)
  }

  remove(supplierId: string, uid: string): void {
    const bucket = this.data[supplierId]
    if (bucket === undefined || bucket[uid] === undefined) return
    delete bucket[uid]
    writeJson(this.file, this.data)
  }
}

// ---------------------------------------------------------------------------
// 供应商配置（别名 / 模型启停 / 池顺序 / 积分缓存）
// ---------------------------------------------------------------------------

export interface SupplierConfig {
  enabled: boolean
  alias: string
  disabled: string[]
  custom: string[]
  poolOrder: string[]
  poolStrategy: 'fallback' | 'round-robin'
  credits: Record<string, number>
}

interface SupplierConfigFile {
  suppliers: Record<string, Partial<SupplierConfig>>
}

const DEFAULT_SUPPLIER_CONFIG = (): SupplierConfig => ({
  enabled: true,
  alias: '',
  disabled: [],
  custom: [],
  poolOrder: [],
  poolStrategy: 'fallback',
  credits: {},
})

/** 供应商通用配置存储。 */
export class SupplierConfigStore implements SupplierConfigStoreLike {
  private file: string
  private bySupplier = new Map<string, SupplierConfig>()

  constructor(dataDir: string) {
    this.file = join(dataDir, 'supplier-config.json')
    const raw = readJson<SupplierConfigFile>(this.file)
    for (const [id, cfg] of Object.entries(raw?.suppliers ?? {})) {
      this.bySupplier.set(id, {
        enabled: typeof cfg.enabled === 'boolean' ? cfg.enabled : true,
        alias: typeof cfg.alias === 'string' ? cfg.alias : '',
        disabled: Array.isArray(cfg.disabled) ? cfg.disabled.filter((m) => typeof m === 'string') : [],
        custom: Array.isArray(cfg.custom) ? cfg.custom.filter((m) => typeof m === 'string') : [],
        poolOrder: Array.isArray(cfg.poolOrder) ? cfg.poolOrder.filter((u) => typeof u === 'string') : [],
        poolStrategy: cfg.poolStrategy === 'round-robin' ? 'round-robin' : 'fallback',
        credits: readCredits(cfg.credits),
      })
    }
  }

  get(id: string): SupplierConfig {
    let cfg = this.bySupplier.get(id)
    if (cfg === undefined) {
      cfg = DEFAULT_SUPPLIER_CONFIG()
      this.bySupplier.set(id, cfg)
    }
    return cfg
  }

  setAlias(id: string, alias: string): void {
    this.get(id).alias = (alias ?? '').trim()
    this.save()
  }

  /** 供应商开关（是否参与路由）。 */
  setEnabled(id: string, enabled: boolean): void {
    this.get(id).enabled = enabled
    this.save()
  }

  setPoolOrder(id: string, uids: string[]): void {
    this.get(id).poolOrder = [...new Set(uids)]
    this.save()
  }

  setPoolStrategy(id: string, strategy: string): void {
    this.get(id).poolStrategy = strategy === 'round-robin' ? 'round-robin' : 'fallback'
    this.save()
  }

  setModelEnabled(id: string, modelId: string, enabled: boolean): void {
    const cfg = this.get(id)
    cfg.disabled = enabled ? cfg.disabled.filter((m) => m !== modelId) : [...new Set([...cfg.disabled, modelId])]
    this.save()
  }

  setAllModelsEnabled(id: string, enabled: boolean, modelIds: string[]): void {
    const cfg = this.get(id)
    cfg.disabled = enabled ? [] : [...new Set(modelIds)]
    this.save()
  }

  addCustomModel(id: string, modelId: string): void {
    const cfg = this.get(id)
    const clean = modelId.trim()
    if (clean === '' || cfg.custom.includes(clean)) return
    cfg.custom.push(clean)
    this.save()
  }

  removeCustomModel(id: string, modelId: string): void {
    const cfg = this.get(id)
    cfg.custom = cfg.custom.filter((m) => m !== modelId)
    cfg.disabled = cfg.disabled.filter((m) => m !== modelId)
    this.save()
  }

  getCredits(id: string, uid: string): number {
    const v = this.get(id).credits[uid]
    return typeof v === 'number' && Number.isFinite(v) ? v : -1
  }

  putCredits(id: string, uid: string, reported: number): number {
    if (typeof reported !== 'number' || !Number.isFinite(reported) || reported < 0) return this.getCredits(id, uid)
    const prev = this.getCredits(id, uid)
    if (prev === reported) return reported
    this.get(id).credits[uid] = reported
    this.save()
    return reported
  }

  clearCredits(id: string, uid: string): void {
    const credits = this.get(id).credits
    if (credits[uid] === undefined) return
    delete credits[uid]
    this.save()
  }

  /** 已知供应商 id（别名唯一性校验用）。 */
  knownIds(): string[] {
    return [...this.bySupplier.keys()]
  }

  private save(): void {
    const file: SupplierConfigFile = { suppliers: {} }
    for (const [id, cfg] of this.bySupplier) file.suppliers[id] = { ...cfg, credits: { ...cfg.credits } }
    writeJson(this.file, file)
  }
}

function readCredits(raw: unknown): Record<string, number> {
  const out: Record<string, number> = {}
  if (typeof raw !== 'object' || raw === null) return out
  for (const [uid, v] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof v === 'number' && Number.isFinite(v) && v >= 0) out[uid] = v
  }
  return out
}

// ---------------------------------------------------------------------------
// 组合（fallback 链）
// ---------------------------------------------------------------------------

interface CombosFile {
  combos: Record<string, string[]>
}

/** 组合存储：名字 → 目标列表（形如 `codebuddy/glm-5.3`）。 */
export class CombosStore {
  private file: string
  private combos = new Map<string, string[]>()

  constructor(dataDir: string) {
    this.file = join(dataDir, 'combos.json')
    const raw = readJson<CombosFile>(this.file)
    for (const [name, targets] of Object.entries(raw?.combos ?? {})) {
      if (!Array.isArray(targets)) continue
      this.combos.set(name, targets.filter((t) => typeof t === 'string'))
    }
  }

  list(): Array<{ name: string; targets: string[] }> {
    return [...this.combos.entries()].map(([name, targets]) => ({ name, targets: [...targets] }))
  }

  get(name: string): string[] | undefined {
    return this.combos.get(name)
  }

  set(name: string, targets: string[]): void {
    const clean = name.trim()
    if (clean === '') return
    this.combos.set(clean, [...new Set(targets.map((t) => t.trim()).filter((t) => t !== ''))])
    this.save()
  }

  remove(name: string): boolean {
    const ok = this.combos.delete(name)
    if (ok) this.save()
    return ok
  }

  private save(): void {
    writeJson(this.file, { combos: Object.fromEntries(this.combos) })
  }
}

// ---------------------------------------------------------------------------
// 密钥 + 设置
// ---------------------------------------------------------------------------

export interface ApiKeyEntry {
  id: string
  name: string
  key: string
  isActive: boolean
  createdAt: string
}

interface KeysFile {
  keys: ApiKeyEntry[]
  requireApiKey: boolean
}

export class KeysStore {
  private file: string
  private keys: ApiKeyEntry[] = []
  private require = false

  constructor(dataDir: string) {
    this.file = join(dataDir, 'keys.json')
    const raw = readJson<KeysFile>(this.file)
    if (raw !== undefined) {
      this.keys = Array.isArray(raw.keys) ? raw.keys : []
      this.require = !!raw.requireApiKey
    }
  }

  list(): Array<ApiKeyEntry & { masked: string }> {
    return this.keys.map((k) => ({ ...k, masked: maskKey(k.key) }))
  }

  create(name: string): ApiKeyEntry {
    const entry: ApiKeyEntry = {
      id: randomBytes(6).toString('hex'),
      name: name.trim() !== '' ? name.trim() : `Key ${this.keys.length + 1}`,
      key: `ocber-${randomBytes(24).toString('hex')}`,
      isActive: true,
      createdAt: new Date().toISOString(),
    }
    this.keys.push(entry)
    this.save()
    return entry
  }

  remove(id: string): boolean {
    const before = this.keys.length
    this.keys = this.keys.filter((k) => k.id !== id)
    if (this.keys.length === before) return false
    this.save()
    return true
  }

  setActive(id: string, isActive: boolean): boolean {
    const k = this.keys.find((k) => k.id === id)
    if (k === undefined) return false
    k.isActive = isActive
    this.save()
    return true
  }

  get requireApiKey(): boolean {
    return this.require
  }

  set requireApiKey(v: boolean) {
    this.require = v
    this.save()
  }

  /** requireApiKey 关 → 放行；开 → Bearer 必须是库内启用的 key。 */
  verify(bearer: string | undefined): boolean {
    if (!this.require) return true
    if (bearer === undefined || bearer === '') return false
    return this.keys.some((k) => k.isActive && k.key === bearer)
  }

  /** 第一个启用的 key（同步 provider 配置时用）。 */
  firstActiveKey(): string | undefined {
    return this.keys.find((k) => k.isActive)?.key
  }

  private save(): void {
    writeJson(this.file, { keys: this.keys, requireApiKey: this.require })
  }
}

function maskKey(k: string): string {
  if (k.length <= 10) return k
  return `${k.slice(0, 6)}${'•'.repeat(Math.min(k.length - 10, 12))}${k.slice(-4)}`
}

// ---------------------------------------------------------------------------
// 端口设置
// ---------------------------------------------------------------------------

interface SettingsFile {
  requireApiKey?: boolean
  port?: number
  opencodeSync?: boolean
  opencodeSignature?: string
  opencodeSyncedAt?: number
}

export interface ServiceSettings {
  port: number
  /** 自动把 provider 配置写进 ~/.config/opencode/opencode.json（默认开）。 */
  opencodeSync: boolean
  /** 上次写入的内容指纹（没变就不重复写）。 */
  opencodeSignature: string
  opencodeSyncedAt: number
}

export const DEFAULT_PORT = 20128

export class SettingsStore {
  private file: string
  private port: number
  private opencodeSync: boolean
  private opencodeSignature: string
  private opencodeSyncedAt: number

  constructor(dataDir: string) {
    this.file = join(dataDir, 'settings.json')
    const raw = readJson<SettingsFile>(this.file)
    const p = Number(raw?.port)
    this.port = Number.isInteger(p) && p > 0 && p < 65536 ? p : DEFAULT_PORT
    this.opencodeSync = typeof raw?.opencodeSync === 'boolean' ? raw.opencodeSync : true
    this.opencodeSignature = typeof raw?.opencodeSignature === 'string' ? raw.opencodeSignature : ''
    this.opencodeSyncedAt = typeof raw?.opencodeSyncedAt === 'number' ? raw.opencodeSyncedAt : 0
  }

  get(): ServiceSettings {
    return {
      port: this.port,
      opencodeSync: this.opencodeSync,
      opencodeSignature: this.opencodeSignature,
      opencodeSyncedAt: this.opencodeSyncedAt,
    }
  }

  setPort(port: number): void {
    if (!Number.isInteger(port) || port <= 0 || port >= 65536) return
    this.port = port
    this.save()
  }

  setOpencodeSync(enabled: boolean): void {
    this.opencodeSync = enabled
    this.save()
  }

  /** 记录一次成功写入的指纹与时间。 */
  setOpencodeSyncState(signature: string, syncedAt: number): void {
    this.opencodeSignature = signature
    this.opencodeSyncedAt = syncedAt
    this.save()
  }

  private save(): void {
    writeJson(this.file, {
      port: this.port,
      opencodeSync: this.opencodeSync,
      opencodeSignature: this.opencodeSignature,
      opencodeSyncedAt: this.opencodeSyncedAt,
    })
  }
}
