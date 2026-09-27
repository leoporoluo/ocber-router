/**
 * OCBer Router —— 扩展面板。
 *
 * 面板只做两件事：向本地服务要数据、把数据画成 OpenChamber 原生样子的界面。
 * 所有上游访问都在服务进程里（面板是沙箱 iframe，不直连网络），面板通过
 * `host.serviceRequest` 走宿主代理。
 *
 * 长操作（登录轮询 / 签到 / 拉模型）一律「启动任务 + 轮询」，避开宿主 20s
 * 的 RPC 超时。
 */
import { connectHost, HostRequestError } from '@openchamber/sdk'
import {
  applyHostReady,
  mountBanner,
  mountBadge,
  mountButton,
  mountSearchField,
  mountSpinner,
  mountSwitch,
  mountTabs,
  mountTextField,
} from '@openchamber/sdk/ui'

import type {
  ChartBucket,
  ComboResolved,
  JobType,
  JobView,
  ModelView,
  Period,
  StateView,
  StatsResult,
  SupplierDetailView,
  SupplierView,
  TpsSnapshot,
  UsageRecordView,
} from '../src/shared/types.ts'

// ---------------------------------------------------------------------------
// 文案（中文优先；en 环境回落英文）
// ---------------------------------------------------------------------------

const COPY = {
  zh: {
    title: 'OCBer Router',
    subtitle: 'OpenAI 兼容路由',
    tabOverview: '概览',
    tabSuppliers: '供应商',
    tabCombos: '组合',
    tabEndpoint: '端点与密钥',
    refresh: '刷新',
    loading: '加载中',
    serviceHint: '本地服务未就绪。请在「设置 → 扩展」里授权 OCBer Router 的本地服务，然后重新打开面板。',
    disabled: '该扩展已在「设置 → 扩展」中暂停。',
    timeout: '服务无响应（超时）。',
    noData: '暂无数据',
    endpoint: '对外端点',
    copy: '复制',
    copied: '已复制',
    port: '监听端口',
    save: '保存',
    saved: '已保存',
    requireKey: '要求 API Key',
    requireKeyHint: '开启后，/v1/* 请求必须带 Authorization: Bearer <库内启用的 Key>',
    keys: 'API Keys',
    keyName: '名称',
    createKey: '创建 Key',
    keyCreated: '已创建 Key（仅显示一次）',
    delete: '删除',
    enabled: '启用',
    accounts: '账号',
    addLink: '添加链接',
    checkin: '一键签到',
    fetchModels: '获取模型',
    enableAll: '全部启用',
    disableAll: '全部停用',
    models: '可用模型',
    addModel: '添加自定义模型',
    modelId: '模型 ID',
    add: '添加',
    back: '返回',
    alias: '别名前缀',
    aliasHint: '外部请求可用「别名/模型」精确指定本供应商',
    noAccounts: '还没有账号，点「添加链接」用浏览器登录。',
    noModels: '还没有模型，点「获取模型」从上游拉取。',
    credits: '积分',
    unknownCredits: '未知',
    cooling: '冷却中',
    errorCount: '错误计数',
    poolOrder: '账号（点击顺序即池顺序）',
    overviewRequests: '总请求',
    overviewSuccess: '成功率',
    overviewPrompt: '输入 Tokens',
    overviewCompletion: '输出 Tokens',
    overviewCached: '缓存 Tokens',
    overviewAvg: '平均耗时',
    periodToday: '今日',
    period24h: '24 小时',
    period7d: '7 天',
    period30d: '30 天',
    clearStats: '清空统计',
    combosTitle: '组合（fallback 链）',
    comboName: '组合名',
    comboTargets: '模型（按顺序回退）',
    comboSave: '保存组合',
    comboHint: '从「添加模型」里挑（优先用启用的模型，写成 别名/模型 全名）；按顺序回退，第一个失败用第二个。',
    comboSelected: '已选模型',
    comboPick: '添加模型',
    comboPickSearch: '搜索模型…',
    comboPickEmpty: '没有可选模型：先在「供应商」里添加账号、拉取并启用模型。',
    comboEmptySelection: '还没选模型，从下面挑。',
    noCombos: '还没有组合。',
    invalidTarget: '无效目标',
    jobLogin: '登录',
    jobCheckin: '签到',
    jobModels: '获取模型',
    jobRunning: '进行中',
    supplierEnabled: '参与路由',
    modelEnabled: '启用',
    custom: '自定义',
    upstream: '上游',
    fallback: '内置兜底',
    sourceLabel: '模型来源',
    portHint: '默认 3080，被占用会自动顺延；修改后立即生效。',
    badPort: '端口非法',
    accountCount: '账号',
    failed: '失败',
    requestWord: '请求',
    modelWord: '模型',
    opencodeTitle: 'OpenCode 同步',
    opencodeSync: '自动写入 provider 配置',
    opencodeSyncHint: '把本端点写成 opencode.json 里的 providers.ocber（只改这一个键，其余内容原样保留）。同步后重启 OpenCode（或重新加载模型）即可在模型选择里看到模型与组合。',
    syncNow: '立即同步',
    syncAt: '上次同步',
    syncNever: '从未',
    syncModels: '模型数',
    syncFailed: '同步失败',
    noAccountsModels: '未添加账号：模型暂不参与路由与同步，添加链接后自动恢复。',
    noAccountsShort: '未添加账号',
    edit: '编辑',
    editCancel: '取消编辑',
    editingCombo: '正在编辑',
    tpsTitle: 'TPS 仪表盘',
    tpsUnit: 'tok/s',
    tpsWindow: '近 5 秒滚动',
    tpsGenerating: '生成中',
    tpsIdle: '空闲',
    tpsConnecting: '连接中',
    tpsReconnecting: '重连中',
    tpsAsleep: '未连接',
    tpsWaitingPermission: '等待授权',
    tpsWaitingAnswer: '等待回答',
    tpsLastTurn: '上一轮平均速率',
    tpsLastTurnEmpty: '暂无已完成的轮次。',
    tpsLastTurnPending: '测量中',
    tpsEstimated: '估算',
    tpsActive: '生成',
    tpsPaused: '暂停',
  },
  en: {
    title: 'OCBer Router',
    subtitle: 'OpenAI-compatible router',
    tabOverview: 'Overview',
    tabSuppliers: 'Suppliers',
    tabCombos: 'Combos',
    tabEndpoint: 'Endpoint & keys',
    refresh: 'Refresh',
    loading: 'Loading',
    serviceHint: 'Local service is not ready. Approve the OCBer Router local service in Settings → Extensions, then reopen the panel.',
    disabled: 'The extension is paused in Settings → Extensions.',
    timeout: 'The service did not answer (timeout).',
    noData: 'No data',
    endpoint: 'Endpoint',
    copy: 'Copy',
    copied: 'Copied',
    port: 'Port',
    save: 'Save',
    saved: 'Saved',
    requireKey: 'Require API key',
    requireKeyHint: 'When on, /v1/* requests must send Authorization: Bearer <an active key>.',
    keys: 'API keys',
    keyName: 'Name',
    createKey: 'Create key',
    keyCreated: 'Key created (shown once)',
    delete: 'Delete',
    enabled: 'Enabled',
    accounts: 'Accounts',
    addLink: 'Add link',
    checkin: 'Check in',
    fetchModels: 'Fetch models',
    enableAll: 'Enable all',
    disableAll: 'Disable all',
    models: 'Models',
    addModel: 'Add custom model',
    modelId: 'Model ID',
    add: 'Add',
    back: 'Back',
    alias: 'Alias prefix',
    aliasHint: 'Clients can target this supplier as alias/model',
    noAccounts: 'No account yet. Use “Add link” to sign in with a browser.',
    noModels: 'No model yet. Use “Fetch models”.',
    credits: 'Credits',
    unknownCredits: 'unknown',
    cooling: 'cooling',
    errorCount: 'errors',
    poolOrder: 'Accounts (order = pool order)',
    overviewRequests: 'Requests',
    overviewSuccess: 'Success',
    overviewPrompt: 'Input tokens',
    overviewCompletion: 'Output tokens',
    overviewCached: 'Cached tokens',
    overviewAvg: 'Avg latency',
    periodToday: 'Today',
    period24h: '24h',
    period7d: '7d',
    period30d: '30d',
    clearStats: 'Clear stats',
    combosTitle: 'Combos (fallback chain)',
    comboName: 'Combo name',
    comboTargets: 'Models (fail over in order)',
    comboSave: 'Save combo',
    comboHint: 'Pick from “Add model” (enabled models, written as alias/model). Targets fail over in order.',
    comboSelected: 'Selected models',
    comboPick: 'Add model',
    comboPickSearch: 'Search models…',
    comboPickEmpty: 'No model available: add an account and enable models under Suppliers first.',
    comboEmptySelection: 'Nothing selected yet — pick from the list below.',
    noCombos: 'No combo yet.',
    invalidTarget: 'invalid target',
    jobLogin: 'Login',
    jobCheckin: 'Check-in',
    jobModels: 'Fetch models',
    jobRunning: 'running',
    supplierEnabled: 'In routing',
    modelEnabled: 'Enabled',
    custom: 'custom',
    upstream: 'upstream',
    fallback: 'built-in fallback',
    sourceLabel: 'Model source',
    portHint: 'Default 3080; taken ports fall forward. Applies immediately.',
    badPort: 'Invalid port',
    accountCount: 'accounts',
    failed: 'failed',
    requestWord: 'requests',
    modelWord: 'models',
    opencodeTitle: 'OpenCode sync',
    opencodeSync: 'Write provider config automatically',
    opencodeSyncHint: 'Writes this endpoint as providers.ocber in opencode.json (that key only; everything else stays as is). Restart OpenCode (or reload models) to see the models and combos in the picker.',
    syncNow: 'Sync now',
    syncAt: 'Last sync',
    syncNever: 'never',
    syncModels: 'Models',
    syncFailed: 'Sync failed',
    noAccountsModels: 'No account yet: these models stay out of routing and sync until a link is added.',
    noAccountsShort: 'no account',
    edit: 'Edit',
    editCancel: 'Cancel edit',
    editingCombo: 'Editing',
    tpsTitle: 'TPS Meter',
    tpsUnit: 'tok/s',
    tpsWindow: 'rolling 5 s',
    tpsGenerating: 'generating',
    tpsIdle: 'idle',
    tpsConnecting: 'connecting',
    tpsReconnecting: 'reconnecting',
    tpsAsleep: 'not connected',
    tpsWaitingPermission: 'waiting for permission',
    tpsWaitingAnswer: 'waiting for answer',
    tpsLastTurn: 'Last turn average',
    tpsLastTurnEmpty: 'No finished turn yet.',
    tpsLastTurnPending: 'measuring',
    tpsEstimated: 'estimated',
    tpsActive: 'generating',
    tpsPaused: 'paused',
  },
} as const

