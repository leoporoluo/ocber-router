/**
 * 面板与服务共享的类型（仅类型，编译期擦除）。
 * 数据形状是面板 ↔ 本地服务之间的手写 HTTP 契约，两侧必须一起改。
 */

/** 面板展示的账号状态（脱敏）。 */
export interface AccountView {
  uid: string
  nickname: string
  /** 剩余额度；-1 = 还没拿到过（不是 0）。 */
  credits: number
  cooling: boolean
  until?: string
  reason?: string
  err_count?: number
}

/** 供应商卡片状态。 */
export interface SupplierView {
  id: string
  name: string
  icon: string
  enabled: boolean
  alias: string
  pollLogin: boolean
  /** 当前模型数（启用/总数）。 */
  modelCount: number
  enabledModelCount: number
  /** 启用中的模型 id（面板用来生成 provider 配置片段）。 */
  models: string[]
  accounts: AccountView[]
}

/** 模型条目（含启用状态）。 */
export interface ModelView {
  id: string
  context_length?: number
  enabled: boolean
  custom: boolean
}

/** 供应商详情。 */
export interface SupplierDetailView {
  id: string
  name: string
  icon: string
  enabled: boolean
  alias: string
  pollLogin: boolean
  /** 模型来源：upstream = 从上游拉到；fallback = 用了内置兜底表。 */
  modelSource: 'upstream' | 'fallback'
  models: ModelView[]
  accounts: AccountView[]
  poolOrder: string[]
}

/** 一个组合。 */
export interface ComboView {
  name: string
  targets: string[]
}

/** 组合解析结果（无效目标在这里标出来，面板显示原因）。 */
export interface ComboResolved {
  name: string
  targets: Array<{ raw: string; supplier: string; model: string; ok: boolean }>
}

/** 密钥条目（列表返回脱敏）。 */
export interface KeyView {
  id: string
  name: string
  masked: string
  key: string
  isActive: boolean
  createdAt: string
}

/** 概览汇总。 */
export interface StatsSummary {
  requests: number
  ok: number
  failed: number
  promptTokens: number
  completionTokens: number
  cachedTokens: number
  avgDurationMs: number
  avgTtfbMs: number
  estimatedInputs: number
  estimatedOutputs: number
  lifetime: number
}

export interface RankRow {
  name: string
  requests: number
  ok: number
  failed: number
  promptTokens: number
  completionTokens: number
  lastTs: number
}

export interface StatsResult extends StatsSummary {
  bySupplier: RankRow[]
  byModel: RankRow[]
  byRequested: RankRow[]
}

export interface ChartBucket {
  label: string
  requests: number
  tokens: number
}

export interface UsageRecordView {
  ts: number
  supplier: string
  model: string
  requested: string
  ok: boolean
  promptTokens: number
  completionTokens: number
  cachedTokens: number
  durationMs: number
  ttfbMs: number
  uid?: string
  error?: string
}

export type Period = 'today' | '24h' | '7d' | '30d'

/** 设置。 */
export interface SettingsView {
  requireApiKey: boolean
  /** 期望监听端口（实际端口在 state.endpointPort；冲突时会自动顺延）。 */
  port: number
}

/** 面板启动时拉一次的全量状态。 */
export interface StateView {
  version: string
  startedAt: number
  dataDir: string
  /** 实际对外监听端口。 */
  endpointPort: number
  /** 对外 OpenAI 兼容端点。 */
  endpoint: string
  settings: SettingsView
  suppliers: SupplierView[]
  combos: ComboResolved[]
  keys: KeyView[]
  /** 服务侧当前时间，面板做轻量时钟校准。 */
  now: number
}

/** 异步任务（登录轮询 / 签到 / 拉模型）。 */
export type JobType = 'login' | 'checkin' | 'models'

export type JobState = 'running' | 'ok' | 'error'

export interface JobView {
  id: string
  type: JobType
  supplierId: string
  state: JobState
  /** 人类可读的进度/结果说明。 */
  message: string
  /** 登录任务：生成的登录链接（生成成功即给出）。 */
  loginUrl?: string
  startedAt: number
  finishedAt?: number
  /** 签到/拉模型的结构化结果。 */
  result?: unknown
}

/** 签到单账号结果。 */
export interface CheckinResult {
  uid: string
  nickname: string
  ok: boolean
  status: string
  message?: string
}

/** 面板错误提示用的错误载荷。 */
export interface ApiError {
  error: string
}
