/**
 * 服务端应用状态：供应商运行时、模型目录、配置、账号池、异步任务。
 *
 * 面板只通过 HTTP 与管理 API 交互；这里不碰 node:http，保持可单测。
 */
import { randomBytes } from 'node:crypto'

import type { AccountState, SupplierEnv, SupplierModule } from './suppliers/codebuddy/contract.ts'
import type { ModelInfo } from './suppliers/codebuddy/types.ts'
import { createSupplier } from './suppliers/codebuddy/core.ts'
import { profile as cnProfile } from './suppliers/codebuddy/cn.ts'
import { profile as enProfile } from './suppliers/codebuddy/en.ts'
import { AccountPool } from './account-pool.ts'
import { CredentialStore, SupplierConfigStore, CombosStore, KeysStore, SettingsStore, DEFAULT_PORT } from './store.ts'
import { UsageStore } from './usage.ts'
import { syncOpencode } from './opencode-sync.ts'
import { TpsTracker } from './tps.ts'
import type {
  AccountView,
  CheckinResult,
  ComboResolved,
  JobType,
  JobView,
  ModelView,
  OpencodeSyncView,
  SettingsView,
  StateView,
  SupplierDetailView,
  SupplierView,
} from '../shared/types.ts'

export const VERSION = '0.1.7'

export interface SupplierRuntime {
  module: SupplierModule
  pool: AccountPool
}

interface CatalogEntry {
  ids: string[]
  source: 'upstream' | 'fallback'
  at: number
}

const CATALOG_TTL_MS = 10 * 60 * 1000

export class App {
  readonly dataDir: string
  readonly creds: CredentialStore
  readonly config: SupplierConfigStore
  readonly combos: CombosStore
  readonly keys: KeysStore
  readonly settings: SettingsStore
  readonly usage: UsageStore
  /** TPS 仪表盘：订阅 OpenChamber 全局事件流算生成速率。 */
  readonly tps = new TpsTracker()
  readonly runtimes: SupplierRuntime[]
  readonly startedAt = Date.now()

  /** 对外监听端口（服务启动后回填）。 */
  endpointPort = 0

  private catalog = new Map<string, CatalogEntry>()
  private jobs = new Map<string, JobRecord>()
  private log: (msg: string) => void

  constructor(dataDir: string, log: (msg: string) => void = () => {}) {
    this.dataDir = dataDir
    this.log = log
    this.creds = new CredentialStore(dataDir)
    this.config = new SupplierConfigStore(dataDir)
    this.combos = new CombosStore(dataDir)
    this.keys = new KeysStore(dataDir)
    this.settings = new SettingsStore(dataDir)
    this.usage = new UsageStore(dataDir)

    const env: SupplierEnv = {
      dataDir,
      log,
      store: this.config,
      credentials: this.creds,
    }

    this.runtimes = [
      { module: createSupplier(cnProfile)(env), pool: new AccountPool(cnProfile.id) },
      { module: createSupplier(enProfile)(env), pool: new AccountPool(enProfile.id) },
    ]
    this.config.get(cnProfile.id)
    this.config.get(enProfile.id)
  }

  runtimeById(id: string): SupplierRuntime | undefined {
    return this.runtimes.find((r) => r.module.id === id)
  }

  /** 供应商别名（未设置 = id）。 */
  aliasOf(id: string): string {
    return this.config.get(id).alias || id
  }

  supplierByAlias(alias: string): string | undefined {
    for (const r of this.runtimes) if (this.aliasOf(r.module.id) === alias) return r.module.id
    return undefined
  }

  /** 参与路由的供应商（用户开关为开）。 */
  activeRuntimes(): SupplierRuntime[] {
    return this.runtimes.filter((r) => this.config.get(r.module.id).enabled)
  }

  // -------------------------------------------------------------------------
  // 模型目录
  // -------------------------------------------------------------------------

