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
  mountSelect,
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
    topSuppliers: 'Top 供应商',
    topModels: 'Top 模型',
    recent: '最近请求',
    clearStats: '清空统计',
    combosTitle: '组合（fallback 链）',
    comboName: '组合名',
    comboTargets: '目标（逗号分隔，形如 codebuddy/glm-5.3）',
    comboSave: '保存组合',
    comboHint: '目标按顺序回退；写 `codebuddy/glm-5.3` 精确指定供应商，或直接写不带前缀的模型名（唯一命中时自动归属）。改完点「保存组合」。',
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
    syncMode: '同步内容',
    syncModeAll: '启用模型 + 组合',
    syncModeCombos: '仅组合',
    syncModeHint: '同一个模型不再同时以「别名/模型」和裸名出现（避免模型选择里重复）。',
    noAccountsModels: '未添加账号：模型暂不参与路由与同步，添加链接后自动恢复。',
    edit: '编辑',
    editCancel: '取消编辑',
    editingCombo: '正在编辑',
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
    topSuppliers: 'Top suppliers',
    topModels: 'Top models',
    recent: 'Recent requests',
    clearStats: 'Clear stats',
    combosTitle: 'Combos (fallback chain)',
    comboName: 'Combo name',
    comboTargets: 'Targets (comma separated, e.g. codebuddy/glm-5.3)',
    comboSave: 'Save combo',
    comboHint: 'A combo shows up in /v1/models and can be used as a model name; targets fail over in order.',
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
    syncMode: 'Contents',
    syncModeAll: 'Enabled models + combos',
    syncModeCombos: 'Combos only',
    syncModeHint: 'Each model appears once (as alias/model); bare duplicates are gone.',
    noAccountsModels: 'No account yet: these models stay out of routing and sync until a link is added.',
    edit: 'Edit',
    editCancel: 'Cancel edit',
    editingCombo: 'Editing',
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

