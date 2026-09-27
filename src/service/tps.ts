/**
 * TPS 追踪（移植自 airtaxi/openchamber-tps 的思路，按本项目收敛为单文件）。
 *
 * 服务订阅 OpenChamber 的全局事件流 `GET <origin>/api/global/event`，按当前会话
 * 统计生成速率：近 5 秒的流式字符数 → 字符/秒 → 用「每字符 token 数」换算成
 * tok/s；每轮结束时用上游真实 token 数校准该系数。
 *
 * 面板只做两件事：告诉服务看哪个会话（`watch`），然后轮询快照。
 */
import type { TpsSnapshot, TpsTurn } from '../shared/types.ts'

const WINDOW_MS = 5_000
const SAMPLE_LIMIT = 20_000
const RETRY_BASE_MS = 1_000
const RETRY_MAX_MS = 15_000
const DEFAULT_CHARS_PER_TOKEN = 0.25
const MIN_CHARS_PER_TOKEN = 0.05
const MAX_CHARS_PER_TOKEN = 1
const CALIBRATION_WEIGHT = 0.3
const MIN_CALIBRATION_CHARS = 40
/** 字符间隔超过它就当「暂停」（工具调用/重试/等用户），不计入生成时间。 */
const MAX_STREAM_GAP_MS = 1_000

interface Sample {
  at: number
  chars: number
}

type ConnectionState = 'idle' | 'connecting' | 'live' | 'error'

interface WatchConfig {
  origin: string
  sessionId: string | null
  title: string | null
}

function readString(v: unknown): string {
  return typeof v === 'string' ? v : ''
}

function readNumber(v: unknown): number {
  const n = Number(v)
  return Number.isFinite(n) ? n : 0
}

function readRecord(v: unknown): Record<string, unknown> | undefined {
  return v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined
}

export class TpsTracker {
  private watch: WatchConfig | null = null
  private controller: AbortController | null = null
  private retryTimer: NodeJS.Timeout | null = null
  private retryDelay = RETRY_BASE_MS
  private connection: ConnectionState = 'idle'
  private lastError: string | null = null

  /** 近 5 秒的字符样本。 */
  private samples: Sample[] = []
  /** 每条助手消息累计的字符数（校准用）与已计数的 fragment。 */
  private messageChars = new Map<string, number>()
  private countedParts = new Set<string>()
  /** 每条消息已结算的 token（重试时按增量补差）。 */
  private stepTokens = new Map<string, number>()

  private charsPerToken = DEFAULT_CHARS_PER_TOKEN
  private turnChars = 0
  private turnTokens = 0
  private turnSawTokens = false
  private turnStartedAt: number | null = null
  private lastCharAt: number | null = null
  private activeMs = 0
  private lastTurn: TpsTurn | null = null

  private busy = false
  private pendingPermissions = new Set<string>()
  private pendingQuestions = new Set<string>()
  private sessionUsage: TpsSnapshot['sessionUsage'] = null
  private eventsSeen = 0
  private lastEventAt: number | null = null

  /** 换会话/换 origin：重连事件流。 */
  watchSession(config: WatchConfig): void {
    const same = this.watch !== null && this.watch.origin === config.origin && this.watch.sessionId === config.sessionId
    this.watch = config
    if (same) {
      this.watch.title = config.title
      return
    }
    this.resetSession()
    this.lastError = null
    this.connection = 'idle'
    void this.startStream()
  }

  stop(): void {
    this.watch = null
    this.controller?.abort()
    this.controller = null
    if (this.retryTimer !== null) {
      clearTimeout(this.retryTimer)
      this.retryTimer = null
    }
    this.connection = 'idle'
  }

  snapshot(): TpsSnapshot {
    const now = Date.now()
    const cutoff = now - WINDOW_MS
    while (this.samples.length > 0 && this.samples[0]!.at < cutoff) this.samples.shift()
    const chars = this.samples.reduce((n, s) => n + s.chars, 0)
    const charsPerSecond = chars / (WINDOW_MS / 1000)
    const waiting: TpsSnapshot['waiting'] = this.pendingPermissions.size > 0 ? 'permission' : this.pendingQuestions.size > 0 ? 'question' : null
    return {
      connection: this.connection,
      error: this.lastError,
      sessionId: this.watch?.sessionId ?? null,
      sessionTitle: this.watch?.title ?? null,
      busy: this.busy,
      waiting,
      windowMs: WINDOW_MS,
      chars,
      charsPerSecond: Math.round(charsPerSecond * 10) / 10,
      tokensPerSecond: Math.round(charsPerSecond * this.charsPerToken * 10) / 10,
      charsPerToken: Math.round(this.charsPerToken * 1000) / 1000,
      lastTurn: this.lastTurn,
      sessionUsage: this.sessionUsage,
      eventsSeen: this.eventsSeen,
      lastEventAt: this.lastEventAt,
    }
  }

  // -------------------------------------------------------------------------
  // 事件流
  // -------------------------------------------------------------------------