  /** 拉取（或读缓存）某供应商的模型列表。force=true 打上游。 */
  async refreshCatalog(id: string, force: boolean): Promise<CatalogEntry | undefined> {
    const runtime = this.runtimeById(id)
    if (runtime === undefined) return undefined
    const cached = this.catalog.get(id)
    if (!force && cached !== undefined && Date.now() - cached.at < CATALOG_TTL_MS) return cached
    let models: ModelInfo[] = []
    try {
      models = await runtime.module.listModels(force)
    } catch {
      models = []
    }
    const ids = models.map((m) => m.id).filter((x) => typeof x === 'string' && x !== '')
    const entry: CatalogEntry = { ids, source: cached !== undefined && ids.length === 0 ? cached.source : 'upstream', at: Date.now() }
    if (ids.length === 0 && cached !== undefined) return cached
    if (ids.length === 0) entry.source = 'fallback'
    this.catalog.set(id, entry)
    return entry
  }

  /** 后台预热：不阻塞启动，失败静默。 */
  warmupCatalog(): void {
    for (const r of this.runtimes) {
      void this.refreshCatalog(r.module.id, false)
        .then(() => this.syncOpencode(false))
        .catch(() => {})
    }
  }

  catalogEntry(id: string): CatalogEntry | undefined {
    return this.catalog.get(id)
  }

  /** 某供应商是否有账号（没账号的供应商不参与路由 / 模型列表 / provider 同步）。 */
  supplierHasAccounts(id: string): boolean {
    const runtime = this.runtimeById(id)
    return runtime !== undefined && runtime.module.status().accounts.length > 0
  }

  /** 某供应商启用的模型 id（目录 ∪ 自定义 − 停用）；无账号的供应商一律为空。 */
  enabledModelIds(id: string): string[] {
    if (!this.supplierHasAccounts(id)) return []
    const cfg = this.config.get(id)
    const all = new Set<string>(this.catalog.get(id)?.ids ?? [])
    for (const m of cfg.custom) all.add(m)
    return [...all].filter((m) => !cfg.disabled.includes(m))
  }

  /** 面板用：带启用/自定义标记的完整模型表（没账号时一律显示为停用）。 */
  modelViews(id: string): ModelView[] {
    const cfg = this.config.get(id)
    const hasAccounts = this.supplierHasAccounts(id)
    const all = new Set<string>(this.catalog.get(id)?.ids ?? [])
    for (const m of cfg.custom) all.add(m)
    return [...all].map((m) => ({ id: m, enabled: hasAccounts && !cfg.disabled.includes(m), custom: cfg.custom.includes(m) }))
  }

  // -------------------------------------------------------------------------
  // 账号视图
  // -------------------------------------------------------------------------

  accountViews(id: string): AccountView[] {
    const runtime = this.runtimeById(id)
    if (runtime === undefined) return []
    const now = runtime.module.status()
    const decorated = runtime.pool.decorate(now.accounts)
    return decorated.map((a) => ({
      uid: a.uid,
      nickname: a.nickname ?? id,
      credits: this.config.putCredits(id, a.uid, a.credits),
      cooling: a.cooling,
      until: a.until,
      reason: a.reason,
      err_count: a.err_count,
    }))
  }

  supplierViews(): SupplierView[] {
    return this.runtimes.map((r) => {
      const id = r.module.id
      const models = this.modelViews(id)
      return {
        id,
        name: r.module.name,
        icon: r.module.icon ?? '',
        enabled: this.config.get(id).enabled,
        alias: this.aliasOf(id),
        pollLogin: r.module.pollLogin?.() ?? false,
        modelCount: models.length,
        enabledModelCount: models.filter((m) => m.enabled).length,
        models: models.filter((m) => m.enabled).map((m) => m.id),
        accounts: this.accountViews(id),
      }
    })
  }

  supplierDetail(id: string): SupplierDetailView | undefined {
    const runtime = this.runtimeById(id)
    if (runtime === undefined) return undefined
    const catalog = this.catalog.get(id)
    return {
      id,
      name: runtime.module.name,
      icon: runtime.module.icon ?? '',
      enabled: this.config.get(id).enabled,
      alias: this.aliasOf(id),
      pollLogin: runtime.module.pollLogin?.() ?? false,
      modelSource: catalog?.source === 'upstream' ? 'upstream' : 'fallback',
      models: this.modelViews(id),
      accounts: this.accountViews(id),
      poolOrder: this.config.get(id).poolOrder,
    }
  }

  // -------------------------------------------------------------------------
  // 组合
  // -------------------------------------------------------------------------

