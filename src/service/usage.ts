/**
 * 用量落盘与聚合（移植自 dsh-router，按本项目收敛）。
 * JSON 落盘（usage.json）：按天桶 + 天桶内 24 个小时桶 + 最近明细环。
 *  - today / 7d / 30d 走天桶；24h 走小时桶
 *  - 明细环只服务「最近请求」，不参与统计（单日超过环容量也不会截断统计）
 *  - 落盘防抖 2s；天桶保留 30 天
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

import type { ChartBucket, Period, StatsResult, RankRow, UsageRecordView } from '../shared/types.ts'

/** 一次请求的 token 口径（来自上游 usage，或按字符估算）。 */
export interface Usage {
  promptTokens: number
  completionTokens: number
  cachedTokens: number
  inputEstimated: boolean
  outputEstimated: boolean
}

export const EMPTY_USAGE: Usage = {
  promptTokens: 0,
  completionTokens: 0,
  cachedTokens: 0,
  inputEstimated: false,
  outputEstimated: false,
}

interface Entry {
  requests: number
  ok: number
  failed: number
  promptTokens: number
  completionTokens: number
  cachedTokens: number
  lastTs: number
}

interface HourBucket {
  requests: number
  ok: number
  failed: number
  promptTokens: number
  completionTokens: number
  cachedTokens: number
  durationMs: number
  ttfbMs: number
  ttfbCount: number
  estimatedInputs: number
  estimatedOutputs: number
}

interface DayBucket extends HourBucket {
  hours: HourBucket[]
  bySupplier: Record<string, Entry>
  byModel: Record<string, Entry>
  byRequested: Record<string, Entry>
}

interface UsageFile {
  days: Record<string, DayBucket>
  recent: UsageRecordView[]
  lifetime: number
}

const RING_CAP = 500
const HOURS = 24
const KEEP_DAYS = 30
const SAVE_DEBOUNCE_MS = 2000

const emptyCounters = (): HourBucket => ({
  requests: 0,
  ok: 0,
  failed: 0,
  promptTokens: 0,
  completionTokens: 0,
  cachedTokens: 0,
  durationMs: 0,
  ttfbMs: 0,
  ttfbCount: 0,
  estimatedInputs: 0,
  estimatedOutputs: 0,
})

const emptyEntry = (): Entry => ({
  requests: 0,
  ok: 0,
  failed: 0,
  promptTokens: 0,
  completionTokens: 0,
  cachedTokens: 0,
  lastTs: 0,
})

const emptyDay = (): DayBucket => ({
  ...emptyCounters(),
  hours: Array.from({ length: HOURS }, () => emptyCounters()),
  bySupplier: {},
  byModel: {},
  byRequested: {},
})

