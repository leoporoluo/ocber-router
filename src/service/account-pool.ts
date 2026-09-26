/**
 * 账号池 —— 选号、冷却、遍历回退（移植自 dsh-router，按本项目需要收敛）。
 *
 * 策略表在这里，供应商插件只报「这次失败是什么语义」，不决定冷却多久。
 *  - rate_limit → 指数退避（2s 起，翻倍，封顶 5 分钟）
 *  - quota      → 固定 10 分钟
 *  - session_dead → 连接级冷却 30 分钟（403 分不清凭证死活与风控，不永久禁用）
 *  - unavailable / transport / unknown → 瞬时 30s（每次都冷）
 *  - no_such_model / bad_request → 不冷不记（不是账号的错）
 *
 * 选号：优先前缀亲和（同一会话/前缀固定同一个号，前缀缓存只写一份），
 * 无指纹时按游标轮转。冷却按 (model, uid) 记，session_dead 按 uid 记。
 */
import { createHash } from 'node:crypto'

import type { AccountState, SupplierAccountNow } from './suppliers/codebuddy/contract.ts'

interface Rule {
  cooldown: number | 'transient' | 'backoff'
  counts: boolean
}

const MINUTE = 60_000
const SESSION_DEAD_COOLDOWN_MS = 30 * MINUTE
const TRANSIENT_COOLDOWN_MS = 30_000
const BACKOFF_BASE_MS = 2_000
const BACKOFF_MAX_MS = 5 * MINUTE
const BACKOFF_MAX_LEVEL = 15
const AFFINITY_MAX = 256

const RULES: Record<AccountState, Rule> = {
  ok: { cooldown: 0, counts: false },
  rate_limit: { cooldown: 'backoff', counts: false },
  quota: { cooldown: 10 * MINUTE, counts: false },
  session_dead: { cooldown: SESSION_DEAD_COOLDOWN_MS, counts: false },
  unavailable: { cooldown: 'transient', counts: false },
  transport: { cooldown: 'transient', counts: false },
  unknown: { cooldown: 'transient', counts: false },
  no_such_model: { cooldown: 0, counts: false },
  bad_request: { cooldown: 0, counts: false },
}

interface CooldownEntry {
  until: number
  backoffLevel: number
  reason: string
}

interface UidEntry {
  until: number
  reason: string
}

const SEP = '\u0000'

function backoffMs(level: number): number {
  return Math.min(BACKOFF_BASE_MS * 2 ** Math.max(0, level - 1), BACKOFF_MAX_MS)
}

/** 请求前缀指纹：有 messages 就取它的稳定摘要；算不出返回 ''。 */
export function prefixFingerprint(messages: unknown): string {
  if (!Array.isArray(messages) || messages.length === 0) return ''
  try {
    const head = messages.slice(0, 6).map((m) => {
      if (m === null || typeof m !== 'object') return String(m)
      const msg = m as Record<string, unknown>
      const content = msg.content
      const text =
        typeof content === 'string'
          ? content.slice(0, 2000)
          : Array.isArray(content)
            ? JSON.stringify(content).slice(0, 2000)
            : ''
      return `${String(msg.role ?? '')}:${text}`
    })
    return createHash('sha1').update(head.join('\n')).digest('hex').slice(0, 16)
  } catch {
    return ''
  }
}

export class AccountPool {
  private supplierId: string
  private cooldowns = new Map<string, CooldownEntry>()
  private byUid = new Map<string, UidEntry>()
  private affinity = new Map<string, Map<string, string>>()
  private rrCursor = 0
  /** 上一次选号理由（诊断用）。 */
  lastWhy = ''

  constructor(supplierId: string) {
    this.supplierId = supplierId
  }

  private key(model: string, uid: string): string {
    return `${this.supplierId}${SEP}${model}${SEP}${uid}`
  }

  private blockKey(model: string): string {
    return `${this.supplierId}${SEP}${model}`
  }

  private entry(model: string, uid: string): CooldownEntry {
    const k = this.key(model, uid)
    let e = this.cooldowns.get(k)
    if (e === undefined) {
      e = { until: 0, backoffLevel: 0, reason: '' }
      this.cooldowns.set(k, e)
    }
    return e
  }

  private healthy(uid: string, model: string, now: number): boolean {
    const u = this.byUid.get(uid)
    if (u !== undefined && u.until > now) return false
    const c = this.cooldowns.get(this.key(model, uid))
    return c === undefined || c.until <= now
  }

  /** 按池顺序排序账号（未配置顺序的按供应商自然顺序追加）。 */
  private ordered(accounts: SupplierAccountNow[], poolOrder: string[]): string[] {
    const present = new Set(accounts.map((a) => a.uid))
    const ordered = poolOrder.filter((uid) => present.has(uid))
    for (const a of accounts) if (!ordered.includes(a.uid)) ordered.push(a.uid)
    return ordered
  }