type Copy = Record<keyof (typeof COPY)['zh'], string>

function resolveCopy(locale: string): Copy {
  // 中文优先：面板默认中文（英文文案保留在 COPY.en，后续可加切换项）。
  void locale
  return COPY.zh
}

// ---------------------------------------------------------------------------
// 基础工具
// ---------------------------------------------------------------------------

const host = connectHost()
const rootNode = document.querySelector('#root')
if (rootNode === null) throw new Error('缺少 #root')

let copy: Copy = COPY.zh
let state: StateView | null = null
let tab = 'overview'
let detailId: string | null = null
let detail: SupplierDetailView | null = null
let period: Period = 'today'
let stats: StatsResult | null = null
let recent: UsageRecordView[] = []
let chart: ChartBucket[] = []
let mounted = false
let refreshing = false
let stopped = false
let jobActive = false
let noticeTimer: number | null = null

/** TPS 仪表盘状态。 */
let tps: TpsSnapshot | null = null
let watchedKey = ''
let currentSession: { id: string; title: string } | null = null
let peakTps = 0
let tpsRefs: {
  value: HTMLElement
  badge: ReturnType<typeof mountBadge>
  fill: HTMLElement
  lastTurnValue: HTMLElement
  lastTurnMeta: HTMLElement
} | null = null

let noticeRoot: HTMLElement
let headRoot: HTMLElement
let tabsRoot: HTMLElement
let viewRoot: HTMLElement
let banner: ReturnType<typeof mountBanner> | null = null
let tabs: ReturnType<typeof mountTabs> | null = null

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag)
  if (className !== undefined) node.className = className
  if (text !== undefined) node.textContent = text
  return node
}

