/**
 * OpenAI 兼容对话管线：解析请求 → 组合/别名解析 → 账号池逐个尝试 →
 * 流式透传（重写 model、提取 usage）或聚合成非流式 JSON。
 *
 * 上游（CodeBuddy / WorkBuddy）只支持流式，所以这里**一律对上游请求
 * stream:true**；客户端要非流式时由本层聚合。
 */
import { randomBytes } from 'node:crypto'
import type { ServerResponse } from 'node:http'

import type { App } from './app.ts'
import { EMPTY_USAGE, type Usage } from './usage.ts'
import type { AccountState } from './suppliers/codebuddy/contract.ts'

interface ChatBody {
  model?: unknown
  stream?: unknown
  messages?: unknown
  [key: string]: unknown
}

/**
 * 客户端显式要求的推理等级（OpenCode variant settings → `reasoning_effort`）。
 * 只放行上游认得的档位；其余（含 auto/off/none/空）交给上游默认行为。
 */
const REASONING_LEVELS = new Set(['minimal', 'low', 'medium', 'high', 'xhigh', 'max'])

function readReasoningLevel(body: ChatBody): string {
  const raw = body.reasoning_effort ?? body.reasoningEffort
  if (typeof raw !== 'string') return 'auto'
  const level = raw.trim().toLowerCase()
  return REASONING_LEVELS.has(level) ? level : 'auto'
}

export function writeJson(res: ServerResponse, status: number, value: unknown): void {
  const body = JSON.stringify(value)
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body) })
  res.end(body)
}

function errorBody(message: string, type: string): unknown {
  return { error: { message, type, param: null, code: null } }
}

function num(v: unknown): number {
  const n = Number(v)
  return Number.isFinite(n) ? n : 0
}

/** 把上游 usage 合并进来（分散多帧时按字段取最大值）。 */
function mergeUsage(acc: Usage, raw: unknown): void {
  if (raw === null || typeof raw !== 'object') return
  const u = raw as Record<string, unknown>
  const prompt = num(u.prompt_tokens ?? u.input_tokens)
  const completion = num(u.completion_tokens ?? u.output_tokens)
  const details = u.prompt_tokens_details as Record<string, unknown> | undefined
  const cached = num(details?.cached_tokens ?? u.cache_read_input_tokens ?? u.cached_tokens)
  if (prompt > acc.promptTokens) acc.promptTokens = prompt
  if (completion > acc.completionTokens) acc.completionTokens = completion
  if (cached > acc.cachedTokens) acc.cachedTokens = cached
  if (prompt > 0) acc.inputEstimated = false
  if (completion > 0) acc.outputEstimated = false
}

/** 扣掉 token 估算（上游不报 usage 时）。 */
function estimate(acc: Usage, rawBody: string, textLength: number): void {
  if (acc.promptTokens === 0) {
    acc.promptTokens = Math.max(1, Math.round(rawBody.length / 4))
    acc.inputEstimated = true
  }
  if (acc.completionTokens === 0) {
    acc.completionTokens = textLength > 0 ? Math.max(1, Math.round(textLength / 4)) : 0
    acc.outputEstimated = true
  }
}

interface ToolCall {
  id?: string
  type?: string
  name?: string
  arguments: string
}

/** 上游 SSE 的累积器（流式转发与非流式聚合共用）。 */
class ChatAccumulator {
  content = ''
  reasoning = ''
  toolCalls = new Map<number, ToolCall>()
  finishReason: string | null = null
  role = 'assistant'
  error: string | null = null
  usage: Usage = { ...EMPTY_USAGE }
  sawChunk = false

  absorb(obj: unknown): void {
    if (obj === null || typeof obj !== 'object') return
    const chunk = obj as Record<string, unknown>
    if (typeof chunk.model === 'string') this.usage = { ...this.usage }
    if (chunk.usage !== undefined) mergeUsage(this.usage, chunk.usage)
    const err = chunk.error
    if (err !== null && typeof err === 'object') {
      const e = err as Record<string, unknown>
      this.error = typeof e.message === 'string' ? e.message : JSON.stringify(err)
    } else if (typeof err === 'string') {
      this.error = err
    }
    const choices = chunk.choices
    if (!Array.isArray(choices)) return
    for (const c of choices) {
      if (c === null || typeof c !== 'object') continue
      const choice = c as Record<string, unknown>
      if (typeof choice.finish_reason === 'string') this.finishReason = choice.finish_reason
      const delta = (choice.delta ?? choice.message) as Record<string, unknown> | undefined
      if (delta === null || typeof delta !== 'object') continue
      this.sawChunk = true
      if (typeof delta.role === 'string') this.role = delta.role
      this.content += readText(delta.content)
      this.reasoning += readText(delta.reasoning_content ?? delta.reasoning)
      const calls = delta.tool_calls
      if (Array.isArray(calls)) {
        for (const raw of calls) {
          if (raw === null || typeof raw !== 'object') continue
          const tc = raw as Record<string, unknown>
          const index = Number.isFinite(Number(tc.index)) ? Number(tc.index) : this.toolCalls.size
          const cur = this.toolCalls.get(index) ?? { arguments: '' }
          if (typeof tc.id === 'string') cur.id = tc.id
          if (typeof tc.type === 'string') cur.type = tc.type
          const fn = tc.function as Record<string, unknown> | undefined
          if (fn !== null && typeof fn === 'object') {
            if (typeof fn.name === 'string') cur.name = fn.name
            if (typeof fn.arguments === 'string') cur.arguments += fn.arguments
          }
          this.toolCalls.set(index, cur)
        }
      }
    }
  }