  resolveCombo(name: string): ComboResolved | undefined {
    const targets = this.combos.get(name)
    if (targets === undefined) return undefined
    return {
      name,
      targets: targets.map((raw) => {
        const slash = raw.indexOf('/')
        if (slash > 0) {
          const supplier = this.supplierByAlias(raw.slice(0, slash))
          if (supplier === undefined) return { raw, supplier: raw.slice(0, slash), model: raw.slice(slash + 1), ok: false }
          return { raw, supplier, model: raw.slice(slash + 1), ok: true }
        }
        // 裸模型名：按启用的模型目录找归属供应商（首个命中即视为有效），
        // 这样用户写 `deepseek-v4.1-flash` 也能直接用，不必记别名前缀。
        const owners = this.activeRuntimes().filter((r) => this.enabledModelIds(r.module.id).includes(raw))
        if (owners.length > 0) return { raw, supplier: owners[0]!.module.id, model: raw, ok: true }
        return { raw, supplier: '', model: '', ok: false }
      }),
    }
  }

  comboViews(): ComboResolved[] {
    return this.combos.list().map((c) => this.resolveCombo(c.name)).filter((c): c is ComboResolved => c !== undefined)
  }

  /** 请求 model → 尝试的 (供应商, 模型) 目标链。 */
  resolveTargets(requested: string): Array<{ supplierId: string; model: string }> {
    const combo = this.resolveCombo(requested)
    if (combo !== undefined) {
      const targets = combo.targets
        .filter((t) => t.ok && this.config.get(t.supplier).enabled)
        .map((t) => ({ supplierId: t.supplier, model: t.model }))
      if (targets.length > 0) return targets
    }

    const slash = requested.indexOf('/')
    if (slash > 0) {
      const supplier = this.supplierByAlias(requested.slice(0, slash))
      if (supplier !== undefined && this.config.get(supplier).enabled) {
        return [{ supplierId: supplier, model: requested.slice(slash + 1) }]
      }
    }

    const active = this.activeRuntimes()
    const matched = active.filter((r) => this.enabledModelIds(r.module.id).includes(requested))
    if (matched.length > 0) return matched.map((r) => ({ supplierId: r.module.id, model: requested }))
    // 目录已有内容但没人认领这个模型名 → 明确的「未知模型」（404），
    // 而不是把请求丢给所有供应商各撞一次变成 503。目录还空（刚启动、上游未回）
    // 时才放行，避免冷启动把合法模型误判成未知。
    const known = active.some((r) => (this.catalog.get(r.module.id)?.ids.length ?? 0) > 0)
    if (known) return []
    return active.map((r) => ({ supplierId: r.module.id, model: requested }))
  }

  // -------------------------------------------------------------------------
  // 异步任务
  // -------------------------------------------------------------------------

  job(id: string): JobView | undefined {
    return this.jobs.get(id)
  }

  /**
   * 启动一个后台任务（登录轮询 / 签到 / 拉模型）。面板拿 jobId 轮询，避免
   * 撞上宿主 20s 的 serviceRequest 超时。
   */
  startJob(type: JobType, supplierId: string): JobView {
    const id = randomBytes(8).toString('hex')
    const job: JobRecord = {
      id,
      type,
      supplierId,
      state: 'running',
      message: '进行中',
      startedAt: Date.now(),
    }
    this.jobs.set(id, job)
    this.pruneJobs()
    if (type === 'login') void this.runLoginJob(job)
    else if (type === 'checkin') void this.runCheckinJob(job)
    else void this.runModelsJob(job)
    return { ...job }
  }

  private finish(job: JobRecord, state: 'ok' | 'error', message: string, result?: unknown): void {
    job.state = state
    job.message = message
    job.result = result
    job.finishedAt = Date.now()
  }

  private async runLoginJob(job: JobRecord): Promise<void> {
    const runtime = this.runtimeById(job.supplierId)
    if (runtime === undefined || runtime.module.generateLoginUrl === undefined) {
      this.finish(job, 'error', '该供应商不支持登录')
      return
    }
    try {
      const r = await runtime.module.generateLoginUrl()
      if (typeof r === 'string') {
        job.loginUrl = r
        job.message = '请在浏览器完成登录'
      } else if (r.ok && r.loginUrl !== undefined) {
        job.loginUrl = r.loginUrl
        job.message = '请在浏览器完成登录'
      } else {
        this.finish(job, 'error', r.error ?? '生成登录链接失败')
        return
      }
      if (runtime.module.pollLogin?.() === true && runtime.module.completeLogin !== undefined) {
        const account = await runtime.module.completeLogin('')
        this.finish(job, 'ok', `已添加 ${account.nickname}（${account.uid}）`, account)
        return
      }
      this.finish(job, 'ok', '登录链接已生成')
    } catch (err) {
      this.finish(job, 'error', (err as Error).message)
    }
  }