  /**
   * 为某模型给出**尝试顺序**（健康号）：亲和命中的号排第一，其余按「空闲优先 +
   * 游标推进」铺开。核心按这个顺序逐个尝试，失败一个换下一个。
   * @param messages 请求体 messages（算前缀指纹）
   */
  candidates(
    accounts: SupplierAccountNow[],
    poolOrder: string[],
    modelId: string,
    messages?: unknown,
  ): string[] {
    const now = Date.now()
    const ordered = this.ordered(accounts, poolOrder)
    const healthy = ordered.filter((uid) => this.healthy(uid, modelId, now))
    if (healthy.length === 0) {
      this.lastWhy = '全池无健康号（都在冷却）'
      return []
    }

    const fp = prefixFingerprint(messages)
    if (fp !== '') {
      const bound = this.affinity.get(this.blockKey(modelId))?.get(fp)
      if (bound !== undefined && healthy.includes(bound)) {
        this.lastWhy = `亲和命中 ${bound}`
        return [bound, ...healthy.filter((uid) => uid !== bound)]
      }
    }

    // 新指纹/绑定的号不可用：优先铺到未被其它前缀占用的号，否则按游标复用。
    const taken = new Set(this.affinity.get(this.blockKey(modelId))?.values() ?? [])
    const free = fp === '' ? healthy : healthy.filter((uid) => !taken.has(uid))
    const rotated = free.length > 0 ? free : healthy
    const start = this.rrCursor % rotated.length
    const sequence = [...rotated.slice(start), ...rotated.slice(0, start)]
    this.rrCursor = (this.rrCursor + 1) % rotated.length
    if (fp !== '' && sequence.length > 0) this.bind(modelId, fp, sequence[0]!)
    this.lastWhy = free.length === 0 ? `号已铺满，复用 ${sequence[0] ?? ''}` : `铺开到 ${sequence[0] ?? ''}`
    return sequence
  }

  /** 为某模型选一个健康账号（candidates 的第一个）。 */
  pick(
    accounts: SupplierAccountNow[],
    poolOrder: string[],
    modelId: string,
    messages?: unknown,
  ): string | undefined {
    return this.candidates(accounts, poolOrder, modelId, messages)[0]
  }

  private bind(modelId: string, fp: string, uid: string): void {
    const k = this.blockKey(modelId)
    let m = this.affinity.get(k)
    if (m === undefined) {
      m = new Map()
      this.affinity.set(k, m)
    }
    m.delete(fp)
    m.set(fp, uid)
    if (m.size > AFFINITY_MAX) {
      const oldest = m.keys().next().value
      if (oldest !== undefined) m.delete(oldest)
    }
  }

  /** 记录一次失败：按状态冷却。 */
  noteFailure(uid: string, modelId: string, state: AccountState, message: string): void {
    const rule = RULES[state]
    if (rule.cooldown === 0) return
    if (state === 'session_dead') {
      const e = this.byUid.get(uid) ?? { until: 0, reason: '' }
      e.until = Math.max(e.until, Date.now() + SESSION_DEAD_COOLDOWN_MS)
      e.reason = message
      this.byUid.set(uid, e)
      return
    }
    const e = this.entry(modelId, uid)
    e.reason = message
    if (rule.cooldown === 'backoff') {
      e.backoffLevel = Math.min(e.backoffLevel + 1, BACKOFF_MAX_LEVEL)
      e.until = Math.max(e.until, Date.now() + backoffMs(e.backoffLevel))
      return
    }
    if (rule.cooldown === 'transient') {
      e.until = Math.max(e.until, Date.now() + TRANSIENT_COOLDOWN_MS)
      return
    }
    e.until = Math.max(e.until, Date.now() + rule.cooldown)
  }

  /** 记录一次成功：清零该模型的退避等级。 */
  noteSuccess(uid: string, modelId: string): void {
    const e = this.cooldowns.get(this.key(modelId, uid))
    if (e !== undefined) e.backoffLevel = 0
  }

  /** 手动暂停整连接（跨模型）。until<=now 表示解除。 */
  cooldown(uid: string, untilMs: number, reason: string): void {
    const e = this.byUid.get(uid) ?? { until: 0, reason: '' }
    e.until = untilMs
    e.reason = reason
    this.byUid.set(uid, e)
    for (const [k, ce] of this.cooldowns) if (k.endsWith(`${SEP}${uid}`)) ce.backoffLevel = 0
  }

  /** 把冷却叠加到「现在状态」上，产出面板态。 */
  decorate(accounts: SupplierAccountNow[]): Array<SupplierAccountNow & { cooling: boolean; err_count: number; until?: string; reason?: string }> {
    const now = Date.now()
    return accounts.map((a) => {
      const u = this.byUid.get(a.uid)
      const uidCooling = u !== undefined && u.until > now
      let cooling = uidCooling
      let maxUntil = uidCooling ? u!.until : 0
      let reason = uidCooling ? u!.reason : undefined
      let err = 0
      for (const [k, ce] of this.cooldowns) {
        if (!k.endsWith(`${SEP}${a.uid}`)) continue
        if (ce.until > now) {
          cooling = true
          if (ce.until > maxUntil) {
            maxUntil = ce.until
            reason = ce.reason
          }
        }
        if (ce.backoffLevel > err) err = ce.backoffLevel
      }
      return { ...a, cooling, err_count: err, until: cooling && maxUntil > 0 ? new Date(maxUntil).toISOString() : undefined, reason: reason !== '' ? reason : undefined }
    })
  }
}