function rankList(rows: StatsResult['bySupplier']): HTMLElement {
  const list = el('div', 'oc-list')
  if (rows.length === 0) return empty(copy.noData)
  for (const row of rows.slice(0, 8)) {
    const item = el('div', 'oc-item-main')
    item.append(el('div', 'oc-item-title', row.name))
    item.append(el('div', 'oc-num', `${fmtInt(row.requests)} · ${fmtTokens(row.promptTokens + row.completionTokens)}`))
    list.append(item)
  }
  return list
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
// 概览
// ---------------------------------------------------------------------------

function renderOverview(): HTMLElement {
  const frag = document.createDocumentFragment()
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
  frag.append(periodTabsRoot)

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
  frag.append(cardWithTitle(copy.tabOverview, clearBtn, [grid, chartView()]))

  const topWrap = el('div')
  topWrap.style.display = 'grid'
  topWrap.style.gap = '12px'
  topWrap.append(
    cardWithTitle(copy.topSuppliers, null, [rankList(stats?.bySupplier ?? [])]),
    cardWithTitle(copy.topModels, null, [rankList(stats?.byModel ?? [])]),
  )
  frag.append(topWrap)

  const recentCard = cardWithTitle(copy.recent, null, [
    recent.length === 0
      ? empty(copy.noData)
      : (() => {
          const list = el('div', 'oc-list')
          for (const r of recent.slice(0, 10)) {
            const item = el('div', 'oc-item')
            const main = el('div', 'oc-item-main')
            main.append(el('div', 'oc-item-title', r.requested || r.model))
            main.append(el('div', 'oc-num', r.ok ? fmtMs(r.durationMs) : copy.failed))
            const sub = el('div', 'oc-item-sub')
            sub.textContent = `${new Date(r.ts).toLocaleTimeString()} · ${r.supplier} · in ${fmtTokens(r.promptTokens)} / out ${fmtTokens(r.completionTokens)}${r.cachedTokens > 0 ? ` / cache ${fmtTokens(r.cachedTokens)}` : ''}${r.error !== undefined ? ` · ${r.error}` : ''}`
            item.append(main, sub)
            list.append(item)
          }
          return list
        })(),
  ])
  frag.append(recentCard)

  const wrap = el('div')
  wrap.style.display = 'flex'
  wrap.style.flexDirection = 'column'
  wrap.style.gap = '12px'
  wrap.append(frag)
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
        `${supplier.alias} · ${supplier.accounts.length} ${copy.accountCount} · ${supplier.enabledModelCount}/${supplier.modelCount} ${copy.modelWord}${supplier.accounts.length === 0 ? ` · ${copy.noAccountsModels}` : ''}`,
      ),
    )
    left.append(nameWrap)
    const right = el('div', 'oc-actions')
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
let comboDraft: { name: string; targets: string; editing: string | null } = { name: '', targets: '', editing: null }

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
  const targetsWrap = el('div')
  const targetsField = mountTextField(targetsWrap, {
    value: comboDraft.targets,
    label: copy.comboTargets,
    helper: copy.comboHint,
    multiline: true,
    rows: 3,
    mono: true,
    onChange: (value) => {
      comboDraft.targets = value
      targetsField.update({ value })
    },
  })

  const actions = el('div', 'oc-actions')
  const saveWrap = el('span')
  mountButton(saveWrap, {
    label: copy.comboSave,
    variant: 'default',
    size: 'sm',
    onClick: () => {
      const name = comboDraft.name.trim()
      if (name === '') return
      const targets = comboDraft.targets
        .split(/[,，\n]/)
        .map((t) => t.trim())
        .filter((t) => t !== '')
      void api<{ combo?: ComboResolved }>('POST', '/api/combos/set', { name, targets })
        .then((result) => {
          const invalid = (result.combo?.targets ?? []).filter((t) => !t.ok)
          if (invalid.length > 0) {
            notify(`目标无法解析：${invalid.map((t) => t.raw).join('、')}（可写 codebuddy/<模型名>，或检查拼写）`, 'warning')
          }
          comboDraft = { name: '', targets: '', editing: null }
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
        comboDraft = { name: '', targets: '', editing: null }
        renderBody()
      },
    })
    actions.append(cancelWrap)
  }

  const formChildren: HTMLElement[] = [nameWrap, targetsWrap]
  if (comboDraft.editing !== null) formChildren.unshift(el('div', 'oc-item-sub', `${copy.editingCombo}：${comboDraft.editing}`))
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
      comboDraft = { name: combo.name, targets: combo.targets.map((t) => t.raw).join(', '), editing: combo.name }
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
          if (comboDraft.editing === combo.name) comboDraft = { name: '', targets: '', editing: null }
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
  const syncModeWrap = el('div')
  mountSelect(syncModeWrap, {
    label: copy.syncMode,
    value: sync?.mode ?? 'models',
    options: [
      { id: 'models', label: copy.syncModeAll, hint: copy.syncModeHint },
      { id: 'combos', label: copy.syncModeCombos },
    ],
    onChange: (id) => {
      void api('POST', '/api/settings', { opencodeSyncMode: id })
        .then(() => reload())
        .catch((error) => notify(describeError(error), 'error'))
    },
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
  wrap.append(cardWithTitle(copy.opencodeTitle, null, [syncRow, syncModeWrap, syncStatusRow]))

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
}

host.onReady((ctx) => {
  copy = resolveCopy(ctx.locale)
  applyHostReady(ctx, document.documentElement)
  if (!mounted) {
    mounted = true
    mount()
    return
  }
  renderTabs()
  renderBody()
})

// 面板打开时立刻触发一次 serviceRequest，让宿主把本地服务拉起来。
void host.serviceStatus().catch(() => undefined)

window.addEventListener('beforeunload', () => {
  stopped = true
  host.dispose()
})