  textLength(): number {
    return this.content.length + this.reasoning.length
  }

  message(): Record<string, unknown> {
    const msg: Record<string, unknown> = { role: this.role, content: this.content === '' ? null : this.content }
    if (this.reasoning !== '') msg.reasoning_content = this.reasoning
    if (this.toolCalls.size > 0) {
      msg.tool_calls = [...this.toolCalls.entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([index, tc]) => ({
          index,
          id: tc.id ?? `call_${randomBytes(6).toString('hex')}`,
          type: tc.type ?? 'function',
          function: { name: tc.name ?? '', arguments: tc.arguments },
        }))
    }
    return msg
  }

  hasOutput(): boolean {
    return this.content !== '' || this.reasoning !== '' || this.toolCalls.size > 0
  }
}

function readText(v: unknown): string {
  if (typeof v === 'string') return v
  if (Array.isArray(v)) {
    let out = ''
    for (const part of v) {
      if (part === null || typeof part !== 'object') continue
      const p = part as Record<string, unknown>
      if (typeof p.text === 'string') out += p.text
      else if (typeof p.content === 'string') out += p.content
    }
    return out
  }
  return ''
}

interface StreamOutcome {
  ttfbMs: number
  aborted: boolean
}

/** 流式透传：逐行解析上游 SSE，重写 model，边写边累积。 */
async function streamToClient(
  res: ServerResponse,
  upstream: ReadableStream<Uint8Array>,
  requested: string,
  acc: ChatAccumulator,
): Promise<StreamOutcome> {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  })

  let aborted = false
  res.on('close', () => {
    if (!res.writableEnded) aborted = true
  })

  const reader = upstream.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let ttfbMs = 0
  let sentDone = false
  const started = Date.now()

  const handleLine = (line: string): void => {
    const clean = line.endsWith('\r') ? line.slice(0, -1) : line
    if (!clean.startsWith('data:')) return
    const payload = clean.slice(5).trim()
    if (payload === '') return
    if (payload === '[DONE]') {
      sentDone = true
      res.write('data: [DONE]\n\n')
      return
    }
    let obj: Record<string, unknown>
    try {
      obj = JSON.parse(payload) as Record<string, unknown>
    } catch {
      res.write(`${clean}\n\n`)
      return
    }
    acc.absorb(obj)
    if (typeof obj.model === 'string') obj.model = requested
    if (ttfbMs === 0 && acc.hasOutput()) ttfbMs = Date.now() - started
    res.write(`data: ${JSON.stringify(obj)}\n\n`)
  }

  try {
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      if (aborted) {
        void reader.cancel().catch(() => {})
        break
      }
      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''
      for (const line of lines) handleLine(line)
    }
    if (buffer !== '' && !aborted) handleLine(buffer)
    if (!sentDone && !aborted) res.write('data: [DONE]\n\n')
  } catch {
    // 上游中途断流：已提交的响应只能就此收尾
  }
  if (!res.writableEnded) res.end()
  return { ttfbMs: ttfbMs === 0 ? Date.now() - started : ttfbMs, aborted }
}

/** 非流式：把上游 SSE 读干、聚合成一条消息。 */
async function collectFromUpstream(upstream: ReadableStream<Uint8Array>, acc: ChatAccumulator): Promise<void> {
  const reader = upstream.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  for (;;) {
    const { value, done } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    const lines = buffer.split('\n')
    buffer = lines.pop() ?? ''
    for (const line of lines) absorbLine(line, acc)
  }
  if (buffer !== '') absorbLine(buffer, acc)
}

function absorbLine(line: string, acc: ChatAccumulator): void {
  const clean = line.endsWith('\r') ? line.slice(0, -1) : line
  if (!clean.startsWith('data:')) return
  const payload = clean.slice(5).trim()
  if (payload === '' || payload === '[DONE]') return
  try {
    acc.absorb(JSON.parse(payload))
  } catch {
    // 忽略非 JSON 心跳
  }
}