/** 本地日期键 `YYYY-MM-DD`。 */
export function localDateKey(ts: number): string {
  const d = new Date(ts)
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

export class UsageStore {
  private file: string
  private days = new Map<string, DayBucket>()
  private recent: UsageRecordView[] = []
  private lifetime = 0
  private timer: NodeJS.Timeout | null = null

  constructor(dataDir: string) {
    this.file = join(dataDir, 'usage.json')
    this.load()
  }

  /** 记一次请求。成功的零 token 请求不记；失败一定记（成功率要真）。 */
  record(
    r: Omit<UsageRecordView, 'ts' | 'promptTokens' | 'completionTokens' | 'cachedTokens'> & { ts?: number },
    usage: Usage,
  ): void {
    if (r.ok && usage.promptTokens === 0 && usage.completionTokens === 0) return
    const ts = r.ts ?? Date.now()
    const rec: UsageRecordView = {
      ...r,
      ts,
      promptTokens: usage.promptTokens,
      completionTokens: usage.completionTokens,
      cachedTokens: usage.cachedTokens,
    }
    const key = localDateKey(ts)
    let day = this.days.get(key)
    if (day === undefined) {
      day = emptyDay()
      this.days.set(key, day)
    }
    this.bumpCounters(day, rec, usage)
    const h = day.hours[new Date(ts).getHours()]
    if (h !== undefined) this.bumpCounters(h, rec, usage)
    this.bump(day.bySupplier, rec.supplier, rec)
    this.bump(day.byModel, rec.model, rec)
    this.bump(day.byRequested, rec.requested, rec)
    this.recent.unshift(rec)
    if (this.recent.length > RING_CAP) this.recent.length = RING_CAP
    this.lifetime += 1
    this.scheduleSave()
  }

  private bumpCounters(b: HourBucket, rec: UsageRecordView, usage: Usage): void {
    b.requests += 1
    if (rec.ok) b.ok += 1
    else b.failed += 1
    b.promptTokens += usage.promptTokens
    b.completionTokens += usage.completionTokens
    b.cachedTokens += usage.cachedTokens
    b.durationMs += rec.durationMs
    if (rec.ttfbMs > 0) {
      b.ttfbMs += rec.ttfbMs
      b.ttfbCount += 1
    }
    if (usage.inputEstimated) b.estimatedInputs += 1
    if (usage.outputEstimated) b.estimatedOutputs += 1
  }

  private bump(map: Record<string, Entry>, key: string, rec: UsageRecordView): void {
    if (key === '') return
    const e = map[key] ?? emptyEntry()
    e.requests += 1
    if (rec.ok) e.ok += 1
    else e.failed += 1
    e.promptTokens += rec.promptTokens
    e.completionTokens += rec.completionTokens
    e.cachedTokens += rec.cachedTokens
    e.lastTs = Math.max(e.lastTs, rec.ts)
    map[key] = e
  }

  stats(period: Period, now = Date.now()): StatsResult {
    const acc = emptyCounters()
    const bySupplier: Record<string, Entry> = {}
    const byModel: Record<string, Entry> = {}
    const byRequested: Record<string, Entry> = {}
    const addDay = (d: DayBucket): void => {
      acc.requests += d.requests
      acc.ok += d.ok
      acc.failed += d.failed
      acc.promptTokens += d.promptTokens
      acc.completionTokens += d.completionTokens
      acc.cachedTokens += d.cachedTokens
      acc.durationMs += d.durationMs
      acc.ttfbMs += d.ttfbMs
      acc.ttfbCount += d.ttfbCount
      acc.estimatedInputs += d.estimatedInputs
      acc.estimatedOutputs += d.estimatedOutputs
      mergeInto(bySupplier, d.bySupplier)
      mergeInto(byModel, d.byModel)
      mergeInto(byRequested, d.byRequested)
    }

    if (period === 'today') {
      const d = this.days.get(localDateKey(now))
      if (d !== undefined) addDay(d)
    } else if (period === '24h') {
      const start = rollingStart(now)
      for (let i = 0; i < HOURS; i += 1) {
        const ts = start + i * 3_600_000
        const d = this.days.get(localDateKey(ts))
        const h = d?.hours[new Date(ts).getHours()]
        if (h === undefined) continue
        acc.requests += h.requests
        acc.ok += h.ok
        acc.failed += h.failed
        acc.promptTokens += h.promptTokens
        acc.completionTokens += h.completionTokens
        acc.cachedTokens += h.cachedTokens
        acc.durationMs += h.durationMs
        acc.ttfbMs += h.ttfbMs
        acc.ttfbCount += h.ttfbCount
        acc.estimatedInputs += h.estimatedInputs
        acc.estimatedOutputs += h.estimatedOutputs
      }
      // Top 榜只能走天桶的维度表，取窗口覆盖到的自然日
      for (const key of new Set(Array.from({ length: HOURS }, (_, i) => localDateKey(start + i * 3_600_000)))) {
        const d = this.days.get(key)
        if (d === undefined) continue
        mergeInto(bySupplier, d.bySupplier)
        mergeInto(byModel, d.byModel)
        mergeInto(byRequested, d.byRequested)
      }
    } else {
      const days = period === '7d' ? 7 : 30
      for (let i = days - 1; i >= 0; i -= 1) {
        const d = this.days.get(localDateKey(now - i * 86_400_000))
        if (d !== undefined) addDay(d)
      }
    }

    return {
      requests: acc.requests,
      ok: acc.ok,
      failed: acc.failed,
      promptTokens: acc.promptTokens,
      completionTokens: acc.completionTokens,
      cachedTokens: acc.cachedTokens,
      avgDurationMs: acc.requests > 0 ? Math.round(acc.durationMs / acc.requests) : 0,
      avgTtfbMs: acc.ttfbCount > 0 ? Math.round(acc.ttfbMs / acc.ttfbCount) : 0,
      estimatedInputs: acc.estimatedInputs,
      estimatedOutputs: acc.estimatedOutputs,
      lifetime: this.lifetime,
      bySupplier: top(bySupplier),
      byModel: top(byModel),
      byRequested: top(byRequested),
    }
  }

  chart(period: Period, now = Date.now()): ChartBucket[] {
    const p = (n: number): string => String(n).padStart(2, '0')
    if (period === 'today' || period === '24h') {
      const first = period === 'today' ? new Date(now).setHours(0, 0, 0, 0) : rollingStart(now)
      const out: ChartBucket[] = []
      for (let i = 0; i < HOURS; i += 1) {
        const start = first + i * 3_600_000
        const h = this.days.get(localDateKey(start))?.hours[new Date(start).getHours()]
        out.push({
          label: `${p(new Date(start).getHours())}:00`,
          requests: h?.requests ?? 0,
          tokens: (h?.promptTokens ?? 0) + (h?.completionTokens ?? 0),
        })
      }
      return out
    }
    const days = period === '7d' ? 7 : 30
    const out: ChartBucket[] = []
    for (let i = days - 1; i >= 0; i -= 1) {
      const ts = now - i * 86_400_000
      const d = this.days.get(localDateKey(ts))
      out.push({
        label: localDateKey(ts).slice(5),
        requests: d?.requests ?? 0,
        tokens: (d?.promptTokens ?? 0) + (d?.completionTokens ?? 0),
      })
    }
    return out
  }

  recentList(limit = 20): UsageRecordView[] {
    return this.recent.slice(0, limit)
  }

  lastHit(): UsageRecordView | undefined {
    return this.recent[0]
  }

  clear(): void {
    this.days.clear()
    this.recent = []
    this.lifetime = 0
    this.save()
  }

  flush(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer)
      this.timer = null
    }
    this.save()
  }

  private scheduleSave(): void {
    if (this.timer !== null) return
    this.timer = setTimeout(() => {
      this.timer = null
      this.save()
    }, SAVE_DEBOUNCE_MS)
    this.timer.unref?.()
  }

  private load(): void {
    try {
      const f = JSON.parse(readFileSync(this.file, 'utf8')) as Partial<UsageFile>
      this.days = new Map(Object.entries(f.days ?? {}))
      this.recent = Array.isArray(f.recent) ? f.recent.slice(0, RING_CAP) : []
      this.lifetime = typeof f.lifetime === 'number' ? f.lifetime : 0
      for (const [k, d] of this.days) {
        const day: DayBucket = { ...emptyDay(), ...d }
        day.hours = Array.from({ length: HOURS }, (_, i) => ({ ...emptyCounters(), ...d.hours?.[i] }))
        this.days.set(k, day)
      }
    } catch {
      // 首次运行 / 文件损坏：从空开始
    }
  }

  private save(): void {
    const cutoff = localDateKey(Date.now() - KEEP_DAYS * 86_400_000)
    for (const k of [...this.days.keys()]) if (k < cutoff) this.days.delete(k)
    try {
      const dir = dirname(this.file)
      if (dir !== '' && dir !== '.') mkdirSync(dir, { recursive: true })
      const tmp = `${this.file}.tmp`
      writeFileSync(tmp, JSON.stringify({ days: Object.fromEntries(this.days), recent: this.recent, lifetime: this.lifetime }), {
        mode: 0o600,
      })
      renameSync(tmp, this.file)
    } catch {
      // 落盘失败不阻断
    }
  }
}

function rollingStart(now: number): number {
  const c = new Date(now)
  c.setMinutes(0, 0, 0)
  return c.getTime() - (HOURS - 1) * 3_600_000
}

function mergeInto(target: Record<string, Entry>, src: Record<string, Entry>): void {
  for (const [k, v] of Object.entries(src)) {
    const t = target[k]
    if (t === undefined) {
      target[k] = { ...emptyEntry(), ...v }
      continue
    }
    t.requests += v.requests
    t.ok += v.ok
    t.failed += v.failed
    t.promptTokens += v.promptTokens
    t.completionTokens += v.completionTokens
    t.cachedTokens += v.cachedTokens
    t.lastTs = Math.max(t.lastTs, v.lastTs)
  }
}

function top(map: Record<string, Entry>): RankRow[] {
  return Object.entries(map)
    .map(([name, e]) => ({
      name,
      requests: e.requests,
      ok: e.ok,
      failed: e.failed,
      promptTokens: e.promptTokens,
      completionTokens: e.completionTokens,
      lastTs: e.lastTs,
    }))
    .sort((a, b) => b.requests - a.requests || b.lastTs - a.lastTs)
    .slice(0, 10)
}