  private async runCheckinJob(job: JobRecord): Promise<void> {
    const runtime = this.runtimeById(job.supplierId)
    if (runtime === undefined || runtime.module.checkinNow === undefined) {
      this.finish(job, 'error', '该供应商不支持签到')
      return
    }
    const accounts = runtime.module.status().accounts
    if (accounts.length === 0) {
      this.finish(job, 'error', '还没有账号，先添加链接')
      return
    }
    const results: CheckinResult[] = []
    for (const a of accounts) {
      try {
        const r = await runtime.module.checkinNow(a.uid)
        results.push({ uid: a.uid, nickname: a.nickname ?? job.supplierId, ok: r.ok, status: r.status, message: r.message })
      } catch (err) {
        results.push({ uid: a.uid, nickname: a.nickname ?? job.supplierId, ok: false, status: 'error', message: (err as Error).message })
      }
    }
    const okCount = results.filter((r) => r.ok).length
    this.finish(job, 'ok', `签到完成：${okCount}/${results.length} 成功`, results)
  }

  private async runModelsJob(job: JobRecord): Promise<void> {
    try {
      const entry = await this.refreshCatalog(job.supplierId, true)
      const count = entry?.ids.length ?? 0
      this.finish(job, 'ok', count > 0 ? `拉到 ${count} 个模型` : '上游不可达，已保留当前列表', { count })
    } catch (err) {
      this.finish(job, 'error', (err as Error).message)
    }
  }

  private pruneJobs(): void {
    const cutoff = Date.now() - 10 * 60 * 1000
    for (const [id, job] of this.jobs) {
      if (job.state !== 'running' && (job.finishedAt ?? 0) < cutoff) this.jobs.delete(id)
    }
    if (this.jobs.size > 64) {
      for (const [id, job] of [...this.jobs].slice(0, this.jobs.size - 64)) {
        if (job.state !== 'running') this.jobs.delete(id)
      }
    }
  }

  // -------------------------------------------------------------------------
  // 面板状态
  // -------------------------------------------------------------------------

  /** 对外 OpenAI 兼容端点。 */
  endpoint(): string {
    return `http://127.0.0.1:${this.endpointPort || this.settings.get().port || DEFAULT_PORT}/v1`
  }

  /** 同步 provider 配置（写 opencode.json）。force=true 无视开关与指纹。 */
  syncOpencode(force = false): OpencodeSyncView {
    return syncOpencode(this, force)
  }

  /** 变更后顺手同步（失败不影响主流程）。 */
  private syncQuietly(): void {
    try {
      this.syncOpencode(false)
    } catch {
      // 同步失败由面板的下一次 state 显示
    }
  }

  /** 模型/组合/别名/开关变化后调用。 */
  afterCatalogChange(): void {
    this.syncOpencode(false)
  }

  settingsView(): SettingsView {
    return {
      requireApiKey: this.keys.requireApiKey,
      port: this.settings.get().port || this.endpointPort || DEFAULT_PORT,
      opencodeSync: this.settings.get().opencodeSync,
    }
  }

  state(): StateView {
    const opencode = this.syncOpencode(false)
    return {
      version: VERSION,
      startedAt: this.startedAt,
      dataDir: this.dataDir,
      endpointPort: this.endpointPort,
      endpoint: this.endpoint(),
      settings: this.settingsView(),
      suppliers: this.supplierViews(),
      combos: this.comboViews(),
      keys: this.keys.list(),
      opencode,
      now: Date.now(),
    }
  }

  dispose(): void {
    this.tps.dispose()
    for (const r of this.runtimes) {
      try {
        r.module.dispose()
      } catch {
        // 忽略
      }
    }
    this.usage.flush()
  }
}

type JobRecord = JobView