/** 处理一次 /v1/chat/completions。 */
export async function handleChat(app: App, res: ServerResponse, body: ChatBody): Promise<void> {
  const requested = typeof body.model === 'string' ? body.model : ''
  if (requested === '') {
    writeJson(res, 400, errorBody('缺少 model 字段', 'invalid_request_error'))
    return
  }
  const targets = app.resolveTargets(requested)
  if (targets.length === 0) {
    writeJson(res, 404, errorBody(`未知模型：${requested}`, 'model_not_found'))
    return
  }

  const stream = body.stream === true
  const messages = body.messages
  const rawBody = JSON.stringify(body)
  // 客户端（OpenCode 变体 / 直连调用）显式要求的推理等级；auto = 不请求推理。
  const level = readReasoningLevel(body)

  let lastState: AccountState = 'unknown'
  let lastMessage = '没有可用账号'

  for (const target of targets) {
    const runtime = app.runtimeById(target.supplierId)
    if (runtime === undefined) continue
    const accounts = runtime.module.status().accounts
    const order = runtime.pool.candidates(
      accounts,
      app.config.get(target.supplierId).poolOrder,
      target.model,
      messages,
    )
    if (order.length === 0) {
      lastState = 'unknown'
      lastMessage = `${target.supplierId}/${target.model}：全部账号冷却中`
      continue
    }

    for (const uid of order) {
      const started = Date.now()
      let result
      try {
        result = await runtime.module.chatOnce(uid, level, { rawBody, stream: true, model: target.model })
      } catch (err) {
        runtime.pool.noteFailure(uid, target.model, 'transport', (err as Error).message)
        lastState = 'transport'
        lastMessage = (err as Error).message
        continue
      }

      if (result.ok && 'stream' in result) {
        const acc = new ChatAccumulator()
        if (stream) {
          const outcome = await streamToClient(res, result.stream, requested, acc)
          runtime.pool.noteSuccess(uid, target.model)
          estimate(acc.usage, rawBody, acc.textLength())
          app.usage.record(
            {
              supplier: target.supplierId,
              model: target.model,
              requested,
              ok: true,
              durationMs: Date.now() - started,
              ttfbMs: outcome.ttfbMs,
              uid,
            },
            acc.usage,
          )
          return
        }
        await collectFromUpstream(result.stream, acc)
        if ((acc.error !== null && !acc.hasOutput()) || (!acc.hasOutput() && acc.finishReason === null)) {
          runtime.pool.noteFailure(uid, target.model, 'unknown', acc.error ?? '上游空响应')
          lastState = 'unknown'
          lastMessage = acc.error ?? '上游空响应'
          continue
        }
        runtime.pool.noteSuccess(uid, target.model)
        estimate(acc.usage, rawBody, acc.textLength())
        app.usage.record(
          {
            supplier: target.supplierId,
            model: target.model,
            requested,
            ok: true,
            durationMs: Date.now() - started,
            ttfbMs: 0,
            uid,
          },
          acc.usage,
        )
        writeJson(res, 200, {
          id: `chatcmpl-${randomBytes(8).toString('hex')}`,
          object: 'chat.completion',
          created: Math.floor(Date.now() / 1000),
          model: requested,
          choices: [{ index: 0, message: acc.message(), finish_reason: acc.finishReason ?? 'stop', logprobs: null }],
          usage: {
            prompt_tokens: acc.usage.promptTokens,
            completion_tokens: acc.usage.completionTokens,
            total_tokens: acc.usage.promptTokens + acc.usage.completionTokens,
            prompt_tokens_details: { cached_tokens: acc.usage.cachedTokens },
          },
        })
        return
      }

      if (result.ok && 'body' in result) {
        try {
          writeJson(res, result.status, JSON.parse(result.body))
        } catch {
          writeJson(res, result.status, { raw: result.body })
        }
        runtime.pool.noteSuccess(uid, target.model)
        return
      }

      if (!result.ok) {
        runtime.pool.noteFailure(uid, target.model, result.state, result.message)
        lastState = result.state
        lastMessage = result.message
        if (result.state === 'no_such_model' || result.state === 'bad_request') break
      }
    }
  }

  app.usage.record(
    { supplier: targets[0]?.supplierId ?? '', model: '', requested, ok: false, durationMs: 0, ttfbMs: 0, error: lastMessage },
    { ...EMPTY_USAGE },
  )
  writeJson(res, 503, errorBody(`全部候选失败：${lastMessage}`, lastState === 'session_dead' ? 'auth_error' : 'upstream_error'))
}