  private resetSession(): void {
    this.samples = []
    this.messageChars.clear()
    this.countedParts.clear()
    this.stepTokens.clear()
    this.turnChars = 0
    this.turnTokens = 0
    this.turnSawTokens = false
    this.turnStartedAt = null
    this.lastCharAt = null
    this.activeMs = 0
    this.lastTurn = null
    this.busy = false
    this.pendingPermissions.clear()
    this.pendingQuestions.clear()
    this.sessionUsage = null
    this.eventsSeen = 0
    this.lastEventAt = null
  }

  private scheduleReconnect(message: string): void {
    this.lastError = message
    this.connection = 'error'
    if (this.watch === null || this.retryTimer !== null) return
    const delay = this.retryDelay
    this.retryDelay = Math.min(RETRY_MAX_MS, this.retryDelay * 2)
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null
      void this.startStream()
    }, delay)
  }

  private async startStream(): Promise<void> {
    const current = this.watch
    if (current === null || current.sessionId === null) return
    if (this.retryTimer !== null) {
      clearTimeout(this.retryTimer)
      this.retryTimer = null
    }
    this.controller?.abort()
    const local = new AbortController()
    this.controller = local
    this.connection = 'connecting'

    try {
      const response = await fetch(new URL('/api/global/event', current.origin), {
        headers: { Accept: 'text/event-stream' },
        signal: local.signal,
      })
      if (!response.ok || response.body === null) {
        this.scheduleReconnect(`事件流返回 HTTP ${response.status}`)
        return
      }
      this.connection = 'live'
      this.retryDelay = RETRY_BASE_MS
      this.lastEventAt = Date.now()

      const reader = response.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''
      for (;;) {
        const { value, done } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        const chunks = buffer.split('\n\n')
        buffer = chunks.pop() ?? ''
        for (const chunk of chunks) this.handleSseChunk(chunk)
      }
      this.scheduleReconnect('事件流已断开')
    } catch (err) {
      if (local.signal.aborted) return
      this.scheduleReconnect((err as Error).message)
    }
  }

  private handleSseChunk(chunk: string): void {
    const data: string[] = []
    for (const line of chunk.split('\n')) {
      if (line.startsWith('data:')) data.push(line.slice(5).trimStart())
    }
    if (data.length === 0) return
    let parsed: unknown
    try {
      parsed = JSON.parse(data.join('\n'))
    } catch {
      return
    }
    const envelope = readRecord(parsed)
    if (envelope === undefined) return
    const inner = readRecord(envelope.payload) ?? envelope
    this.eventsSeen += 1
    this.handleEvent(inner, Date.now())
  }

  private isWatched(sessionId: string): boolean {
    return this.watch !== null && this.watch.sessionId !== null && sessionId === this.watch.sessionId
  }

  private recordChars(messageId: string, chars: number, now: number): void {
    if (chars <= 0) return
    this.samples.push({ at: now, chars })
    if (this.samples.length > SAMPLE_LIMIT) this.samples.splice(0, this.samples.length - SAMPLE_LIMIT)
    if (messageId !== '') this.messageChars.set(messageId, (this.messageChars.get(messageId) ?? 0) + chars)
    this.turnChars += chars
    // 生成时间：跳过超过 1s 的间隔（工具/重试/等用户）
    if (this.lastCharAt !== null && now - this.lastCharAt <= MAX_STREAM_GAP_MS) this.activeMs += now - this.lastCharAt
    this.lastCharAt = now
    this.lastEventAt = now
  }

  private calibrate(messageId: string, generated: number): void {
    if (messageId === '') return
    const chars = this.messageChars.get(messageId) ?? 0
    if (chars < MIN_CALIBRATION_CHARS || generated <= 0) return
    const ratio = Math.min(MAX_CHARS_PER_TOKEN, Math.max(MIN_CHARS_PER_TOKEN, generated / chars))
    this.charsPerToken = this.charsPerToken + (ratio - this.charsPerToken) * CALIBRATION_WEIGHT
  }

  private finalizeTurn(now: number): void {
    if (this.turnStartedAt === null && this.turnChars === 0) return
    const wallMs = this.turnStartedAt === null ? 0 : now - this.turnStartedAt
    const active = Math.max(this.activeMs, this.turnChars > 0 ? 1 : 0)
    const tokens = this.turnSawTokens ? this.turnTokens : this.turnChars * this.charsPerToken
    if (tokens > 0 && active > 0) {
      this.lastTurn = {
        tokensPerSecond: Math.round((tokens / (active / 1000)) * 10) / 10,
        tokens: Math.round(tokens),
        chars: this.turnChars,
        activeMs: Math.round(active),
        wallMs,
        pausedMs: Math.max(0, wallMs - Math.round(active)),
        endedAt: now,
        source: this.turnSawTokens ? 'tokens' : 'estimate',
      }
    }
    this.turnChars = 0
    this.turnTokens = 0
    this.turnSawTokens = false
    this.turnStartedAt = null
    this.lastCharAt = null
    this.activeMs = 0
  }

  private handleEvent(event: Record<string, unknown>, now: number): void {
    const type = readString(event.type)
    if (type === '') return
    const payload = readRecord(event.data) ?? readRecord(event.properties)
    if (payload === undefined) return
    this.lastEventAt = now

    if (type === 'session.text.delta' || type === 'session.reasoning.delta') {
      if (!this.isWatched(readString(payload.sessionID))) return
      const messageId = readString(payload.assistantMessageID)
      const delta = readString(payload.delta)
      if (delta === '') return
      const partId = `${messageId}:${type === 'session.reasoning.delta' ? 'r' : 't'}:${String(payload.ordinal ?? '')}`
      this.countedParts.add(partId)
      this.recordChars(messageId, delta.length, now)
      return
    }

    if (type === 'session.text.ended' || type === 'session.reasoning.ended') {
      if (!this.isWatched(readString(payload.sessionID))) return
      const messageId = readString(payload.assistantMessageID)
      const partId = `${messageId}:${type === 'session.reasoning.ended' ? 'r' : 't'}:${String(payload.ordinal ?? '')}`
      if (this.countedParts.has(partId)) return
      const text = readString(payload.text)
      if (text === '') return
      this.recordChars(messageId, text.length, now)
      return
    }

    if (type === 'session.step.ended' || type === 'session.step.failed') {
      if (!this.isWatched(readString(payload.sessionID))) return
      const tokens = readRecord(payload.tokens)
      if (tokens === undefined) return
      const messageId = readString(payload.assistantMessageID)
      const generated = readNumber(tokens.output) + readNumber(tokens.reasoning)
      if (generated <= 0) return
      this.calibrate(messageId, generated)
      const previous = this.stepTokens.get(messageId) ?? 0
      this.stepTokens.set(messageId, generated)
      this.turnTokens += generated - previous
      if (generated > previous) this.turnSawTokens = true
      return
    }

    if (type === 'session.usage.updated') {
      if (!this.isWatched(readString(payload.sessionID))) return
      const tokens = readRecord(payload.tokens)
      if (tokens === undefined) return
      const cache = readRecord(tokens.cache)
      const output = readNumber(tokens.output)
      const reasoning = readNumber(tokens.reasoning)
      this.sessionUsage = {
        cost: readNumber(payload.cost),
        input: readNumber(tokens.input),
        output,
        reasoning,
        cacheRead: readNumber(cache?.read),
        cacheWrite: readNumber(cache?.write),
        generated: output + reasoning,
      }
      return
    }

    if (type === 'session.execution.started') {
      if (!this.isWatched(readString(payload.sessionID))) return
      if (this.turnStartedAt === null) this.turnStartedAt = now
      this.busy = true
      return
    }

    if (type === 'session.execution.succeeded' || type === 'session.execution.failed') {
      if (!this.isWatched(readString(payload.sessionID))) return
      this.busy = false
      this.finalizeTurn(now)
      return
    }

    if (type === 'session.execution.interrupted') {
      if (!this.isWatched(readString(payload.sessionID))) return
      if (readString(payload.reason) === 'shutdown') return
      this.busy = false
      this.finalizeTurn(now)
      return
    }

    if (type === 'session.idle') {
      if (!this.isWatched(readString(payload.sessionID))) return
      this.busy = false
      this.finalizeTurn(now)
      return
    }

    if (type === 'permission.asked' || type === 'permission.v2.asked') {
      if (!this.isWatched(readString(payload.sessionID))) return
      const id = readString(payload.id)
      if (id !== '') this.pendingPermissions.add(id)
      return
    }
    if (type === 'permission.replied' || type === 'permission.v2.replied') {
      if (!this.isWatched(readString(payload.sessionID))) return
      this.pendingPermissions.delete(readString(payload.requestID))
      return
    }
    if (type === 'form.created') {
      const form = readRecord(payload.form)
      if (form === undefined || !this.isWatched(readString(form.sessionID))) return
      const id = readString(form.id)
      if (id !== '') this.pendingQuestions.add(id)
      return
    }
    if (type === 'form.replied' || type === 'form.cancelled') {
      if (!this.isWatched(readString(payload.sessionID))) return
      this.pendingQuestions.delete(readString(payload.id))
      return
    }
    if (type === 'question.asked' || type === 'question.v2.asked') {
      if (!this.isWatched(readString(payload.sessionID))) return
      const id = readString(payload.id)
      if (id !== '') this.pendingQuestions.add(id)
      return
    }
    if (type === 'question.replied' || type === 'question.rejected' || type === 'question.v2.replied' || type === 'question.v2.rejected') {
      if (!this.isWatched(readString(payload.sessionID))) return
      this.pendingQuestions.delete(readString(payload.requestID))
    }
  }

  dispose(): void {
    this.stop()
  }
}