function clear(node: Element): void {
  while (node.firstChild !== null) node.removeChild(node.firstChild)
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function describeError(error: unknown): string {
  if (error instanceof HostRequestError) {
    if (error.code === 'NO_SERVICE' || error.code === 'SERVICE_FAILED') return copy.serviceHint
    if (error.code === 'DISABLED') return copy.disabled
    if (error.code === 'HOST_TIMEOUT') return copy.timeout
    return `${error.code}: ${error.message}`
  }
  return error instanceof Error ? error.message : String(error)
}

function notify(message: string | null, tone: 'info' | 'success' | 'warning' | 'error' = 'info'): void {
  if (noticeTimer !== null) {
    window.clearTimeout(noticeTimer)
    noticeTimer = null
  }
  if (message === null || message === '') {
    banner?.dispose()
    banner = null
    return
  }
  if (banner !== null) {
    banner.update({ tone, title: message })
  } else {
    banner = mountBanner(noticeRoot, { tone, title: message })
  }
  // 提示自动消失：成功/进行中短一点，错误留久一点；有新的提示会重置计时。
  const ttl = tone === 'error' ? 12_000 : tone === 'success' ? 5_000 : 6_000
  noticeTimer = window.setTimeout(() => {
    noticeTimer = null
    banner?.dispose()
    banner = null
  }, ttl)
}

async function api<T = unknown>(method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', path: string, body?: unknown): Promise<T> {
  const result = await host.serviceRequest({
    method,
    path,
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = result.body ?? ''
  let parsed: unknown
  try {
    parsed = text === '' ? undefined : JSON.parse(text)
  } catch {
    parsed = undefined
  }
  if (result.status >= 400) {
    const obj = parsed as { error?: unknown } | undefined
    const e = obj?.error
    const message =
      typeof e === 'string' ? e : e !== null && typeof e === 'object' && typeof (e as { message?: unknown }).message === 'string'
        ? String((e as { message: unknown }).message)
        : `HTTP ${result.status}`
    throw new Error(message)
  }
  return parsed as T
}

function fmtInt(n: number): string {
  return Math.round(n).toLocaleString()
}

function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`
  return fmtInt(n)
}

function fmtMs(n: number): string {
  if (n <= 0) return '—'
  return n >= 1000 ? `${(n / 1000).toFixed(2)}s` : `${Math.round(n)}ms`
}

/** 积分：小于 1000 保留两位小数（签到/消耗的细微变化要看得见）。 */
function fmtCredits(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(2)}K`
  return Number.isInteger(n) ? String(n) : n.toFixed(2)
}

// ---------------------------------------------------------------------------
// 数据加载
// ---------------------------------------------------------------------------

async function refreshState(): Promise<void> {
  state = await api<StateView>('GET', '/api/state')
  renderTabs()
}

async function loadStats(): Promise<void> {
  const data = await api<{ stats: StatsResult; recent: UsageRecordView[] }>('GET', `/api/stats?period=${period}`)
  stats = data.stats
  recent = data.recent
  const chartData = await api<{ buckets: ChartBucket[] }>('GET', `/api/stats/chart?period=${period}`)
  chart = chartData.buckets
}

async function loadDetail(id: string): Promise<void> {
  detail = await api<SupplierDetailView>('GET', `/api/suppliers/${encodeURIComponent(id)}`)
}

async function reload(): Promise<void> {
  if (refreshing) return
  refreshing = true
  renderHead()
  try {
    await refreshState()
    if (tab === 'overview') await loadStats()
    if (detailId !== null) await loadDetail(detailId)
  } catch (error) {
    notify(describeError(error), 'error')
  } finally {
    refreshing = false
  }
  renderHead()
  renderTabs()
  renderBody()
}

// ---------------------------------------------------------------------------
// 异步任务（登录 / 签到 / 拉模型）
// ---------------------------------------------------------------------------

function jobLabel(type: JobType): string {
  if (type === 'login') return copy.jobLogin
  if (type === 'checkin') return copy.jobCheckin
  return copy.jobModels
}

async function runJob(type: JobType, supplierId: string): Promise<void> {
  let job: JobView
  try {
    job = await api<JobView>('POST', '/api/jobs', { type, supplierId })
  } catch (error) {
    notify(describeError(error), 'error')
    return
  }
  jobActive = true
  notify(`${jobLabel(type)}：${copy.jobRunning}`, 'info')
  let openedUrl = false
  try {
    for (let i = 0; i < 220; i += 1) {
      await sleep(1500)
      let current: JobView
      try {
        current = await api<JobView>('GET', `/api/jobs/${job.id}`)
      } catch (error) {
        notify(describeError(error), 'error')
        return
      }
      if (!openedUrl && current.loginUrl !== undefined && current.loginUrl !== '') {
        openedUrl = true
        try {
          await host.openUrl(current.loginUrl)
        } catch {
          notify(`请手动打开登录链接：${current.loginUrl}`, 'warning')
        }
      }
      if (current.state === 'running') {
        notify(`${jobLabel(type)}：${current.message}`, 'info')
        continue
      }
      notify(`${jobLabel(type)}：${current.message}`, current.state === 'error' ? 'error' : 'success')
      await reload()
      // 签到/登录后积分是服务后台异步拉的，稍后再拉一次状态把新值带出来
      await sleep(1500)
      await reload()
      return
    }
    notify(`${jobLabel(type)}：${copy.timeout}`, 'error')
  } finally {
    jobActive = false
  }
}

// ---------------------------------------------------------------------------
// 通用组件
// ---------------------------------------------------------------------------

function card(children: Array<HTMLElement | null>): HTMLElement {
  const node = el('section', 'oc-card')
  for (const child of children) if (child !== null) node.append(child)
  return node
}

function cardWithTitle(title: string, extra: HTMLElement | null, children: Array<HTMLElement | null>): HTMLElement {
  const head = el('div', 'oc-card-head')
  head.append(el('h2', 'oc-card-title', title))
  if (extra !== null) head.append(extra)
  return card([head, ...children])
}

function statCard(label: string, value: string, sub?: string): HTMLElement {
  const node = el('div', 'oc-stat')
  node.append(el('div', 'oc-stat-value', value), el('div', 'oc-stat-label', label))
  if (sub !== undefined) node.append(el('div', 'oc-stat-sub', sub))
  return node
}

function empty(text: string): HTMLElement {
  return el('div', 'oc-empty', text)
}

/** 面板自己的 origin（沙箱 iframe 里可能是 about:srcdoc，取不到就返回 null）。 */
function panelOrigin(): string | null {
  try {
    const url = new URL(window.location.href)
    if (url.protocol === 'http:' || url.protocol === 'https:') return url.origin
  } catch {
    // about:srcdoc 或 opaque origin
  }
  return null
}

function chartView(): HTMLElement {
  const wrap = el('div')
  const max = Math.max(1, ...chart.map((b) => b.requests))
  const bars = el('div', 'oc-chart')
  for (const bucket of chart) {
    const bar = el('div', 'oc-bar')
    bar.style.height = `${Math.max(bucket.requests > 0 ? 4 : 0, Math.round((bucket.requests / max) * 100))}%`
    bar.title = `${bucket.label} · ${bucket.requests} ${copy.requestWord} · ${fmtTokens(bucket.tokens)} tokens`
    bars.append(bar)
  }
  const axis = el('div', 'oc-chart-axis')
  axis.append(el('span', undefined, chart[0]?.label ?? ''), el('span', undefined, chart[chart.length - 1]?.label ?? ''))
  wrap.append(bars, axis)
  return wrap
}

// ---------------------------------------------------------------------------
// TPS 仪表盘（服务订阅 OpenChamber 事件流算出，面板只轮询快照）
// ---------------------------------------------------------------------------

/** 建一次卡并把元素句柄存起来，之后就地更新（500ms 一次，不能整页重画）。 */
function buildTpsCard(): HTMLElement {
  const card = el('section', 'oc-card')
  const head = el('div', 'oc-card-head')
  head.append(el('h2', 'oc-card-title', copy.tpsTitle))
  const badgeSlot = el('span')
  head.append(badgeSlot)

  const valueRow = el('div', 'oc-tps-readout')
  const value = el('span', 'oc-tps-value', '0.0')
  const unit = el('span', 'oc-tps-unit', copy.tpsUnit)
  valueRow.append(value, unit)
  const windowLine = el('div', 'oc-item-sub', copy.tpsWindow)
  const bar = el('div', 'oc-tps-bar')
  const fill = el('div', 'oc-tps-bar-fill')
  bar.append(fill)

  const lastTurnWrap = el('div', 'oc-item')
  lastTurnWrap.append(el('div', 'oc-item-sub', copy.tpsLastTurn))
  const lastTurnValue = el('div', 'oc-item-title', '—')
  const lastTurnMeta = el('div', 'oc-item-sub', '')
  lastTurnWrap.append(lastTurnValue, lastTurnMeta)

  card.append(head, valueRow, windowLine, bar, lastTurnWrap)
  tpsRefs = {
    value,
    badge: mountBadge(badgeSlot, { label: copy.tpsConnecting, tone: 'neutral' }),
    fill,
    lastTurnValue,
    lastTurnMeta,
  }
  return card
}

/** 把快照画进已建好的卡（缺 refs 时忽略）。 */
function renderTps(): void {
  const refs = tpsRefs
  if (refs === null) return
  const snap = tps
  const origin = panelOrigin()

  if (origin === null) {
    refs.badge.update({ label: copy.tpsAsleep, tone: 'neutral' })
    return
  }

  const value = snap !== null && Number.isFinite(snap.tokensPerSecond) ? snap.tokensPerSecond : 0
  refs.value.textContent = value.toFixed(1)
  const peak = Math.max(value, peakTps * 0.99)
  peakTps = peak
  refs.fill.style.transform = `scaleX(${peak > 0.05 ? Math.min(1, value / peak).toFixed(4) : '0'})`

  const status = ((): { label: string; tone: 'neutral' | 'success' | 'warning' } => {
    if (snap === null) return { label: copy.tpsConnecting, tone: 'neutral' }
    if (snap.connection === 'error') return { label: copy.tpsReconnecting, tone: 'warning' }
    if (snap.connection === 'connecting') return { label: copy.tpsConnecting, tone: 'neutral' }
    if (snap.connection === 'idle') return { label: copy.tpsAsleep, tone: 'neutral' }
    if (snap.waiting === 'permission') return { label: copy.tpsWaitingPermission, tone: 'warning' }
    if (snap.waiting === 'question') return { label: copy.tpsWaitingAnswer, tone: 'warning' }
    if (snap.busy) return { label: copy.tpsGenerating, tone: 'success' }
    return { label: copy.tpsIdle, tone: 'neutral' }
  })()
  refs.badge.update(status)

  const turn = snap?.lastTurn ?? null
  if (turn !== null) {
    refs.lastTurnValue.textContent = `${turn.tokensPerSecond.toFixed(1)} ${copy.tpsUnit}`
    const parts = [`${fmtInt(turn.tokens)} tok`, `${(turn.activeMs / 1000).toFixed(1)} s (${copy.tpsActive})`]
    if (turn.pausedMs >= 1000) parts.push(`${copy.tpsPaused} ${(turn.pausedMs / 1000).toFixed(1)} s`)
    if (turn.source === 'estimate') parts.push(copy.tpsEstimated)
    refs.lastTurnMeta.textContent = parts.join(' · ')
  } else {
    const measuring = snap?.busy === true
    refs.lastTurnValue.textContent = measuring ? copy.tpsLastTurnPending : '—'
    refs.lastTurnMeta.textContent = measuring ? '' : copy.tpsLastTurnEmpty
  }
}

/** 告诉服务看哪个会话（origin/会话变化时才发）。 */
async function syncTpsWatch(): Promise<boolean> {
  const origin = panelOrigin()
  if (origin === null) return false
  const key = `${origin}|${currentSession?.id ?? ''}`
  if (key === watchedKey) return true
  try {
    await api('POST', '/api/tps/watch', { origin, sessionId: currentSession?.id ?? null, title: currentSession?.title ?? null })
    watchedKey = key
    return true
  } catch {
    watchedKey = ''
    return false
  }
}

async function pollTps(): Promise<void> {
  if (!(await syncTpsWatch())) {
    renderTps()
    return
  }
  try {
    tps = await api<TpsSnapshot>('GET', '/api/tps')
  } catch {
    // 保留上一份快照
  }
  renderTps()
}

// ---------------------------------------------------------------------------
// 概览
// ---------------------------------------------------------------------------

function renderOverview(): HTMLElement {
  const wrap = el('div')
  wrap.style.display = 'flex'
  wrap.style.flexDirection = 'column'
  wrap.style.gap = '12px'

  // TPS 仪表盘置顶；下面才是路由用量看板（周期/汇总/趋势）
  tpsRefs = null
  wrap.append(buildTpsCard())
  void pollTps()

  const periodLabels: Array<[Period, string]> = [
    ['today', copy.periodToday],
    ['24h', copy.period24h],
    ['7d', copy.period7d],
    ['30d', copy.period30d],
  ]
  const periodTabsRoot = el('div')
  mountTabs(periodTabsRoot, {
    items: periodLabels.map(([id, label]) => ({ id, label })),
    activeId: period,
    onChange: (id) => {
      period = id as Period
      void loadStats().then(renderBody).catch((error) => notify(describeError(error), 'error'))
    },
  })

  const successRate = stats !== null && stats.requests > 0 ? `${((stats.ok / stats.requests) * 100).toFixed(1)}%` : '—'
  const grid = el('div', 'oc-grid')
  grid.append(
    statCard(copy.overviewRequests, stats !== null ? fmtInt(stats.requests) : '—', stats !== null ? `${copy.failed} ${fmtInt(stats.failed)}` : undefined),
    statCard(copy.overviewSuccess, successRate),
    statCard(copy.overviewPrompt, stats !== null ? fmtTokens(stats.promptTokens) : '—'),
    statCard(copy.overviewCompletion, stats !== null ? fmtTokens(stats.completionTokens) : '—'),
    statCard(copy.overviewCached, stats !== null ? fmtTokens(stats.cachedTokens) : '—'),
    statCard(copy.overviewAvg, stats !== null ? fmtMs(stats.avgDurationMs) : '—', stats !== null ? `TTFB ${fmtMs(stats.avgTtfbMs)}` : undefined),
  )
  const clearBtn = el('span')
  mountButton(clearBtn, {
    label: copy.clearStats,
    variant: 'ghost',
    size: 'xs',
    onClick: () => {
      void api('POST', '/api/stats/clear')
        .then(reload)
        .catch((error) => notify(describeError(error), 'error'))
    },
  })
  wrap.append(cardWithTitle(copy.tabOverview, clearBtn, [periodTabsRoot, grid, chartView()]))
  return wrap
}

// ---------------------------------------------------------------------------
// 供应商
// ---------------------------------------------------------------------------

function toggleRow(label: string, description: string | undefined, checked: boolean, onChange: (v: boolean) => void): HTMLElement {
  const node = el('div', 'oc-row')
  const labelWrap = el('div', 'oc-grow')
  labelWrap.append(el('div', 'oc-item-title', label))
  if (description !== undefined) labelWrap.append(el('div', 'oc-item-sub', description))
  const switchWrap = el('div')
  mountSwitch(switchWrap, { label: '', checked, onChange })
  node.append(labelWrap, switchWrap)
  return node
}

function renderSupplierList(): HTMLElement {
  const wrap = el('div')
  wrap.style.display = 'flex'
  wrap.style.flexDirection = 'column'
  wrap.style.gap = '12px'
  for (const supplier of state?.suppliers ?? []) {
    const item = el('div', 'oc-item')
    const main = el('div', 'oc-item-main')
    const left = el('div', 'oc-flex')
    if (supplier.icon !== '') {
      const img = el('img', 'oc-avatar')
      img.src = supplier.icon
      img.alt = ''
      left.append(img)
    }
    const nameWrap = el('div', 'oc-grow')
    nameWrap.append(el('div', 'oc-item-title', supplier.name))
    nameWrap.append(
      el(
        'div',
        'oc-item-sub',
        `${supplier.alias} · ${supplier.accounts.length} ${copy.accountCount} · ${supplier.enabledModelCount}/${supplier.modelCount} ${copy.modelWord}${supplier.accounts.length === 0 ? ` · ${copy.noAccountsShort}` : ''}`,
      ),
    )
    left.append(nameWrap)
    const right = el('div', 'oc-actions oc-nowrap')
    right.append(mountToggleMini(supplier))
    const open = el('span')
    mountButton(open, {
      label: '›',
      variant: 'ghost',
      size: 'xs',
      onClick: () => {
        detailId = supplier.id
        void loadDetail(supplier.id)
          .then(renderBody)
          .catch((error) => notify(describeError(error), 'error'))
      },
    })
    right.append(open)
    main.append(left, right)
    item.append(main)
    wrap.append(item)
  }
  if ((state?.suppliers ?? []).length === 0) wrap.append(empty(copy.noData))
  return wrap
}

function mountToggleMini(supplier: SupplierView): HTMLElement {
  const node = el('span')
  mountSwitch(node, {
    label: '',
    checked: supplier.enabled,
    onChange: (value) => {
      void api('POST', `/api/suppliers/${encodeURIComponent(supplier.id)}/enabled`, { enabled: value })
        .then(reload)
        .catch((error) => notify(describeError(error), 'error'))
    },
  })
  return node
}

function renderSupplierDetail(): HTMLElement {
  const wrap = el('div')
  wrap.style.display = 'flex'
  wrap.style.flexDirection = 'column'
  wrap.style.gap = '12px'

  const back = el('span')
  mountButton(back, {
    label: `‹ ${copy.back}`,
    variant: 'ghost',
    size: 'xs',
    onClick: () => {
      detailId = null
      detail = null
      renderBody()
    },
  })
  wrap.append(back)

  if (detail === null) {
    wrap.append(card([mountSpinnerInline(copy.loading)]))
    return wrap
  }
  const supplier = detail
  const locked = supplier.accounts.length === 0

  // 头部：图标 + 名称 + 开关
  const head = el('div', 'oc-card')
  const top = el('div', 'oc-item-main')
  const left = el('div', 'oc-flex')
  if (supplier.icon !== '') {
    const img = el('img', 'oc-avatar')
    img.src = supplier.icon
    img.alt = ''
    left.append(img)
  }
  const nameWrap = el('div', 'oc-grow')
  nameWrap.append(el('div', 'oc-item-title', supplier.name))
  nameWrap.append(el('div', 'oc-item-sub', `${copy.sourceLabel}：${supplier.modelSource === 'upstream' ? copy.upstream : copy.fallback}`))
  left.append(nameWrap)
  const toggle = el('span')
  mountSwitch(toggle, {
    label: '',
    checked: supplier.enabled,
    onChange: (value) => {
      void api('POST', `/api/suppliers/${encodeURIComponent(supplier.id)}/enabled`, { enabled: value })
        .then(reload)
        .catch((error) => notify(describeError(error), 'error'))
    },
  })
  top.append(left, toggle)
  head.append(top)

  // 别名
  const aliasRow = el('div', 'oc-flex')
  const aliasFieldWrap = el('div', 'oc-grow')
  let aliasDraft = supplier.alias
  const aliasField = mountTextField(aliasFieldWrap, {
    value: aliasDraft,
    label: copy.alias,
    helper: copy.aliasHint,
    mono: true,
    onChange: (value) => {
      aliasDraft = value
      aliasField.update({ value })
    },
  })
  const aliasSaveWrap = el('span')
  mountButton(aliasSaveWrap, {
    label: copy.save,
    variant: 'outline',
    size: 'sm',
    onClick: () => {
      void api('POST', `/api/suppliers/${encodeURIComponent(supplier.id)}/alias`, { alias: aliasDraft })
        .then(reload)
        .catch((error) => notify(describeError(error), 'error'))
    },
  })
  aliasRow.append(aliasFieldWrap, aliasSaveWrap)
  head.append(aliasRow)
  wrap.append(head)

  // 账号池
  const accountsActions = el('div', 'oc-actions')
  const addLink = el('span')
  mountButton(addLink, {
    label: copy.addLink,
    variant: 'default',
    size: 'sm',
    onClick: () => void runJob('login', supplier.id),
  })
  const checkin = el('span')
  mountButton(checkin, {
    label: copy.checkin,
    variant: 'outline',
    size: 'sm',
    onClick: () => void runJob('checkin', supplier.id),
  })
  accountsActions.append(addLink, checkin)

  const accountNodes: HTMLElement[] = []
  if (supplier.accounts.length === 0) accountNodes.push(empty(copy.noAccounts))
  for (const account of supplier.accounts) {
    const item = el('div', 'oc-item')
    const main = el('div', 'oc-item-main')
    const info = el('div', 'oc-grow')
    info.append(el('div', 'oc-item-title', account.nickname))
    const credits = account.credits < 0 ? copy.unknownCredits : fmtCredits(account.credits)
    info.append(el('div', 'oc-item-sub', `${account.uid} · ${copy.credits} ${credits}`))
    const right = el('div', 'oc-actions')
    if (account.cooling) {
      const badgeWrap = el('span')
      mountBadge(badgeWrap, { label: account.reason !== undefined ? `${copy.cooling}·${account.reason}`.slice(0, 28) : copy.cooling, tone: 'warning' })
      right.append(badgeWrap)
    }
    const del = el('span')
    mountButton(del, {
      label: copy.delete,
      variant: 'ghost',
      size: 'xs',
      onClick: () => {
        void api('POST', `/api/suppliers/${encodeURIComponent(supplier.id)}/accounts/remove`, { uid: account.uid })
          .then(reload)
          .catch((error) => notify(describeError(error), 'error'))
      },
    })
    right.append(del)
    main.append(info, right)
    item.append(main)
    accountNodes.push(item)
  }
  wrap.append(cardWithTitle(copy.poolOrder, null, [accountsActions, ...accountNodes]))

  // 模型
  const modelActions = el('div', 'oc-actions')
  const fetchModels = el('span')
  mountButton(fetchModels, {
    label: copy.fetchModels,
    variant: 'default',
    size: 'sm',
    onClick: () => void runJob('models', supplier.id),
  })
  const enableAll = el('span')
  mountButton(enableAll, {
    label: copy.enableAll,
    variant: 'outline',
    size: 'sm',
    disabled: locked,
    onClick: () => {
      void api('POST', `/api/suppliers/${encodeURIComponent(supplier.id)}/models/all`, { enabled: true })
        .then(reload)
        .catch((error) => notify(describeError(error), 'error'))
    },
  })
  const disableAll = el('span')
  mountButton(disableAll, {
    label: copy.disableAll,
    variant: 'outline',
    size: 'sm',
    disabled: locked,
    onClick: () => {
      void api('POST', `/api/suppliers/${encodeURIComponent(supplier.id)}/models/all`, { enabled: false })
        .then(reload)
        .catch((error) => notify(describeError(error), 'error'))
    },
  })
  modelActions.append(fetchModels, enableAll, disableAll)

  const modelNodes: HTMLElement[] = []
  if (locked) modelNodes.push(el('div', 'oc-item-sub', copy.noAccountsModels))
  if (supplier.models.length === 0) modelNodes.push(empty(copy.noModels))
  const modelList = el('div', 'oc-scroll')
  for (const model of supplier.models) modelList.append(renderModelRow(supplier.id, model, locked))
  if (supplier.models.length > 0) modelNodes.push(modelList)
  modelNodes.push(renderCustomModelRow(supplier.id))
  modelNodes.unshift(modelActions)
  wrap.append(cardWithTitle(copy.models, null, modelNodes))

  return wrap
}

function renderModelRow(supplierId: string, model: ModelView, locked: boolean): HTMLElement {
  const item = el('div', 'oc-item-main')
  const info = el('div', 'oc-grow')
  info.append(el('div', 'oc-item-title', model.id))
  const ctx =
    model.context_length === undefined
      ? ''
      : model.context_length < 10_000
        ? `${Math.round(model.context_length)}K ctx`
        : `${fmtTokens(model.context_length)} ctx`
  const meta = [model.custom ? copy.custom : '', ctx].filter((x) => x !== '').join(' · ')
  if (meta !== '') info.append(el('div', 'oc-item-sub', meta))
  const right = el('div', 'oc-actions')
  if (model.custom) {
    const del = el('span')
    mountButton(del, {
      label: copy.delete,
      variant: 'ghost',
      size: 'xs',
      onClick: () => {
        void api('POST', `/api/suppliers/${encodeURIComponent(supplierId)}/models/custom/remove`, { id: model.id })
          .then(reload)
          .catch((error) => notify(describeError(error), 'error'))
      },
    })
    right.append(del)
  }
  const toggle = el('span')
  mountSwitch(toggle, {
    label: '',
    checked: model.enabled,
    disabled: locked,
    onChange: (value) => {
      void api('POST', `/api/suppliers/${encodeURIComponent(supplierId)}/models/toggle`, { id: model.id, enabled: value })
        .then(reload)
        .catch((error) => notify(describeError(error), 'error'))
    },
  })
  right.append(toggle)
  item.append(info, right)
  return item
}

function renderCustomModelRow(supplierId: string): HTMLElement {
  const row = el('div', 'oc-flex')
  const fieldWrap = el('div', 'oc-grow')
  let draft = ''
  const field = mountTextField(fieldWrap, {
    value: '',
    placeholder: copy.modelId,
    mono: true,
    onChange: (value) => {
      draft = value
      field.update({ value })
    },
  })
  const addWrap = el('span')
  mountButton(addWrap, {
    label: copy.add,
    variant: 'outline',
    size: 'sm',
    onClick: () => {
      if (draft.trim() === '') return
      void api('POST', `/api/suppliers/${encodeURIComponent(supplierId)}/models/custom`, { id: draft.trim() })
        .then(() => {
          field.update({ value: '' })
          draft = ''
          return reload()
        })
        .catch((error) => notify(describeError(error), 'error'))
    },
  })
  row.append(fieldWrap, addWrap)
  return row
}

function mountSpinnerInline(label: string): HTMLElement {
  const node = el('span')
  mountSpinner(node, { label })
  return node
}

// ---------------------------------------------------------------------------
// 组合
// ---------------------------------------------------------------------------

/** 组合表单草稿（模块级：自动刷新/重画不丢正在输入的内容）。 */
let comboDraft: { name: string; targets: string[]; editing: string | null } = { name: '', targets: [], editing: null }
/** 组合「添加模型」的搜索词（重画时保留）。 */
let comboSearch = ''

function renderCombos(): HTMLElement {
  const wrap = el('div')
  wrap.style.display = 'flex'
  wrap.style.flexDirection = 'column'
  wrap.style.gap = '12px'

  const listNodes: HTMLElement[] = []
  const combos = state?.combos ?? []
  if (combos.length === 0) listNodes.push(empty(copy.noCombos))
  for (const combo of combos) listNodes.push(renderComboItem(combo))
  wrap.append(cardWithTitle(copy.combosTitle, null, listNodes))

  // 「可添加的模型」：当前启用中的模型（没账号的供应商已经被 app 侧过滤掉）
  const available: Array<{ id: string; group: string }> = []
  for (const supplier of state?.suppliers ?? []) {
    if (!supplier.enabled) continue
    for (const model of supplier.models) available.push({ id: `${supplier.alias}/${model}`, group: `${supplier.name} · ${supplier.alias}` })
  }
  const availableIds = new Set(available.map((m) => m.id))

  const nameWrap = el('div')
  const nameField = mountTextField(nameWrap, {
    value: comboDraft.name,
    label: copy.comboName,
    mono: true,
    onChange: (value) => {
      comboDraft.name = value
      nameField.update({ value })
    },
  })

  // 已选模型：编号 + 移除（按顺序回退）
  const selectedNodes: HTMLElement[] = []
  selectedNodes.push(el('div', 'oc-item-sub', `${copy.comboSelected}（${comboDraft.targets.length}）`))
  if (comboDraft.targets.length === 0) {
    selectedNodes.push(el('div', 'oc-item-sub', copy.comboEmptySelection))
  } else {
    comboDraft.targets.forEach((target, index) => {
      const row = el('div', 'oc-item-main')
      const info = el('div', 'oc-grow')
      info.append(el('div', 'oc-item-title', `${index + 1}. ${target}`))
      if (!availableIds.has(target)) info.append(el('div', 'oc-item-sub', copy.invalidTarget))
      const removeWrap = el('span')
      mountButton(removeWrap, {
        label: copy.delete,
        variant: 'ghost',
        size: 'xs',
        onClick: () => {
          comboDraft.targets = comboDraft.targets.filter((t) => t !== target)
          renderBody()
        },
      })
      row.append(info, removeWrap)
      selectedNodes.push(row)
    })
  }
  selectedNodes.push(el('div', 'oc-item-sub', copy.comboHint))

  // 「添加模型」：搜索 + 按供应商分组，点「添加」进入已选
  const pickWrap = el('div')
  const searchWrap = el('div')
  mountSearchField(searchWrap, {
    value: comboSearch,
    placeholder: copy.comboPickSearch,
    onChange: (value) => {
      comboSearch = value
      renderPicker()
    },
  })
  const listWrap = el('div', 'oc-scroll')
  const renderPicker = (): void => {
    clear(listWrap)
    const query = comboSearch.trim().toLowerCase()
    const candidates = available.filter((m) => !comboDraft.targets.includes(m.id) && (query === '' || m.id.toLowerCase().includes(query)))
    if (candidates.length === 0) {
      listWrap.append(el('div', 'oc-item-sub', available.length === 0 ? copy.comboPickEmpty : copy.noData))
      return
    }
    let currentGroup = ''
    for (const model of candidates) {
      if (model.group !== currentGroup) {
        currentGroup = model.group
        listWrap.append(el('div', 'oc-item-sub', currentGroup))
      }
      const row = el('div', 'oc-item-main')
      row.append(el('div', 'oc-item-title oc-grow', model.id))
      const addWrap = el('span')
      mountButton(addWrap, {
        label: copy.add,
        variant: 'outline',
        size: 'xs',
        onClick: () => {
          comboDraft.targets = [...comboDraft.targets, model.id]
          renderBody()
        },
      })
      row.append(addWrap)
      listWrap.append(row)
    }
  }
  renderPicker()

  const actions = el('div', 'oc-actions')
  const saveWrap = el('span')
  mountButton(saveWrap, {
    label: copy.comboSave,
    variant: 'default',
    size: 'sm',
    disabled: comboDraft.targets.length === 0,
    onClick: () => {
      const name = comboDraft.name.trim()
      if (name === '' || comboDraft.targets.length === 0) return
      void api<{ combo?: ComboResolved }>('POST', '/api/combos/set', { name, targets: comboDraft.targets })
        .then((result) => {
          const invalid = (result.combo?.targets ?? []).filter((t) => !t.ok)
          if (invalid.length > 0) {
            notify(`目标无法解析：${invalid.map((t) => t.raw).join('、')}（检查拼写或从列表里挑）`, 'warning')
          }
          comboDraft = { name: '', targets: [], editing: null }
          comboSearch = ''
          return reload()
        })
        .catch((error) => notify(describeError(error), 'error'))
    },
  })
  actions.append(saveWrap)
  if (comboDraft.editing !== null) {
    const cancelWrap = el('span')
    mountButton(cancelWrap, {
      label: copy.editCancel,
      variant: 'ghost',
      size: 'sm',
      onClick: () => {
        comboDraft = { name: '', targets: [], editing: null }
        comboSearch = ''
        renderBody()
      },
    })
    actions.append(cancelWrap)
  }

  const formChildren: HTMLElement[] = []
  if (comboDraft.editing !== null) formChildren.push(el('div', 'oc-item-sub', `${copy.editingCombo}：${comboDraft.editing}`))
  formChildren.push(nameWrap, ...selectedNodes)
  formChildren.push(cardWithTitle(copy.comboPick, null, [searchWrap, listWrap]))
  formChildren.push(actions)
  wrap.append(card(formChildren))
  return wrap
}

function renderComboItem(combo: ComboResolved): HTMLElement {
  const item = el('div', 'oc-item')
  const main = el('div', 'oc-item-main')
  const info = el('div', 'oc-grow')
  info.append(el('div', 'oc-item-title', combo.name))
  info.append(el('div', 'oc-item-sub', combo.targets.map((t) => (t.ok ? t.raw : `${t.raw}（${copy.invalidTarget}）`)).join(' → ') || copy.noData))
  const actions = el('div', 'oc-actions')
  const editWrap = el('span')
  mountButton(editWrap, {
    label: copy.edit,
    variant: 'outline',
    size: 'xs',
    onClick: () => {
      comboDraft = { name: combo.name, targets: combo.targets.map((t) => t.raw), editing: combo.name }
      comboSearch = ''
      renderBody()
    },
  })
  const delWrap = el('span')
  mountButton(delWrap, {
    label: copy.delete,
    variant: 'ghost',
    size: 'xs',
    onClick: () => {
      void api('POST', '/api/combos/remove', { name: combo.name })
        .then(() => {
          if (comboDraft.editing === combo.name) comboDraft = { name: '', targets: [], editing: null }
          return reload()
        })
        .catch((error) => notify(describeError(error), 'error'))
    },
  })
  actions.append(editWrap, delWrap)
  main.append(info, actions)
  item.append(main)
  return item
}

// ---------------------------------------------------------------------------
// 端点与密钥
// ---------------------------------------------------------------------------

function renderEndpoint(): HTMLElement {
  const wrap = el('div')
  wrap.style.display = 'flex'
  wrap.style.flexDirection = 'column'
  wrap.style.gap = '12px'

  const endpoint = state?.endpoint ?? '—'
  const endpointRow = el('div', 'oc-flex')
  const endpointText = el('div', 'oc-mono oc-grow', endpoint)
  const copyWrap = el('span')
  mountButton(copyWrap, {
    label: copy.copy,
    variant: 'outline',
    size: 'sm',
    onClick: () => {
      void host
        .writeClipboard(endpoint)
        .then(() => notify(copy.copied, 'success'))
        .catch((error) => notify(describeError(error), 'error'))
    },
  })
  endpointRow.append(endpointText, copyWrap)

  let portDraft = String(state?.settings.port ?? 3080)
  const portRow = el('div', 'oc-flex')
  const portWrap = el('div', 'oc-grow')
  const portField = mountTextField(portWrap, {
    value: portDraft,
    label: copy.port,
    helper: copy.portHint,
    mono: true,
    onChange: (value) => {
      portDraft = value
      portField.update({ value })
    },
  })
  const portSave = el('span')
  mountButton(portSave, {
    label: copy.save,
    variant: 'outline',
    size: 'sm',
    onClick: () => {
      const port = Number(portDraft)
      if (!Number.isInteger(port) || port <= 0 || port >= 65536) {
        notify(copy.badPort, 'error')
        return
      }
      void api('POST', '/api/settings', { port })
        .then(() => reload())
        .catch((error) => notify(describeError(error), 'error'))
    },
  })
  portRow.append(portWrap, portSave)

  const requireRow = toggleRow(copy.requireKey, copy.requireKeyHint, state?.settings.requireApiKey ?? false, (value) => {
    void api('POST', '/api/settings', { requireApiKey: value })
      .then(() => reload())
      .catch((error) => notify(describeError(error), 'error'))
  })

  wrap.append(cardWithTitle(copy.endpoint, null, [endpointRow, portRow, requireRow]))

  // OpenCode provider 自动同步（服务的 opencode-sync 写 opencode.json 的 providers.ocber）
  const sync = state?.opencode
  const syncRow = toggleRow(copy.opencodeSync, copy.opencodeSyncHint, sync?.enabled ?? false, (value) => {
    void api('POST', '/api/settings', { opencodeSync: value })
      .then(() => reload())
      .catch((error) => notify(describeError(error), 'error'))
  })
  const syncStatusRow = el('div', 'oc-row')
  const syncInfo = el('div', 'oc-grow')
  const syncState =
    sync?.error !== undefined
      ? `${copy.syncFailed}：${sync.error}`
      : `${copy.syncAt}：${sync !== undefined && sync.syncedAt > 0 ? new Date(sync.syncedAt).toLocaleString() : copy.syncNever} · ${copy.syncModels} ${sync?.modelCount ?? 0}`
  syncInfo.append(el('div', 'oc-item-sub', syncState))
  syncInfo.append(el('div', 'oc-mono', sync?.path ?? '~/.config/opencode/opencode.json'))
  const syncNowWrap = el('span')
  mountButton(syncNowWrap, {
    label: copy.syncNow,
    variant: 'outline',
    size: 'sm',
    onClick: () => {
      void api<{ opencode: { error?: string; modelCount: number } }>('POST', '/api/opencode/sync')
        .then((result) => {
          if (result.opencode?.error !== undefined) notify(`${copy.syncFailed}：${result.opencode.error}`, 'error')
          else notify(`${copy.syncAt}：${result.opencode?.modelCount ?? 0} ${copy.syncModels}`, 'success')
          return reload()
        })
        .catch((error) => notify(describeError(error), 'error'))
    },
  })
  syncStatusRow.append(syncInfo, syncNowWrap)
  wrap.append(cardWithTitle(copy.opencodeTitle, null, [syncRow, syncStatusRow]))

  // API keys
  let keyNameDraft = ''
  const keyNameWrap = el('div')
  const keyNameField = mountTextField(keyNameWrap, {
    value: '',
    label: copy.keyName,
    placeholder: 'Claude Code',
    onChange: (value) => {
      keyNameDraft = value
      keyNameField.update({ value })
    },
  })
  const createWrap = el('div')
  mountButton(createWrap, {
    label: copy.createKey,
    variant: 'default',
    size: 'sm',
    onClick: () => {
      void api<{ entry: { key: string; name: string } }>('POST', '/api/keys', { name: keyNameDraft })
        .then((result) => {
          void host
            .toast({ kind: 'success', message: `${copy.keyCreated}：${result.entry.key}`, copy: { text: result.entry.key }, persistent: true })
            .catch(() => notify(result.entry.key, 'success'))
          keyNameField.update({ value: '' })
          keyNameDraft = ''
          return reload()
        })
        .catch((error) => notify(describeError(error), 'error'))
    },
  })

  const keyNodes: HTMLElement[] = []
  const keys = state?.keys ?? []
  if (keys.length === 0) keyNodes.push(empty(copy.noData))
  for (const key of keys) {
    const item = el('div', 'oc-item-main')
    const info = el('div', 'oc-grow')
    info.append(el('div', 'oc-item-title', key.name))
    info.append(el('div', 'oc-mono', key.masked))
    const right = el('div', 'oc-actions')
    const toggle = el('span')
    mountSwitch(toggle, {
      label: '',
      checked: key.isActive,
      onChange: (value) => {
        void api('POST', '/api/keys/toggle', { id: key.id, isActive: value })
          .then(() => reload())
          .catch((error) => notify(describeError(error), 'error'))
      },
    })
    const del = el('span')
    mountButton(del, {
      label: copy.delete,
      variant: 'ghost',
      size: 'xs',
      onClick: () => {
        void api('POST', '/api/keys/delete', { id: key.id })
          .then(() => reload())
          .catch((error) => notify(describeError(error), 'error'))
      },
    })
    right.append(toggle, del)
    item.append(info, right)
    keyNodes.push(item)
  }
  wrap.append(cardWithTitle(copy.keys, null, [keyNameWrap, createWrap, ...keyNodes]))
  return wrap
}

// ---------------------------------------------------------------------------
// 渲染
// ---------------------------------------------------------------------------

function renderTabs(): void {
  if (tabs === null) {
    tabs = mountTabs(tabsRoot, {
      items: [],
      activeId: tab,
      onChange: (id) => {
        tab = id
        detailId = null
        detail = null
        renderTabs()
        void (tab === 'overview' ? loadStats().catch(() => undefined) : Promise.resolve()).then(renderBody)
      },
    })
  }
  tabs.update({
    items: [
      { id: 'overview', label: copy.tabOverview },
      { id: 'suppliers', label: copy.tabSuppliers, count: state?.suppliers.length },
      { id: 'combos', label: copy.tabCombos, count: state?.combos.length },
      { id: 'endpoint', label: copy.tabEndpoint, count: state?.keys.length },
    ],
    activeId: tab,
  })
}

function renderHead(): void {
  clear(headRoot)
  const left = el('div', 'oc-grow')
  left.append(el('h1', 'oc-title', copy.title))
  const sub = el('p', 'oc-sub')
  sub.textContent =
    state === null
      ? copy.loading
      : `v${state.version} · ${state.suppliers.reduce((n, s) => n + s.accounts.length, 0)} ${copy.accountCount} · ${state.endpoint}`
  left.append(sub)
  const right = el('div', 'oc-actions')
  const refreshWrap = el('span')
  mountButton(refreshWrap, { label: copy.refresh, variant: 'outline', size: 'sm', loading: refreshing, onClick: () => void reload() })
  right.append(refreshWrap)
  headRoot.append(left, right)
}

function renderBody(): void {
  clear(viewRoot)
  if (state === null) {
    viewRoot.append(card([mountSpinnerInline(copy.loading)]))
    return
  }
  if (tab === 'overview') viewRoot.append(renderOverview())
  else if (tab === 'suppliers') viewRoot.append(detailId === null ? renderSupplierList() : renderSupplierDetail())
  else if (tab === 'combos') viewRoot.append(renderCombos())
  else viewRoot.append(renderEndpoint())
}

function mount(): void {
  const container = el('div', 'oc-root')
  noticeRoot = el('div', 'oc-notice')
  headRoot = el('div', 'oc-head')
  tabsRoot = el('div')
  viewRoot = el('div', 'oc-view')
  container.append(noticeRoot, headRoot, tabsRoot, viewRoot)
  rootNode!.append(container)
  renderHead()
  viewRoot.append(card([mountSpinnerInline(copy.loading)]))

  void reload().then(() => {
    void loadStats().then(renderBody).catch(() => undefined)
  })

  const loop = (): void => {
    if (stopped) return
    window.setTimeout(() => {
      void (async () => {
        if (!document.hidden && !refreshing && !jobActive) {
          try {
            if (tab === 'overview' || (tab === 'suppliers' && detailId === null)) {
              await reload()
            } else {
              // 详情页 / 表单页只静默刷新头部与页签计数，避免把正在输入的内容重画掉
              await refreshState()
              renderHead()
              renderTabs()
            }
          } catch {
            // 静默失败，等下一次
          }
        }
        loop()
      })()
    }, 15_000)
  }
  loop()

  // TPS 用独立的小节奏轮询（只更新卡片里的数字，不重画页面）
  const tpsLoop = (): void => {
    if (stopped) return
    window.setTimeout(() => {
      void (async () => {
        if (!document.hidden && tab === 'overview') await pollTps()
        tpsLoop()
      })()
    }, 500)
  }
  tpsLoop()
}

host.onReady((ctx) => {
  copy = resolveCopy(ctx.locale)
  applyHostReady(ctx, document.documentElement)
  currentSession = ctx.session !== null ? { id: ctx.session.id, title: ctx.session.title } : null
  if (!mounted) {
    mounted = true
    mount()
    return
  }
  renderTabs()
  renderBody()
})

host.onSession((session) => {
  currentSession = session !== null ? { id: session.id, title: session.title } : null
  watchedKey = ''
})

// 面板打开时立刻触发一次 serviceRequest，让宿主把本地服务拉起来。
void host.serviceStatus().catch(() => undefined)

window.addEventListener('beforeunload', () => {
  stopped = true
  host.dispose()
})
