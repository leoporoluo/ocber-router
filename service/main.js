// src/service/server.ts
import http from "node:http";
import { brotliDecompressSync, gunzipSync, inflateSync } from "node:zlib";

// src/service/chat.ts
import { randomBytes } from "node:crypto";

// src/service/usage.ts
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
var EMPTY_USAGE = {
  promptTokens: 0,
  completionTokens: 0,
  cachedTokens: 0,
  inputEstimated: false,
  outputEstimated: false
};
var RING_CAP = 500;
var HOURS = 24;
var KEEP_DAYS = 30;
var SAVE_DEBOUNCE_MS = 2000;
var emptyCounters = () => ({
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
  estimatedOutputs: 0
});
var emptyEntry = () => ({
  requests: 0,
  ok: 0,
  failed: 0,
  promptTokens: 0,
  completionTokens: 0,
  cachedTokens: 0,
  lastTs: 0
});
var emptyDay = () => ({
  ...emptyCounters(),
  hours: Array.from({ length: HOURS }, () => emptyCounters()),
  bySupplier: {},
  byModel: {},
  byRequested: {}
});
function localDateKey(ts) {
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

class UsageStore {
  file;
  days = new Map;
  recent = [];
  lifetime = 0;
  timer = null;
  constructor(dataDir) {
    this.file = join(dataDir, "usage.json");
    this.load();
  }
  record(r, usage) {
    if (r.ok && usage.promptTokens === 0 && usage.completionTokens === 0)
      return;
    const ts = r.ts ?? Date.now();
    const rec = {
      ...r,
      ts,
      promptTokens: usage.promptTokens,
      completionTokens: usage.completionTokens,
      cachedTokens: usage.cachedTokens
    };
    const key = localDateKey(ts);
    let day = this.days.get(key);
    if (day === undefined) {
      day = emptyDay();
      this.days.set(key, day);
    }
    this.bumpCounters(day, rec, usage);
    const h = day.hours[new Date(ts).getHours()];
    if (h !== undefined)
      this.bumpCounters(h, rec, usage);
    this.bump(day.bySupplier, rec.supplier, rec);
    this.bump(day.byModel, rec.model, rec);
    this.bump(day.byRequested, rec.requested, rec);
    this.recent.unshift(rec);
    if (this.recent.length > RING_CAP)
      this.recent.length = RING_CAP;
    this.lifetime += 1;
    this.scheduleSave();
  }
  bumpCounters(b, rec, usage) {
    b.requests += 1;
    if (rec.ok)
      b.ok += 1;
    else
      b.failed += 1;
    b.promptTokens += usage.promptTokens;
    b.completionTokens += usage.completionTokens;
    b.cachedTokens += usage.cachedTokens;
    b.durationMs += rec.durationMs;
    if (rec.ttfbMs > 0) {
      b.ttfbMs += rec.ttfbMs;
      b.ttfbCount += 1;
    }
    if (usage.inputEstimated)
      b.estimatedInputs += 1;
    if (usage.outputEstimated)
      b.estimatedOutputs += 1;
  }
  bump(map, key, rec) {
    if (key === "")
      return;
    const e = map[key] ?? emptyEntry();
    e.requests += 1;
    if (rec.ok)
      e.ok += 1;
    else
      e.failed += 1;
    e.promptTokens += rec.promptTokens;
    e.completionTokens += rec.completionTokens;
    e.cachedTokens += rec.cachedTokens;
    e.lastTs = Math.max(e.lastTs, rec.ts);
    map[key] = e;
  }
  stats(period, now = Date.now()) {
    const acc = emptyCounters();
    const bySupplier = {};
    const byModel = {};
    const byRequested = {};
    const addDay = (d) => {
      acc.requests += d.requests;
      acc.ok += d.ok;
      acc.failed += d.failed;
      acc.promptTokens += d.promptTokens;
      acc.completionTokens += d.completionTokens;
      acc.cachedTokens += d.cachedTokens;
      acc.durationMs += d.durationMs;
      acc.ttfbMs += d.ttfbMs;
      acc.ttfbCount += d.ttfbCount;
      acc.estimatedInputs += d.estimatedInputs;
      acc.estimatedOutputs += d.estimatedOutputs;
      mergeInto(bySupplier, d.bySupplier);
      mergeInto(byModel, d.byModel);
      mergeInto(byRequested, d.byRequested);
    };
    if (period === "today") {
      const d = this.days.get(localDateKey(now));
      if (d !== undefined)
        addDay(d);
    } else if (period === "24h") {
      const start = rollingStart(now);
      for (let i = 0;i < HOURS; i += 1) {
        const ts = start + i * 3600000;
        const d = this.days.get(localDateKey(ts));
        const h = d?.hours[new Date(ts).getHours()];
        if (h === undefined)
          continue;
        acc.requests += h.requests;
        acc.ok += h.ok;
        acc.failed += h.failed;
        acc.promptTokens += h.promptTokens;
        acc.completionTokens += h.completionTokens;
        acc.cachedTokens += h.cachedTokens;
        acc.durationMs += h.durationMs;
        acc.ttfbMs += h.ttfbMs;
        acc.ttfbCount += h.ttfbCount;
        acc.estimatedInputs += h.estimatedInputs;
        acc.estimatedOutputs += h.estimatedOutputs;
      }
      for (const key of new Set(Array.from({ length: HOURS }, (_, i) => localDateKey(start + i * 3600000)))) {
        const d = this.days.get(key);
        if (d === undefined)
          continue;
        mergeInto(bySupplier, d.bySupplier);
        mergeInto(byModel, d.byModel);
        mergeInto(byRequested, d.byRequested);
      }
    } else {
      const days = period === "7d" ? 7 : 30;
      for (let i = days - 1;i >= 0; i -= 1) {
        const d = this.days.get(localDateKey(now - i * 86400000));
        if (d !== undefined)
          addDay(d);
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
      byRequested: top(byRequested)
    };
  }
  chart(period, now = Date.now()) {
    const p = (n) => String(n).padStart(2, "0");
    if (period === "today" || period === "24h") {
      const first = period === "today" ? new Date(now).setHours(0, 0, 0, 0) : rollingStart(now);
      const out2 = [];
      for (let i = 0;i < HOURS; i += 1) {
        const start = first + i * 3600000;
        const h = this.days.get(localDateKey(start))?.hours[new Date(start).getHours()];
        out2.push({
          label: `${p(new Date(start).getHours())}:00`,
          requests: h?.requests ?? 0,
          tokens: (h?.promptTokens ?? 0) + (h?.completionTokens ?? 0)
        });
      }
      return out2;
    }
    const days = period === "7d" ? 7 : 30;
    const out = [];
    for (let i = days - 1;i >= 0; i -= 1) {
      const ts = now - i * 86400000;
      const d = this.days.get(localDateKey(ts));
      out.push({
        label: localDateKey(ts).slice(5),
        requests: d?.requests ?? 0,
        tokens: (d?.promptTokens ?? 0) + (d?.completionTokens ?? 0)
      });
    }
    return out;
  }
  recentList(limit = 20) {
    return this.recent.slice(0, limit);
  }
  lastHit() {
    return this.recent[0];
  }
  clear() {
    this.days.clear();
    this.recent = [];
    this.lifetime = 0;
    this.save();
  }
  flush() {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.save();
  }
  scheduleSave() {
    if (this.timer !== null)
      return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.save();
    }, SAVE_DEBOUNCE_MS);
    this.timer.unref?.();
  }
  load() {
    try {
      const f = JSON.parse(readFileSync(this.file, "utf8"));
      this.days = new Map(Object.entries(f.days ?? {}));
      this.recent = Array.isArray(f.recent) ? f.recent.slice(0, RING_CAP) : [];
      this.lifetime = typeof f.lifetime === "number" ? f.lifetime : 0;
      for (const [k, d] of this.days) {
        const day = { ...emptyDay(), ...d };
        day.hours = Array.from({ length: HOURS }, (_, i) => ({ ...emptyCounters(), ...d.hours?.[i] }));
        this.days.set(k, day);
      }
    } catch {}
  }
  save() {
    const cutoff = localDateKey(Date.now() - KEEP_DAYS * 86400000);
    for (const k of [...this.days.keys()])
      if (k < cutoff)
        this.days.delete(k);
    try {
      const dir = dirname(this.file);
      if (dir !== "" && dir !== ".")
        mkdirSync(dir, { recursive: true });
      const tmp = `${this.file}.tmp`;
      writeFileSync(tmp, JSON.stringify({ days: Object.fromEntries(this.days), recent: this.recent, lifetime: this.lifetime }), {
        mode: 384
      });
      renameSync(tmp, this.file);
    } catch {}
  }
}
function rollingStart(now) {
  const c = new Date(now);
  c.setMinutes(0, 0, 0);
  return c.getTime() - (HOURS - 1) * 3600000;
}
function mergeInto(target, src) {
  for (const [k, v] of Object.entries(src)) {
    const t = target[k];
    if (t === undefined) {
      target[k] = { ...emptyEntry(), ...v };
      continue;
    }
    t.requests += v.requests;
    t.ok += v.ok;
    t.failed += v.failed;
    t.promptTokens += v.promptTokens;
    t.completionTokens += v.completionTokens;
    t.cachedTokens += v.cachedTokens;
    t.lastTs = Math.max(t.lastTs, v.lastTs);
  }
}
function top(map) {
  return Object.entries(map).map(([name, e]) => ({
    name,
    requests: e.requests,
    ok: e.ok,
    failed: e.failed,
    promptTokens: e.promptTokens,
    completionTokens: e.completionTokens,
    lastTs: e.lastTs
  })).sort((a, b) => b.requests - a.requests || b.lastTs - a.lastTs).slice(0, 10);
}

// src/service/chat.ts
function writeJson(res, status, value) {
  const body = JSON.stringify(value);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Content-Length": Buffer.byteLength(body) });
  res.end(body);
}
function errorBody(message, type) {
  return { error: { message, type, param: null, code: null } };
}
function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}
function mergeUsage(acc, raw) {
  if (raw === null || typeof raw !== "object")
    return;
  const u = raw;
  const prompt = num(u.prompt_tokens ?? u.input_tokens);
  const completion = num(u.completion_tokens ?? u.output_tokens);
  const details = u.prompt_tokens_details;
  const cached = num(details?.cached_tokens ?? u.cache_read_input_tokens ?? u.cached_tokens);
  if (prompt > acc.promptTokens)
    acc.promptTokens = prompt;
  if (completion > acc.completionTokens)
    acc.completionTokens = completion;
  if (cached > acc.cachedTokens)
    acc.cachedTokens = cached;
  if (prompt > 0)
    acc.inputEstimated = false;
  if (completion > 0)
    acc.outputEstimated = false;
}
function estimate(acc, rawBody, textLength) {
  if (acc.promptTokens === 0) {
    acc.promptTokens = Math.max(1, Math.round(rawBody.length / 4));
    acc.inputEstimated = true;
  }
  if (acc.completionTokens === 0) {
    acc.completionTokens = textLength > 0 ? Math.max(1, Math.round(textLength / 4)) : 0;
    acc.outputEstimated = true;
  }
}

class ChatAccumulator {
  content = "";
  reasoning = "";
  toolCalls = new Map;
  finishReason = null;
  role = "assistant";
  error = null;
  usage = { ...EMPTY_USAGE };
  sawChunk = false;
  absorb(obj) {
    if (obj === null || typeof obj !== "object")
      return;
    const chunk = obj;
    if (typeof chunk.model === "string")
      this.usage = { ...this.usage };
    if (chunk.usage !== undefined)
      mergeUsage(this.usage, chunk.usage);
    const err = chunk.error;
    if (err !== null && typeof err === "object") {
      const e = err;
      this.error = typeof e.message === "string" ? e.message : JSON.stringify(err);
    } else if (typeof err === "string") {
      this.error = err;
    }
    const choices = chunk.choices;
    if (!Array.isArray(choices))
      return;
    for (const c of choices) {
      if (c === null || typeof c !== "object")
        continue;
      const choice = c;
      if (typeof choice.finish_reason === "string")
        this.finishReason = choice.finish_reason;
      const delta = choice.delta ?? choice.message;
      if (delta === null || typeof delta !== "object")
        continue;
      this.sawChunk = true;
      if (typeof delta.role === "string")
        this.role = delta.role;
      this.content += readText(delta.content);
      this.reasoning += readText(delta.reasoning_content ?? delta.reasoning);
      const calls = delta.tool_calls;
      if (Array.isArray(calls)) {
        for (const raw of calls) {
          if (raw === null || typeof raw !== "object")
            continue;
          const tc = raw;
          const index = Number.isFinite(Number(tc.index)) ? Number(tc.index) : this.toolCalls.size;
          const cur = this.toolCalls.get(index) ?? { arguments: "" };
          if (typeof tc.id === "string")
            cur.id = tc.id;
          if (typeof tc.type === "string")
            cur.type = tc.type;
          const fn = tc.function;
          if (fn !== null && typeof fn === "object") {
            if (typeof fn.name === "string")
              cur.name = fn.name;
            if (typeof fn.arguments === "string")
              cur.arguments += fn.arguments;
          }
          this.toolCalls.set(index, cur);
        }
      }
    }
  }
  textLength() {
    return this.content.length + this.reasoning.length;
  }
  message() {
    const msg = { role: this.role, content: this.content === "" ? null : this.content };
    if (this.reasoning !== "")
      msg.reasoning_content = this.reasoning;
    if (this.toolCalls.size > 0) {
      msg.tool_calls = [...this.toolCalls.entries()].sort((a, b) => a[0] - b[0]).map(([index, tc]) => ({
        index,
        id: tc.id ?? `call_${randomBytes(6).toString("hex")}`,
        type: tc.type ?? "function",
        function: { name: tc.name ?? "", arguments: tc.arguments }
      }));
    }
    return msg;
  }
  hasOutput() {
    return this.content !== "" || this.reasoning !== "" || this.toolCalls.size > 0;
  }
}
function readText(v) {
  if (typeof v === "string")
    return v;
  if (Array.isArray(v)) {
    let out = "";
    for (const part of v) {
      if (part === null || typeof part !== "object")
        continue;
      const p = part;
      if (typeof p.text === "string")
        out += p.text;
      else if (typeof p.content === "string")
        out += p.content;
    }
    return out;
  }
  return "";
}
async function streamToClient(res, upstream, requested, acc) {
  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no"
  });
  let aborted = false;
  res.on("close", () => {
    if (!res.writableEnded)
      aborted = true;
  });
  const reader = upstream.getReader();
  const decoder = new TextDecoder;
  let buffer = "";
  let ttfbMs = 0;
  let sentDone = false;
  const started = Date.now();
  const handleLine = (line) => {
    const clean = line.endsWith("\r") ? line.slice(0, -1) : line;
    if (!clean.startsWith("data:"))
      return;
    const payload = clean.slice(5).trim();
    if (payload === "")
      return;
    if (payload === "[DONE]") {
      sentDone = true;
      res.write(`data: [DONE]

`);
      return;
    }
    let obj;
    try {
      obj = JSON.parse(payload);
    } catch {
      res.write(`${clean}

`);
      return;
    }
    acc.absorb(obj);
    if (typeof obj.model === "string")
      obj.model = requested;
    if (ttfbMs === 0 && acc.hasOutput())
      ttfbMs = Date.now() - started;
    res.write(`data: ${JSON.stringify(obj)}

`);
  };
  try {
    for (;; ) {
      const { value, done } = await reader.read();
      if (done)
        break;
      if (aborted) {
        reader.cancel().catch(() => {});
        break;
      }
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split(`
`);
      buffer = lines.pop() ?? "";
      for (const line of lines)
        handleLine(line);
    }
    if (buffer !== "" && !aborted)
      handleLine(buffer);
    if (!sentDone && !aborted)
      res.write(`data: [DONE]

`);
  } catch {}
  if (!res.writableEnded)
    res.end();
  return { ttfbMs: ttfbMs === 0 ? Date.now() - started : ttfbMs, aborted };
}
async function collectFromUpstream(upstream, acc) {
  const reader = upstream.getReader();
  const decoder = new TextDecoder;
  let buffer = "";
  for (;; ) {
    const { value, done } = await reader.read();
    if (done)
      break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split(`
`);
    buffer = lines.pop() ?? "";
    for (const line of lines)
      absorbLine(line, acc);
  }
  if (buffer !== "")
    absorbLine(buffer, acc);
}
function absorbLine(line, acc) {
  const clean = line.endsWith("\r") ? line.slice(0, -1) : line;
  if (!clean.startsWith("data:"))
    return;
  const payload = clean.slice(5).trim();
  if (payload === "" || payload === "[DONE]")
    return;
  try {
    acc.absorb(JSON.parse(payload));
  } catch {}
}
async function handleChat(app, res, body) {
  const requested = typeof body.model === "string" ? body.model : "";
  if (requested === "") {
    writeJson(res, 400, errorBody("缺少 model 字段", "invalid_request_error"));
    return;
  }
  const targets = app.resolveTargets(requested);
  if (targets.length === 0) {
    writeJson(res, 404, errorBody(`未知模型：${requested}`, "model_not_found"));
    return;
  }
  const stream = body.stream === true;
  const messages = body.messages;
  const rawBody = JSON.stringify(body);
  let lastState = "unknown";
  let lastMessage = "没有可用账号";
  for (const target of targets) {
    const runtime = app.runtimeById(target.supplierId);
    if (runtime === undefined)
      continue;
    const accounts = runtime.module.status().accounts;
    const order = runtime.pool.candidates(accounts, app.config.get(target.supplierId).poolOrder, target.model, messages);
    if (order.length === 0) {
      lastState = "unknown";
      lastMessage = `${target.supplierId}/${target.model}：全部账号冷却中`;
      continue;
    }
    for (const uid of order) {
      const started = Date.now();
      let result;
      try {
        result = await runtime.module.chatOnce(uid, "auto", { rawBody, stream: true, model: target.model });
      } catch (err) {
        runtime.pool.noteFailure(uid, target.model, "transport", err.message);
        lastState = "transport";
        lastMessage = err.message;
        continue;
      }
      if (result.ok && "stream" in result) {
        const acc = new ChatAccumulator;
        if (stream) {
          const outcome = await streamToClient(res, result.stream, requested, acc);
          runtime.pool.noteSuccess(uid, target.model);
          estimate(acc.usage, rawBody, acc.textLength());
          app.usage.record({
            supplier: target.supplierId,
            model: target.model,
            requested,
            ok: true,
            durationMs: Date.now() - started,
            ttfbMs: outcome.ttfbMs,
            uid
          }, acc.usage);
          return;
        }
        await collectFromUpstream(result.stream, acc);
        if (acc.error !== null && !acc.hasOutput() || !acc.hasOutput() && acc.finishReason === null) {
          runtime.pool.noteFailure(uid, target.model, "unknown", acc.error ?? "上游空响应");
          lastState = "unknown";
          lastMessage = acc.error ?? "上游空响应";
          continue;
        }
        runtime.pool.noteSuccess(uid, target.model);
        estimate(acc.usage, rawBody, acc.textLength());
        app.usage.record({
          supplier: target.supplierId,
          model: target.model,
          requested,
          ok: true,
          durationMs: Date.now() - started,
          ttfbMs: 0,
          uid
        }, acc.usage);
        writeJson(res, 200, {
          id: `chatcmpl-${randomBytes(8).toString("hex")}`,
          object: "chat.completion",
          created: Math.floor(Date.now() / 1000),
          model: requested,
          choices: [{ index: 0, message: acc.message(), finish_reason: acc.finishReason ?? "stop", logprobs: null }],
          usage: {
            prompt_tokens: acc.usage.promptTokens,
            completion_tokens: acc.usage.completionTokens,
            total_tokens: acc.usage.promptTokens + acc.usage.completionTokens,
            prompt_tokens_details: { cached_tokens: acc.usage.cachedTokens }
          }
        });
        return;
      }
      if (result.ok && "body" in result) {
        try {
          writeJson(res, result.status, JSON.parse(result.body));
        } catch {
          writeJson(res, result.status, { raw: result.body });
        }
        runtime.pool.noteSuccess(uid, target.model);
        return;
      }
      if (!result.ok) {
        runtime.pool.noteFailure(uid, target.model, result.state, result.message);
        lastState = result.state;
        lastMessage = result.message;
        if (result.state === "no_such_model" || result.state === "bad_request")
          break;
      }
    }
  }
  app.usage.record({ supplier: targets[0]?.supplierId ?? "", model: "", requested, ok: false, durationMs: 0, ttfbMs: 0, error: lastMessage }, { ...EMPTY_USAGE });
  writeJson(res, 503, errorBody(`全部候选失败：${lastMessage}`, lastState === "session_dead" ? "auth_error" : "upstream_error"));
}

// src/service/admin.ts
var PERIODS = ["today", "24h", "7d", "30d"];
function readPeriod(url) {
  const p = url.searchParams.get("period");
  return PERIODS.includes(p) ? p : "today";
}
async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = chunk;
    size += buf.length;
    if (size > 8 * 1024 * 1024)
      throw new Error("body too large");
    chunks.push(buf);
  }
  if (chunks.length === 0)
    return {};
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    return parsed !== null && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}
var str = (v) => typeof v === "string" ? v : "";
var bool = (v) => v === true;
var strArray = (v) => Array.isArray(v) ? v.filter((x) => typeof x === "string") : [];
async function handleAdmin(deps, req, res, url) {
  const { app } = deps;
  const path = url.pathname;
  const method = req.method ?? "GET";
  if (method === "GET" && path === "/api/state") {
    writeJson(res, 200, app.state());
    return;
  }
  if (method === "GET" && path === "/api/stats") {
    const period = readPeriod(url);
    writeJson(res, 200, { period, stats: app.usage.stats(period), recent: app.usage.recentList(20) });
    return;
  }
  if (method === "GET" && path === "/api/stats/chart") {
    const period = readPeriod(url);
    writeJson(res, 200, { period, buckets: app.usage.chart(period) });
    return;
  }
  if (method === "POST" && path === "/api/stats/clear") {
    app.usage.clear();
    writeJson(res, 200, { ok: true });
    return;
  }
  if (method === "POST" && path === "/api/jobs") {
    const body = await readBody(req);
    const type = str(body.type);
    const supplierId = str(body.supplierId);
    if (!["login", "checkin", "models"].includes(type) || app.runtimeById(supplierId) === undefined) {
      writeJson(res, 400, { error: "非法任务参数" });
      return;
    }
    writeJson(res, 200, app.startJob(type, supplierId));
    return;
  }
  const jobMatch = /^\/api\/jobs\/([0-9a-f]+)$/.exec(path);
  if (method === "GET" && jobMatch !== null) {
    const job = app.job(jobMatch[1]);
    if (job === undefined) {
      writeJson(res, 404, { error: "任务不存在或已过期" });
      return;
    }
    writeJson(res, 200, job);
    return;
  }
  const detailMatch = /^\/api\/suppliers\/([^/]+)$/.exec(path);
  if (method === "GET" && detailMatch !== null) {
    const detail = app.supplierDetail(decodeURIComponent(detailMatch[1]));
    if (detail === undefined) {
      writeJson(res, 404, { error: "供应商不存在" });
      return;
    }
    writeJson(res, 200, detail);
    return;
  }
  if (method === "GET" && path === "/api/keys") {
    writeJson(res, 200, { keys: app.keys.list(), requireApiKey: app.keys.requireApiKey });
    return;
  }
  if (method === "POST" && path === "/api/keys") {
    const body = await readBody(req);
    const entry = app.keys.create(str(body.name));
    app.afterCatalogChange();
    writeJson(res, 200, { entry: { ...entry, masked: entry.key.slice(0, 6) + "…" + entry.key.slice(-4) } });
    return;
  }
  if (method === "POST" && path === "/api/keys/toggle") {
    const body = await readBody(req);
    const ok = app.keys.setActive(str(body.id), bool(body.isActive));
    app.afterCatalogChange();
    writeJson(res, 200, { ok });
    return;
  }
  if (method === "POST" && path === "/api/keys/delete") {
    const body = await readBody(req);
    const ok = app.keys.remove(str(body.id));
    app.afterCatalogChange();
    writeJson(res, 200, { ok });
    return;
  }
  if (method === "POST" && path === "/api/settings") {
    const body = await readBody(req);
    if (body.requireApiKey !== undefined)
      app.keys.requireApiKey = bool(body.requireApiKey);
    if (body.opencodeSync !== undefined)
      app.settings.setOpencodeSync(bool(body.opencodeSync));
    if (body.port !== undefined) {
      const port = Number(body.port);
      if (!Number.isInteger(port) || port <= 0 || port >= 65536) {
        writeJson(res, 400, { error: "端口非法" });
        return;
      }
      app.settings.setPort(port);
      const actual = await deps.rebindPort(port);
      app.afterCatalogChange();
      writeJson(res, 200, { ok: true, port: actual, settings: app.settingsView() });
      return;
    }
    app.afterCatalogChange();
    writeJson(res, 200, { ok: true, settings: app.settingsView() });
    return;
  }
  if (method === "POST" && path === "/api/opencode/sync") {
    writeJson(res, 200, { ok: true, opencode: app.syncOpencode(true) });
    return;
  }
  if (method === "GET" && path === "/api/tps") {
    writeJson(res, 200, app.tps.snapshot());
    return;
  }
  if (method === "POST" && path === "/api/tps/watch") {
    const body = await readBody(req);
    const origin = str(body.origin).trim();
    const sessionId = str(body.sessionId).trim() || null;
    try {
      const url2 = new URL(origin);
      if (url2.protocol !== "http:" && url2.protocol !== "https:")
        throw new Error("bad protocol");
    } catch {
      writeJson(res, 400, { error: "origin 不是合法的 http(s) 地址" });
      return;
    }
    app.tps.watchSession({ origin, sessionId, title: str(body.title).trim() || null });
    writeJson(res, 200, { ok: true, tps: app.tps.snapshot() });
    return;
  }
  const supplierOp = /^\/api\/suppliers\/([^/]+)\/(.+)$/.exec(path);
  if (method === "POST" && supplierOp !== null) {
    const id = decodeURIComponent(supplierOp[1]);
    const op = supplierOp[2];
    if (app.runtimeById(id) === undefined) {
      writeJson(res, 404, { error: "供应商不存在" });
      return;
    }
    const body = await readBody(req);
    const sync = () => app.afterCatalogChange();
    switch (op) {
      case "enabled":
        app.config.setEnabled(id, bool(body.enabled));
        sync();
        writeJson(res, 200, { ok: true });
        return;
      case "alias": {
        const alias = str(body.alias).trim();
        if (alias !== "") {
          const conflict = app.runtimes.find((r) => r.module.id !== id && app.aliasOf(r.module.id) === alias);
          if (conflict !== undefined) {
            writeJson(res, 409, { error: `别名 ${alias} 已被 ${conflict.module.id} 占用` });
            return;
          }
        }
        app.config.setAlias(id, alias);
        sync();
        writeJson(res, 200, { ok: true, alias: app.aliasOf(id) });
        return;
      }
      case "accounts/remove":
        app.creds.remove(id, str(body.uid));
        app.config.clearCredits(id, str(body.uid));
        writeJson(res, 200, { ok: true });
        return;
      case "pool-order":
        app.config.setPoolOrder(id, strArray(body.uids));
        writeJson(res, 200, { ok: true });
        return;
      case "models/toggle":
        app.config.setModelEnabled(id, str(body.id), bool(body.enabled));
        sync();
        writeJson(res, 200, { ok: true });
        return;
      case "models/all":
        app.config.setAllModelsEnabled(id, bool(body.enabled), app.modelViews(id).map((m) => m.id));
        sync();
        writeJson(res, 200, { ok: true });
        return;
      case "models/custom":
        app.config.addCustomModel(id, str(body.id));
        sync();
        writeJson(res, 200, { ok: true });
        return;
      case "models/custom/remove":
        app.config.removeCustomModel(id, str(body.id));
        sync();
        writeJson(res, 200, { ok: true });
        return;
      default:
        writeJson(res, 404, { error: `未知操作 ${op}` });
        return;
    }
  }
  if (method === "POST" && path === "/api/combos/set") {
    const body = await readBody(req);
    const name = str(body.name);
    if (name.trim() === "") {
      writeJson(res, 400, { error: "组合名不能为空" });
      return;
    }
    app.combos.set(name, strArray(body.targets));
    app.afterCatalogChange();
    writeJson(res, 200, { ok: true, combo: app.resolveCombo(name) });
    return;
  }
  if (method === "POST" && path === "/api/combos/remove") {
    const body = await readBody(req);
    const ok = app.combos.remove(str(body.name));
    app.afterCatalogChange();
    writeJson(res, 200, { ok });
    return;
  }
  writeJson(res, 404, { error: `未知接口 ${method} ${path}` });
}

// src/service/server.ts
var MAX_BODY = 64 * 1024 * 1024;
var PORT_FALLBACK_TRIES = 20;
async function readJsonBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = chunk;
    size += buf.length;
    if (size > MAX_BODY) {
      return {
        ok: false,
        error: `请求体超过上限（${Math.round(MAX_BODY / 1024 / 1024)}MB）`,
        detail: `content-length=${req.headers["content-length"] ?? "?"} read=${size}`
      };
    }
    chunks.push(buf);
  }
  if (chunks.length === 0)
    return { ok: true, body: {} };
  let raw = Buffer.concat(chunks);
  const encoding = String(req.headers["content-encoding"] ?? "").trim().toLowerCase();
  try {
    if (encoding === "gzip")
      raw = gunzipSync(raw);
    else if (encoding === "deflate")
      raw = inflateSync(raw);
    else if (encoding === "br")
      raw = brotliDecompressSync(raw);
  } catch (err) {
    return { ok: false, error: `请求体解压失败（${encoding}）`, detail: err.message };
  }
  const text = raw.toString("utf8").replace(/^\uFEFF/, "");
  try {
    const parsed = JSON.parse(text);
    if (parsed === null || typeof parsed !== "object") {
      return { ok: false, error: "请求体不是 JSON 对象", detail: `type=${typeof parsed}` };
    }
    return { ok: true, body: parsed };
  } catch (err) {
    return {
      ok: false,
      error: "请求体不是合法 JSON",
      detail: `${err.message} | content-type=${req.headers["content-type"] ?? "?"} encoding=${encoding || "identity"} length=${raw.length} head=${JSON.stringify(text.slice(0, 120))}`
    };
  }
}
function listen(server, port) {
  return new Promise((resolve, reject) => {
    const onError = (err) => {
      server.off("listening", onListening);
      reject(err);
    };
    const onListening = () => {
      server.off("error", onError);
      const addr = server.address();
      resolve(addr?.port ?? port);
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, "127.0.0.1");
  });
}
function closeServer(server) {
  return new Promise((resolve) => server.close(() => resolve()));
}
function bearer(req) {
  const raw = req.headers.authorization ?? "";
  return raw.startsWith("Bearer ") ? raw.slice(7) : "";
}
async function startServer(app, serviceToken, adminPort) {
  const adminServer = http.createServer((req, res) => {
    (async () => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      if (bearer(req) !== serviceToken) {
        writeJson(res, 401, { error: "unauthorized" });
        return;
      }
      if (req.method === "GET" && url.pathname === "/health") {
        writeJson(res, 200, { ok: true, version: app.state().version });
        return;
      }
      if (url.pathname.startsWith("/api/")) {
        try {
          await handleAdmin({ app, rebindPort }, req, res, url);
        } catch (err) {
          writeJson(res, 500, { error: err.message });
        }
        return;
      }
      writeJson(res, 404, { error: "not found" });
    })();
  });
  let publicServer = null;
  const rebindPort = async (port) => {
    if (publicServer !== null) {
      await closeServer(publicServer);
      publicServer = null;
    }
    const next = http.createServer(publicServerHandler);
    const actual = await listenPublic(next, port);
    publicServer = next;
    app.endpointPort = actual;
    return actual;
  };
  await listen(adminServer, adminPort);
  publicServer = http.createServer(publicServerHandler);
  const publicPort = await listenPublic(publicServer, app.settings.get().port || 3080);
  app.endpointPort = publicPort;
  function publicServerHandler(req, res) {
    (async () => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      if (req.method === "GET" && (url.pathname === "/health" || url.pathname === "/")) {
        writeJson(res, 200, { ok: true, endpoint: `http://127.0.0.1:${app.endpointPort}/v1` });
        return;
      }
      if (!app.keys.verify(bearer(req))) {
        writeJson(res, 401, { error: { message: "无效的 API Key", type: "invalid_request_error", param: null, code: "invalid_api_key" } });
        return;
      }
      if (req.method === "GET" && url.pathname === "/v1/models") {
        writeJson(res, 200, { object: "list", data: modelList(app) });
        return;
      }
      if (req.method === "POST" && url.pathname === "/v1/chat/completions") {
        const parsed = await readJsonBody(req);
        if (!parsed.ok || parsed.body === undefined) {
          console.error(`[ocber-router] /v1/chat/completions body rejected: ${parsed.error ?? "unknown"} | ${parsed.detail ?? ""}`);
          writeJson(res, 400, {
            error: { message: parsed.error ?? "请求体不合法", type: "invalid_request_error", param: null, code: null }
          });
          return;
        }
        await handleChat(app, res, parsed.body);
        return;
      }
      writeJson(res, 404, { error: { message: `未知端点 ${req.method} ${url.pathname}`, type: "invalid_request_error", param: null, code: null } });
    })();
  }
  return {
    publicPort,
    close: async () => {
      await Promise.all([closeServer(adminServer), publicServer !== null ? closeServer(publicServer) : Promise.resolve()]);
    }
  };
}
async function listenPublic(server, preferred) {
  const base = Number.isInteger(preferred) && preferred > 0 ? preferred : 3080;
  for (let i = 0;i < PORT_FALLBACK_TRIES; i += 1) {
    const candidate = base + i;
    if (candidate >= 65536)
      break;
    try {
      return await listen(server, candidate);
    } catch (err) {
      if (err.code !== "EADDRINUSE")
        throw err;
    }
  }
  return listen(server, 0);
}
function modelList(app) {
  const out = new Map;
  for (const r of app.activeRuntimes()) {
    for (const m of app.enabledModelIds(r.module.id)) {
      const id = `${app.aliasOf(r.module.id)}/${m}`;
      out.set(id, { id, object: "model", created: 0, owned_by: r.module.id });
    }
  }
  for (const combo of app.comboViews()) {
    if (combo.targets.some((t) => t.ok)) {
      out.set(combo.name, { id: combo.name, object: "model", created: 0, owned_by: "combo" });
    }
  }
  return [...out.values()];
}

// src/service/app.ts
import { randomBytes as randomBytes3 } from "node:crypto";

// src/service/suppliers/codebuddy/core.ts
var REFRESH_SKEW_MS = 24 * 3600000;
var REFRESH_MAX_ISSUED_MS = 15 * 24 * 3600000;
var POLL_INTERVAL_MS = 5000;
var POLL_TIMEOUT_MS = 5 * 60 * 1000;
var ALREADY_CHECKED_IN_CODE = 10001;
var CREDITS_TTL_MS = 60 * 1000;
var CREDITS_UNKNOWN = -1;
var REFILL_GAP_MS = 2 * 24 * 60 * 60 * 1000;
var NON_CHAT_TAGS = /text-to-image|image-to-image|text-to-video|image-to-video/i;
function precise(preciseValue, plain) {
  const n = Number(preciseValue ?? plain);
  return Number.isFinite(n) ? n : 0;
}
function tokenIssuedAtMs(accessToken) {
  const dot = accessToken.split(".");
  const payload = dot.length >= 2 ? dot[1] ?? "" : "";
  if (payload === "")
    return null;
  let json;
  try {
    json = typeof Buffer !== "undefined" ? Buffer.from(payload, "base64").toString("utf8") : atob(payload);
  } catch {
    return null;
  }
  try {
    const j = JSON.parse(json);
    return typeof j.iat === "number" && Number.isFinite(j.iat) ? j.iat * 1000 : null;
  } catch {
    return null;
  }
}
function gatewayError(prefix, body, status) {
  try {
    const j = JSON.parse(body);
    if (j.code && j.code !== 0)
      return `${prefix} ${j.code}: ${j.msg || j.message || ""}`.trim();
    if (j.message)
      return `${prefix} ${status}: ${j.message}`;
  } catch {}
  return `upstream ${status}: ${body.slice(0, 200)}`;
}
function stripAlias(model, alias) {
  return alias !== "" && model.startsWith(`${alias}/`) ? model.slice(alias.length + 1) : model;
}
async function fetchWithFallback(urls, init, fallbackStatuses) {
  let last;
  for (let i = 0;i < urls.length; i++) {
    const r = await fetch(urls[i], init);
    if (i < urls.length - 1 && fallbackStatuses.includes(r.status)) {
      last = r;
      continue;
    }
    return r;
  }
  return last ?? undefined;
}
function createSupplier(p) {
  return function factory(env) {
    const id = p.id;
    const creds = env.credentials;
    const store = env.store;
    const log = env.log;
    let pendingState;
    let pendingUid;
    const creditsCache = new Map;
    const creditsInflight = new Set;
    let modelsCache;
    let inflight;
    function listUids() {
      return creds.list(id);
    }
    function getCred(uid) {
      return creds.get(id, uid);
    }
    function orderedUids() {
      const all = listUids();
      const order = store.get(id).poolOrder;
      return [...order.filter((u) => all.includes(u)), ...all.filter((u) => !order.includes(u))];
    }
    function currentAlias() {
      return env.store.get(id).alias || id;
    }
    async function fetchModelsFromUpstream() {
      for (const uid of orderedUids()) {
        const cred = getCred(uid);
        if (cred === undefined)
          continue;
        let token = cred.accessToken;
        try {
          token = (await refreshIfNeeded(uid, cred)).accessToken;
        } catch {}
        try {
          const resp = await fetch(p.configUrl, {
            method: "GET",
            headers: p.headers(token),
            signal: AbortSignal.timeout(15000)
          });
          if (!resp.ok)
            continue;
          const j = await resp.json();
          if (j.code !== 0)
            continue;
          const raw = j.data?.models;
          if (!Array.isArray(raw))
            continue;
          const out = [];
          const seen = new Set;
          for (const m of raw) {
            if (typeof m.id !== "string" || m.id === "" || seen.has(m.id))
              continue;
            if (m.tags !== undefined && m.tags.some((t) => NON_CHAT_TAGS.test(t)))
              continue;
            seen.add(m.id);
            const ctx = Number(m.maxInputTokens);
            out.push(Number.isFinite(ctx) && ctx > 0 ? { id: m.id, context_length: Math.round(ctx / 1000) } : { id: m.id });
          }
          if (out.length > 0)
            return out;
        } catch {}
      }
      return [];
    }
    async function allModels(force) {
      if (!force && modelsCache !== undefined)
        return modelsCache;
      if (inflight !== undefined)
        return inflight;
      inflight = fetchModelsFromUpstream().then((list) => {
        if (list.length > 0) {
          modelsCache = list;
          return list;
        }
        return modelsCache ?? p.fallbackModels;
      }).catch(() => modelsCache ?? p.fallbackModels).finally(() => {
        inflight = undefined;
      });
      return inflight;
    }
    async function refreshCredits(uid) {
      if (creditsInflight.has(uid))
        return;
      creditsInflight.add(uid);
      try {
        return await fetchCredits(uid);
      } finally {
        creditsInflight.delete(uid);
      }
    }
    async function fetchCredits(uid) {
      const cred = getCred(uid);
      if (!cred)
        return;
      try {
        const fresh = await refreshIfNeeded(uid, cred);
        const resp = await fetchWithFallback(p.usageUrls, {
          method: "POST",
          headers: p.headers(fresh.accessToken, { "Content-Type": "application/json" }),
          body: "{}",
          signal: AbortSignal.timeout(20000)
        }, [404]);
        const j = await resp.json();
        const accounts = j.data?.Response?.Data?.Accounts;
        if (resp.ok && j.code === 0 && Array.isArray(accounts)) {
          let remain = 0;
          for (const a of accounts) {
            const cycleEnd = typeof a.CycleEndTime === "string" ? Date.parse(a.CycleEndTime) : Number.NaN;
            const deductionEnd = Number(a.DeductionEndTime);
            const isRefill = Number.isFinite(cycleEnd) && Number.isFinite(deductionEnd) && deductionEnd - cycleEnd > REFILL_GAP_MS;
            remain += isRefill ? precise(a.CycleCapacityRemainPrecise, a.CycleCapacityRemain) : precise(a.CapacityRemainPrecise, a.CapacityRemain);
          }
          const value = Math.round(remain * 100) / 100;
          creditsCache.set(uid, { value, at: Date.now() });
          return value;
        }
      } catch {}
      return;
    }
    async function checkinOne(uid) {
      const cred = getCred(uid);
      if (!cred)
        return { uid, ok: false, status: "error", message: "凭证缺失" };
      let token;
      try {
        token = (await refreshIfNeeded(uid, cred)).accessToken;
      } catch {
        token = cred.accessToken;
      }
      try {
        const resp = await fetchWithFallback(p.checkinUrls, {
          method: "POST",
          headers: p.headers(token, { "Content-Type": "application/json" }),
          body: "{}",
          signal: AbortSignal.timeout(20000)
        }, [404]);
        let j;
        try {
          j = await resp.json();
        } catch {}
        if (j?.code === ALREADY_CHECKED_IN_CODE) {
          await refreshCredits(uid);
          return { uid, ok: true, status: "already", message: j.msg ?? "今日已签到" };
        }
        if (j !== undefined && j.code !== undefined && j.code !== 0) {
          return { uid, ok: false, status: "error", message: j.msg ?? `签到失败 code=${String(j.code)}` };
        }
        if (!resp.ok) {
          if (resp.status === 401 || resp.status === 403) {
            return { uid, ok: false, status: "error", message: `凭证失效 ${resp.status}` };
          }
          return { uid, ok: false, status: "error", message: `签到失败 ${resp.status}` };
        }
        await refreshCredits(uid);
        const days = j?.data?.streak_days;
        return {
          uid,
          ok: true,
          status: "ok",
          message: `+${j?.data?.credit ?? 0} 积分${typeof days === "number" ? `（连续 ${days} 天）` : ""}`
        };
      } catch (err) {
        return { uid, ok: false, status: "error", message: err.message };
      }
    }
    async function refreshIfNeeded(uid, cred) {
      const iat = tokenIssuedAtMs(cred.accessToken);
      const issuedLongAgo = iat !== null && Date.now() - iat >= REFRESH_MAX_ISSUED_MS;
      if (!issuedLongAgo && Date.now() + REFRESH_SKEW_MS < cred.expiresAt)
        return cred;
      if (!cred.refreshToken)
        return cred;
      try {
        const resp = await fetch(p.refreshUrl, {
          method: "POST",
          headers: p.headers(undefined, {
            "X-Refresh-Token": cred.refreshToken,
            "X-Auth-Refresh-Source": "plugin",
            "X-Domain": p.domain
          }),
          body: "{}",
          signal: AbortSignal.timeout(20000)
        });
        if (!resp.ok)
          return cred;
        const data = await resp.json();
        if (data.code !== 0 || !data.data?.accessToken)
          return cred;
        const next = {
          nickname: cred.nickname,
          accessToken: data.data.accessToken,
          refreshToken: data.data.refreshToken || cred.refreshToken,
          expiresAt: Date.now() + (data.data.expiresIn || 86400) * 1000
        };
        creds.save(id, uid, next);
        log(`${p.errPrefix} token refreshed ${uid}`);
        return next;
      } catch {
        return cred;
      }
    }
    return {
      id,
      name: p.name,
      priority: p.priority,
      icon: p.icon,
      status: () => {
        const now = Date.now();
        const accounts = orderedUids().map((uid) => {
          const cred = getCred(uid);
          const cached = creditsCache.get(uid);
          if (cached === undefined || now - cached.at > CREDITS_TTL_MS)
            refreshCredits(uid);
          return {
            uid,
            nickname: cred?.nickname || p.defaultNickname,
            credits: cached?.value ?? CREDITS_UNKNOWN,
            state: cred === undefined ? "session_dead" : "ok"
          };
        });
        return { id, name: p.name, accounts };
      },
      checkinNow: async (uid) => {
        const r = await checkinOne(uid);
        log(`${p.errPrefix} checkin ${uid}: ${r.status}${r.message === undefined ? "" : ` (${r.message})`}`);
        return r;
      },
      listModels: (force) => allModels(!!force),
      generateLoginUrl: async () => {
        try {
          const resp = await fetch(`${p.stateUrl}?platform=CLI`, {
            method: "POST",
            headers: p.headers(undefined, {
              "X-Domain": p.domain,
              "X-No-Authorization": "true",
              "X-No-User-Id": "true"
            }),
            body: "{}",
            signal: AbortSignal.timeout(20000)
          });
          if (!resp.ok)
            return { ok: false, error: `${p.errPrefix} state failed: ${resp.status}` };
          const data = await resp.json();
          if (data.code !== 0 || !data.data?.state || !data.data?.authUrl) {
            return { ok: false, error: `${p.errPrefix} state error: ${data.msg || "missing state"}` };
          }
          pendingState = data.data.state;
          pendingUid = undefined;
          log(`${p.errPrefix} login started, awaiting browser auth`);
          return { ok: true, loginUrl: data.data.authUrl };
        } catch (err) {
          return { ok: false, error: err.message };
        }
      },
      pollLogin: () => true,
      completeLogin: async () => {
        const state = pendingState;
        if (!state)
          throw new Error("请先生成登录链接");
        const deadline = Date.now() + POLL_TIMEOUT_MS;
        for (;; ) {
          if (Date.now() > deadline) {
            pendingState = undefined;
            throw new Error("登录超时，请重试");
          }
          await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
          let data;
          try {
            const resp = await fetch(`${p.tokenUrl}?state=${encodeURIComponent(state)}`, {
              method: "GET",
              headers: p.headers(undefined, {
                "X-Domain": p.domain,
                "X-No-Authorization": "true",
                "X-No-User-Id": "true",
                "X-No-Enterprise-Id": "true",
                "X-No-Department-Info": "true"
              }),
              signal: AbortSignal.timeout(15000)
            });
            if (!resp.ok)
              continue;
            data = await resp.json();
          } catch {
            continue;
          }
          if (data.code === 11217)
            continue;
          if (data.code !== 0 || !data.data?.accessToken) {
            pendingState = undefined;
            throw new Error(data.msg || "登录失败");
          }
          const nickname = p.defaultNickname;
          let n = listUids().length + 1;
          let uid = `${p.uidPrefix}-${n}`;
          while (getCred(uid) !== undefined)
            uid = `${p.uidPrefix}-${++n}`;
          const cred = {
            nickname,
            accessToken: data.data.accessToken,
            refreshToken: data.data.refreshToken || "",
            expiresAt: Date.now() + (data.data.expiresIn || 86400) * 1000
          };
          creds.save(id, uid, cred);
          pendingState = undefined;
          log(`${p.errPrefix} login ok ${uid}`);
          return { uid, nickname };
        }
      },
      removeLink: (uid) => {
        if (getCred(uid) === undefined)
          return Promise.resolve(false);
        creds.remove(id, uid);
        return Promise.resolve(true);
      },
      async chatOnce(uid, lv, req) {
        const base = stripAlias(req.model, currentAlias());
        if (base === "") {
          const msg = `unknown model ${JSON.stringify(req.model)}`;
          return { ok: false, state: "no_such_model", message: msg };
        }
        const cred = getCred(uid);
        if (cred === undefined) {
          const msg = `unknown account ${JSON.stringify(uid)}`;
          return { ok: false, state: "no_such_model", message: msg };
        }
        let body = req.rawBody;
        try {
          const obj = JSON.parse(body);
          obj.model = base;
          obj.stream = true;
          if (lv !== "auto" && lv !== "" && lv !== "none" && lv !== "off") {
            obj.reasoning_effort = lv;
            obj.reasoning_summary = "auto";
          } else {
            delete obj.reasoning_effort;
            delete obj.reasoning_summary;
          }
          p.normalizeBody?.(obj);
          body = JSON.stringify(obj);
          if (p.normalizeBodyText !== undefined)
            body = p.normalizeBodyText(body);
        } catch {}
        let fresh = cred;
        try {
          fresh = await refreshIfNeeded(uid, cred);
        } catch {}
        const ctrl = new AbortController;
        const timer = setTimeout(() => ctrl.abort(new Error("upstream connect/response timeout (120s)")), 120000);
        let upstream;
        for (let i = 0;i < p.chatUrls.length; i++) {
          try {
            upstream = await fetch(p.chatUrls[i], {
              method: "POST",
              headers: p.headers(fresh.accessToken, {
                "Content-Type": "application/json",
                ...p.chatExtraHeaders
              }),
              body,
              signal: ctrl.signal
            });
            if (i < p.chatUrls.length - 1 && (upstream.status === 404 || upstream.status === 405))
              continue;
            break;
          } catch (err) {
            if (i < p.chatUrls.length - 1)
              continue;
            clearTimeout(timer);
            const msg = err.message;
            return { ok: false, state: "transport", message: msg };
          }
        }
        clearTimeout(timer);
        if (upstream === undefined) {
          return { ok: false, state: "transport", message: "no chat endpoint" };
        }
        if (upstream.status < 200 || upstream.status >= 300) {
          const text = await upstream.text().catch(() => "");
          const gwErr = gatewayError(p.errPrefix, text, upstream.status);
          let gwCode;
          let extType;
          try {
            const j = JSON.parse(text);
            gwCode = typeof j.code === "number" ? j.code : undefined;
            extType = typeof j.extError?.type === "string" ? j.extError.type : undefined;
          } catch {}
          const byCode = gwCode === undefined ? undefined : p.classifyGatewayCode?.(gwCode);
          const state = upstream.status === 429 ? "rate_limit" : upstream.status === 401 || upstream.status === 403 ? "session_dead" : upstream.status === 404 ? "unavailable" : byCode ?? (extType === "invalid_request_error" ? "bad_request" : "unknown");
          return { ok: false, state, message: gwErr };
        }
        if (!upstream.body) {
          const msg = `${p.errPrefix} upstream: empty stream body`;
          return { ok: false, state: "transport", message: msg };
        }
        return { ok: true, stream: upstream.body };
      },
      dispose: () => {
        creditsCache.clear();
        creditsInflight.clear();
        modelsCache = undefined;
      }
    };
  };
}

// src/service/suppliers/codebuddy/icon.ts
var CODEBUDDY_ICON = "data:image/png;base64,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";

// src/service/suppliers/codebuddy/cn.ts
var BASE = "https://copilot.tencent.com";
var FALLBACK_MODELS = [
  { id: "deepseek-v4-pro", context_length: 1e6 },
  { id: "deepseek-v4-flash", context_length: 1e6 },
  { id: "glm-5.3", context_length: 1e6 },
  { id: "glm-5.3-flash", context_length: 1e6 },
  { id: "glm-5.2", context_length: 1e6 },
  { id: "minimax-m3", context_length: 512000 },
  { id: "kimi-k3-1", context_length: 1e6 },
  { id: "kimi-k2.7", context_length: 256000 },
  { id: "hy4-preview", context_length: 1e6 },
  { id: "hy3", context_length: 192000 },
  { id: "hunyuan-chat", context_length: 200000 }
];
function headers(token, extra = {}) {
  const h = {
    "User-Agent": "CLI/2.108.1 CodeBuddy/2.108.1",
    "X-Product": "SaaS",
    "X-IDE-Type": "CLI",
    "X-IDE-Name": "CLI",
    "x-requested-with": "XMLHttpRequest",
    "x-codebuddy-request": "1",
    ...extra
  };
  if (token)
    h.Authorization = `Bearer ${token}`;
  return h;
}
var profile = {
  id: "codebuddy",
  name: "CodeBuddy",
  icon: CODEBUDDY_ICON,
  priority: -1,
  chatUrls: [`${BASE}/v2/chat/completions`],
  configUrl: `${BASE}/v3/config`,
  stateUrl: `${BASE}/v2/plugin/auth/state`,
  tokenUrl: `${BASE}/v2/plugin/auth/token`,
  refreshUrl: `${BASE}/v2/plugin/auth/token/refresh`,
  usageUrls: [`${BASE}/v2/billing/meter/get-user-resource`],
  checkinUrls: [`${BASE}/billing/meter/daily-checkin`],
  domain: "copilot.tencent.com",
  headers,
  errPrefix: "codebuddy",
  uidPrefix: "cb",
  defaultNickname: "CodeBuddy",
  fallbackModels: FALLBACK_MODELS,
  classifyGatewayCode: (code) => {
    if (code === 11134)
      return "rate_limit";
    if (code === 11133 || code === 11135)
      return "bad_request";
    return;
  }
};

// src/service/suppliers/codebuddy/en.ts
var BASE2 = "https://www.workbuddy.ai";
var ICON = CODEBUDDY_ICON;
var FALLBACK_MODELS2 = [
  { id: "gpt-5.6-sol", context_length: 1e6 },
  { id: "gpt-5.6-terra", context_length: 1e6 },
  { id: "gpt-5.6-luna", context_length: 1e6 },
  { id: "gpt-5.5", context_length: 1e6 },
  { id: "gpt-5.4", context_length: 512000 },
  { id: "gemini-3.5-flash", context_length: 1e6 },
  { id: "kimi-k3", context_length: 1e6 },
  { id: "kimi-k2.6", context_length: 256000 }
];
function headers2(token, extra = {}) {
  const h = {
    "User-Agent": "WorkBuddy/5.5.4 WorkBuddy AI/5.5.4 CLI/2.137.1",
    Origin: BASE2,
    Referer: `${BASE2}/`,
    "Accept-Language": "en-US",
    "X-No-Enterprise-Id": "1",
    "X-Requested-With": "XMLHttpRequest",
    "X-CodeBuddy-Request": "1",
    ...extra
  };
  if (token)
    h.Authorization = `Bearer ${token}`;
  return h;
}
function normalizeRoles(obj) {
  const msgs = obj.messages;
  if (!Array.isArray(msgs))
    return;
  for (const m of msgs) {
    if (m === null || typeof m !== "object")
      continue;
    const msg = m;
    if (typeof msg.role === "string" && msg.role.trim().toLowerCase() === "developer") {
      msg.role = "system";
    }
  }
}
function normalizeToolChoice(obj) {
  const suppress = () => {
    delete obj.tools;
    delete obj.functions;
  };
  const tc = obj.tool_choice;
  if (tc === undefined)
    return;
  if (typeof tc === "string") {
    if (tc.trim().toLowerCase() === "none") {
      delete obj.tool_choice;
      suppress();
    }
    return;
  }
  if (tc !== null && typeof tc === "object") {
    const v = tc;
    const typ = typeof v.type === "string" ? v.type.trim().toLowerCase() : "";
    if (typ === "none") {
      delete obj.tool_choice;
      suppress();
    } else if (typ === "auto" || typ === "required") {
      obj.tool_choice = typ;
    } else if (typ === "function") {
      const fn = v.function;
      let name = "";
      if (fn !== null && typeof fn === "object")
        name = String(fn.name ?? "");
      if (name === "")
        name = String(v.name ?? "");
      name = name.trim();
      if (name !== "")
        obj.tool_choice = name;
      else
        obj.tool_choice = "auto";
    } else {
      delete obj.tool_choice;
    }
    return;
  }
  delete obj.tool_choice;
}
function ensureConsoleSystem(body) {
  try {
    const obj = JSON.parse(body);
    const msgs = obj.messages;
    if (!Array.isArray(msgs) || msgs.length === 0)
      return body;
    const first = msgs[0];
    if (first !== null && typeof first === "object") {
      const role = first.role;
      if (typeof role === "string" && role.trim().toLowerCase() === "system")
        return body;
    }
    obj.messages = [
      { role: "system", content: "You are a helpful assistant." },
      ...msgs
    ];
    return JSON.stringify(obj);
  } catch {
    return body;
  }
}
var profile2 = {
  id: "codebuddy-en",
  name: "CodeBuddyEN",
  icon: ICON,
  priority: -1,
  chatUrls: [`${BASE2}/console/chat/completions`, `${BASE2}/v2/chat/completions`],
  configUrl: `${BASE2}/v3/config`,
  stateUrl: `${BASE2}/v2/plugin/auth/state`,
  tokenUrl: `${BASE2}/v2/plugin/auth/token`,
  refreshUrl: `${BASE2}/v2/plugin/auth/token/refresh`,
  usageUrls: [`${BASE2}/billing/meter/get-user-resource`, `${BASE2}/v2/billing/meter/get-user-resource`],
  checkinUrls: [`${BASE2}/billing/meter/daily-checkin`, `${BASE2}/v2/billing/meter/daily-checkin`],
  domain: "www.workbuddy.ai",
  headers: headers2,
  errPrefix: "workbuddy",
  uidPrefix: "wb",
  defaultNickname: "WorkBuddy",
  fallbackModels: FALLBACK_MODELS2,
  chatExtraHeaders: { Accept: "application/json, text/event-stream" },
  classifyGatewayCode: (code) => {
    if (code === 11134)
      return "rate_limit";
    if (code === 11128 || code === 11133 || code === 11135)
      return "bad_request";
    return;
  },
  normalizeBody: (obj) => {
    normalizeRoles(obj);
    normalizeToolChoice(obj);
  },
  normalizeBodyText: ensureConsoleSystem
};

// src/service/account-pool.ts
import { createHash } from "node:crypto";
var MINUTE = 60000;
var SESSION_DEAD_COOLDOWN_MS = 30 * MINUTE;
var TRANSIENT_COOLDOWN_MS = 30000;
var BACKOFF_BASE_MS = 2000;
var BACKOFF_MAX_MS = 5 * MINUTE;
var BACKOFF_MAX_LEVEL = 15;
var AFFINITY_MAX = 256;
var RULES = {
  ok: { cooldown: 0, counts: false },
  rate_limit: { cooldown: "backoff", counts: false },
  quota: { cooldown: 10 * MINUTE, counts: false },
  session_dead: { cooldown: SESSION_DEAD_COOLDOWN_MS, counts: false },
  unavailable: { cooldown: "transient", counts: false },
  transport: { cooldown: "transient", counts: false },
  unknown: { cooldown: "transient", counts: false },
  no_such_model: { cooldown: 0, counts: false },
  bad_request: { cooldown: 0, counts: false }
};
var SEP = "\x00";
function backoffMs(level) {
  return Math.min(BACKOFF_BASE_MS * 2 ** Math.max(0, level - 1), BACKOFF_MAX_MS);
}
function prefixFingerprint(messages) {
  if (!Array.isArray(messages) || messages.length === 0)
    return "";
  try {
    const head = messages.slice(0, 6).map((m) => {
      if (m === null || typeof m !== "object")
        return String(m);
      const msg = m;
      const content = msg.content;
      const text = typeof content === "string" ? content.slice(0, 2000) : Array.isArray(content) ? JSON.stringify(content).slice(0, 2000) : "";
      return `${String(msg.role ?? "")}:${text}`;
    });
    return createHash("sha1").update(head.join(`
`)).digest("hex").slice(0, 16);
  } catch {
    return "";
  }
}

class AccountPool {
  supplierId;
  cooldowns = new Map;
  byUid = new Map;
  affinity = new Map;
  rrCursor = 0;
  lastWhy = "";
  constructor(supplierId) {
    this.supplierId = supplierId;
  }
  key(model, uid) {
    return `${this.supplierId}${SEP}${model}${SEP}${uid}`;
  }
  blockKey(model) {
    return `${this.supplierId}${SEP}${model}`;
  }
  entry(model, uid) {
    const k = this.key(model, uid);
    let e = this.cooldowns.get(k);
    if (e === undefined) {
      e = { until: 0, backoffLevel: 0, reason: "" };
      this.cooldowns.set(k, e);
    }
    return e;
  }
  healthy(uid, model, now) {
    const u = this.byUid.get(uid);
    if (u !== undefined && u.until > now)
      return false;
    const c = this.cooldowns.get(this.key(model, uid));
    return c === undefined || c.until <= now;
  }
  ordered(accounts, poolOrder) {
    const present = new Set(accounts.map((a) => a.uid));
    const ordered = poolOrder.filter((uid) => present.has(uid));
    for (const a of accounts)
      if (!ordered.includes(a.uid))
        ordered.push(a.uid);
    return ordered;
  }
  candidates(accounts, poolOrder, modelId, messages) {
    const now = Date.now();
    const ordered = this.ordered(accounts, poolOrder);
    const healthy = ordered.filter((uid) => this.healthy(uid, modelId, now));
    if (healthy.length === 0) {
      this.lastWhy = "全池无健康号（都在冷却）";
      return [];
    }
    const fp = prefixFingerprint(messages);
    if (fp !== "") {
      const bound = this.affinity.get(this.blockKey(modelId))?.get(fp);
      if (bound !== undefined && healthy.includes(bound)) {
        this.lastWhy = `亲和命中 ${bound}`;
        return [bound, ...healthy.filter((uid) => uid !== bound)];
      }
    }
    const taken = new Set(this.affinity.get(this.blockKey(modelId))?.values() ?? []);
    const free = fp === "" ? healthy : healthy.filter((uid) => !taken.has(uid));
    const rotated = free.length > 0 ? free : healthy;
    const start = this.rrCursor % rotated.length;
    const sequence = [...rotated.slice(start), ...rotated.slice(0, start)];
    this.rrCursor = (this.rrCursor + 1) % rotated.length;
    if (fp !== "" && sequence.length > 0)
      this.bind(modelId, fp, sequence[0]);
    this.lastWhy = free.length === 0 ? `号已铺满，复用 ${sequence[0] ?? ""}` : `铺开到 ${sequence[0] ?? ""}`;
    return sequence;
  }
  pick(accounts, poolOrder, modelId, messages) {
    return this.candidates(accounts, poolOrder, modelId, messages)[0];
  }
  bind(modelId, fp, uid) {
    const k = this.blockKey(modelId);
    let m = this.affinity.get(k);
    if (m === undefined) {
      m = new Map;
      this.affinity.set(k, m);
    }
    m.delete(fp);
    m.set(fp, uid);
    if (m.size > AFFINITY_MAX) {
      const oldest = m.keys().next().value;
      if (oldest !== undefined)
        m.delete(oldest);
    }
  }
  noteFailure(uid, modelId, state, message) {
    const rule = RULES[state];
    if (rule.cooldown === 0)
      return;
    if (state === "session_dead") {
      const e2 = this.byUid.get(uid) ?? { until: 0, reason: "" };
      e2.until = Math.max(e2.until, Date.now() + SESSION_DEAD_COOLDOWN_MS);
      e2.reason = message;
      this.byUid.set(uid, e2);
      return;
    }
    const e = this.entry(modelId, uid);
    e.reason = message;
    if (rule.cooldown === "backoff") {
      e.backoffLevel = Math.min(e.backoffLevel + 1, BACKOFF_MAX_LEVEL);
      e.until = Math.max(e.until, Date.now() + backoffMs(e.backoffLevel));
      return;
    }
    if (rule.cooldown === "transient") {
      e.until = Math.max(e.until, Date.now() + TRANSIENT_COOLDOWN_MS);
      return;
    }
    e.until = Math.max(e.until, Date.now() + rule.cooldown);
  }
  noteSuccess(uid, modelId) {
    const e = this.cooldowns.get(this.key(modelId, uid));
    if (e !== undefined)
      e.backoffLevel = 0;
  }
  cooldown(uid, untilMs, reason) {
    const e = this.byUid.get(uid) ?? { until: 0, reason: "" };
    e.until = untilMs;
    e.reason = reason;
    this.byUid.set(uid, e);
    for (const [k, ce] of this.cooldowns)
      if (k.endsWith(`${SEP}${uid}`))
        ce.backoffLevel = 0;
  }
  decorate(accounts) {
    const now = Date.now();
    return accounts.map((a) => {
      const u = this.byUid.get(a.uid);
      const uidCooling = u !== undefined && u.until > now;
      let cooling = uidCooling;
      let maxUntil = uidCooling ? u.until : 0;
      let reason = uidCooling ? u.reason : undefined;
      let err = 0;
      for (const [k, ce] of this.cooldowns) {
        if (!k.endsWith(`${SEP}${a.uid}`))
          continue;
        if (ce.until > now) {
          cooling = true;
          if (ce.until > maxUntil) {
            maxUntil = ce.until;
            reason = ce.reason;
          }
        }
        if (ce.backoffLevel > err)
          err = ce.backoffLevel;
      }
      return { ...a, cooling, err_count: err, until: cooling && maxUntil > 0 ? new Date(maxUntil).toISOString() : undefined, reason: reason !== "" ? reason : undefined };
    });
  }
}

// src/service/store.ts
import { mkdirSync as mkdirSync2, readFileSync as readFileSync2, renameSync as renameSync2, writeFileSync as writeFileSync2 } from "node:fs";
import { dirname as dirname2, join as join2 } from "node:path";
import { homedir } from "node:os";
import { randomBytes as randomBytes2 } from "node:crypto";
function resolveDataDir() {
  const override = (process.env.OCBER_DATA_DIR ?? "").trim();
  if (override !== "")
    return override;
  return join2(homedir(), ".ocber-router");
}
function writeJson2(file, value) {
  try {
    const dir = dirname2(file);
    if (dir !== "" && dir !== ".")
      mkdirSync2(dir, { recursive: true });
    const tmp = `${file}.tmp`;
    writeFileSync2(tmp, JSON.stringify(value, null, 2), { mode: 384 });
    renameSync2(tmp, file);
  } catch {}
}
function readJson(file) {
  try {
    return JSON.parse(readFileSync2(file, "utf8"));
  } catch {
    return;
  }
}

class CredentialStore {
  file;
  data = {};
  constructor(dataDir) {
    this.file = join2(dataDir, "credentials.json");
    const raw = readJson(this.file);
    if (raw !== undefined && typeof raw === "object" && raw !== null)
      this.data = raw;
  }
  list(supplierId) {
    const bucket = this.data[supplierId];
    return bucket === undefined ? [] : Object.keys(bucket);
  }
  get(supplierId, uid) {
    return this.data[supplierId]?.[uid];
  }
  save(supplierId, uid, blob) {
    const bucket = this.data[supplierId] ?? {};
    bucket[uid] = blob;
    this.data[supplierId] = bucket;
    writeJson2(this.file, this.data);
  }
  remove(supplierId, uid) {
    const bucket = this.data[supplierId];
    if (bucket === undefined || bucket[uid] === undefined)
      return;
    delete bucket[uid];
    writeJson2(this.file, this.data);
  }
}
var DEFAULT_SUPPLIER_CONFIG = () => ({
  enabled: true,
  alias: "",
  disabled: [],
  custom: [],
  poolOrder: [],
  poolStrategy: "fallback",
  credits: {}
});

class SupplierConfigStore {
  file;
  bySupplier = new Map;
  constructor(dataDir) {
    this.file = join2(dataDir, "supplier-config.json");
    const raw = readJson(this.file);
    for (const [id, cfg] of Object.entries(raw?.suppliers ?? {})) {
      this.bySupplier.set(id, {
        enabled: typeof cfg.enabled === "boolean" ? cfg.enabled : true,
        alias: typeof cfg.alias === "string" ? cfg.alias : "",
        disabled: Array.isArray(cfg.disabled) ? cfg.disabled.filter((m) => typeof m === "string") : [],
        custom: Array.isArray(cfg.custom) ? cfg.custom.filter((m) => typeof m === "string") : [],
        poolOrder: Array.isArray(cfg.poolOrder) ? cfg.poolOrder.filter((u) => typeof u === "string") : [],
        poolStrategy: cfg.poolStrategy === "round-robin" ? "round-robin" : "fallback",
        credits: readCredits(cfg.credits)
      });
    }
  }
  get(id) {
    let cfg = this.bySupplier.get(id);
    if (cfg === undefined) {
      cfg = DEFAULT_SUPPLIER_CONFIG();
      this.bySupplier.set(id, cfg);
    }
    return cfg;
  }
  setAlias(id, alias) {
    this.get(id).alias = (alias ?? "").trim();
    this.save();
  }
  setEnabled(id, enabled) {
    this.get(id).enabled = enabled;
    this.save();
  }
  setPoolOrder(id, uids) {
    this.get(id).poolOrder = [...new Set(uids)];
    this.save();
  }
  setPoolStrategy(id, strategy) {
    this.get(id).poolStrategy = strategy === "round-robin" ? "round-robin" : "fallback";
    this.save();
  }
  setModelEnabled(id, modelId, enabled) {
    const cfg = this.get(id);
    cfg.disabled = enabled ? cfg.disabled.filter((m) => m !== modelId) : [...new Set([...cfg.disabled, modelId])];
    this.save();
  }
  setAllModelsEnabled(id, enabled, modelIds) {
    const cfg = this.get(id);
    cfg.disabled = enabled ? [] : [...new Set(modelIds)];
    this.save();
  }
  addCustomModel(id, modelId) {
    const cfg = this.get(id);
    const clean = modelId.trim();
    if (clean === "" || cfg.custom.includes(clean))
      return;
    cfg.custom.push(clean);
    this.save();
  }
  removeCustomModel(id, modelId) {
    const cfg = this.get(id);
    cfg.custom = cfg.custom.filter((m) => m !== modelId);
    cfg.disabled = cfg.disabled.filter((m) => m !== modelId);
    this.save();
  }
  getCredits(id, uid) {
    const v = this.get(id).credits[uid];
    return typeof v === "number" && Number.isFinite(v) ? v : -1;
  }
  putCredits(id, uid, reported) {
    if (typeof reported !== "number" || !Number.isFinite(reported) || reported < 0)
      return this.getCredits(id, uid);
    const prev = this.getCredits(id, uid);
    if (prev === reported)
      return reported;
    this.get(id).credits[uid] = reported;
    this.save();
    return reported;
  }
  clearCredits(id, uid) {
    const credits = this.get(id).credits;
    if (credits[uid] === undefined)
      return;
    delete credits[uid];
    this.save();
  }
  knownIds() {
    return [...this.bySupplier.keys()];
  }
  save() {
    const file = { suppliers: {} };
    for (const [id, cfg] of this.bySupplier)
      file.suppliers[id] = { ...cfg, credits: { ...cfg.credits } };
    writeJson2(this.file, file);
  }
}
function readCredits(raw) {
  const out = {};
  if (typeof raw !== "object" || raw === null)
    return out;
  for (const [uid, v] of Object.entries(raw)) {
    if (typeof v === "number" && Number.isFinite(v) && v >= 0)
      out[uid] = v;
  }
  return out;
}

class CombosStore {
  file;
  combos = new Map;
  constructor(dataDir) {
    this.file = join2(dataDir, "combos.json");
    const raw = readJson(this.file);
    for (const [name, targets] of Object.entries(raw?.combos ?? {})) {
      if (!Array.isArray(targets))
        continue;
      this.combos.set(name, targets.filter((t) => typeof t === "string"));
    }
  }
  list() {
    return [...this.combos.entries()].map(([name, targets]) => ({ name, targets: [...targets] }));
  }
  get(name) {
    return this.combos.get(name);
  }
  set(name, targets) {
    const clean = name.trim();
    if (clean === "")
      return;
    this.combos.set(clean, [...new Set(targets.map((t) => t.trim()).filter((t) => t !== ""))]);
    this.save();
  }
  remove(name) {
    const ok = this.combos.delete(name);
    if (ok)
      this.save();
    return ok;
  }
  save() {
    writeJson2(this.file, { combos: Object.fromEntries(this.combos) });
  }
}

class KeysStore {
  file;
  keys = [];
  require = false;
  constructor(dataDir) {
    this.file = join2(dataDir, "keys.json");
    const raw = readJson(this.file);
    if (raw !== undefined) {
      this.keys = Array.isArray(raw.keys) ? raw.keys : [];
      this.require = !!raw.requireApiKey;
    }
  }
  list() {
    return this.keys.map((k) => ({ ...k, masked: maskKey(k.key) }));
  }
  create(name) {
    const entry = {
      id: randomBytes2(6).toString("hex"),
      name: name.trim() !== "" ? name.trim() : `Key ${this.keys.length + 1}`,
      key: `ocber-${randomBytes2(24).toString("hex")}`,
      isActive: true,
      createdAt: new Date().toISOString()
    };
    this.keys.push(entry);
    this.save();
    return entry;
  }
  remove(id) {
    const before = this.keys.length;
    this.keys = this.keys.filter((k) => k.id !== id);
    if (this.keys.length === before)
      return false;
    this.save();
    return true;
  }
  setActive(id, isActive) {
    const k = this.keys.find((k2) => k2.id === id);
    if (k === undefined)
      return false;
    k.isActive = isActive;
    this.save();
    return true;
  }
  get requireApiKey() {
    return this.require;
  }
  set requireApiKey(v) {
    this.require = v;
    this.save();
  }
  verify(bearer2) {
    if (!this.require)
      return true;
    if (bearer2 === undefined || bearer2 === "")
      return false;
    return this.keys.some((k) => k.isActive && k.key === bearer2);
  }
  firstActiveKey() {
    return this.keys.find((k) => k.isActive)?.key;
  }
  save() {
    writeJson2(this.file, { keys: this.keys, requireApiKey: this.require });
  }
}
function maskKey(k) {
  if (k.length <= 10)
    return k;
  return `${k.slice(0, 6)}${"•".repeat(Math.min(k.length - 10, 12))}${k.slice(-4)}`;
}
var DEFAULT_PORT = 3080;

class SettingsStore {
  file;
  port;
  opencodeSync;
  opencodeSignature;
  opencodeSyncedAt;
  constructor(dataDir) {
    this.file = join2(dataDir, "settings.json");
    const raw = readJson(this.file);
    const p = Number(raw?.port);
    this.port = Number.isInteger(p) && p > 0 && p < 65536 ? p : DEFAULT_PORT;
    this.opencodeSync = typeof raw?.opencodeSync === "boolean" ? raw.opencodeSync : true;
    this.opencodeSignature = typeof raw?.opencodeSignature === "string" ? raw.opencodeSignature : "";
    this.opencodeSyncedAt = typeof raw?.opencodeSyncedAt === "number" ? raw.opencodeSyncedAt : 0;
  }
  get() {
    return {
      port: this.port,
      opencodeSync: this.opencodeSync,
      opencodeSignature: this.opencodeSignature,
      opencodeSyncedAt: this.opencodeSyncedAt
    };
  }
  setPort(port) {
    if (!Number.isInteger(port) || port <= 0 || port >= 65536)
      return;
    this.port = port;
    this.save();
  }
  setOpencodeSync(enabled) {
    this.opencodeSync = enabled;
    this.save();
  }
  setOpencodeSyncState(signature, syncedAt) {
    this.opencodeSignature = signature;
    this.opencodeSyncedAt = syncedAt;
    this.save();
  }
  save() {
    writeJson2(this.file, {
      port: this.port,
      opencodeSync: this.opencodeSync,
      opencodeSignature: this.opencodeSignature,
      opencodeSyncedAt: this.opencodeSyncedAt
    });
  }
}

// src/service/opencode-sync.ts
import { existsSync, mkdirSync as mkdirSync3, readFileSync as readFileSync3, renameSync as renameSync3, writeFileSync as writeFileSync3 } from "node:fs";
import { createHash as createHash2 } from "node:crypto";
import { dirname as dirname3, join as join3 } from "node:path";
import { homedir as homedir2 } from "node:os";
var OPENCODE_PROVIDER_ID = "ocber";
function opencodeConfigPath() {
  return join3(homedir2(), ".config", "opencode", "opencode.json");
}
var HIDDEN_MODEL_IDS = new Set(["default"]);
function buildModels(app) {
  const out = {};
  for (const combo of app.comboViews()) {
    if (!combo.targets.some((t) => t.ok))
      continue;
    if (HIDDEN_MODEL_IDS.has(combo.name))
      continue;
    out[combo.name] = {
      modelID: combo.name,
      name: combo.name,
      capabilities: { tools: true, input: ["text", "image"], output: ["text"] }
    };
  }
  return out;
}
function syncOpencode(app, force = false) {
  const settings = app.settings.get();
  const path = opencodeConfigPath();
  const view = (extra) => ({
    enabled: settings.opencodeSync,
    path,
    exists: existsSync(path),
    syncedAt: settings.opencodeSyncedAt,
    modelCount: 0,
    ...extra
  });
  if (!settings.opencodeSync && !force)
    return view();
  const models = buildModels(app);
  const modelCount = Object.keys(models).length;
  const signature = createHash2("sha1").update(JSON.stringify({ endpoint: app.endpoint(), models: Object.keys(models).sort() })).digest("hex");
  if (!force && signature === settings.opencodeSignature) {
    return view({ modelCount, syncedAt: settings.opencodeSyncedAt });
  }
  try {
    let config;
    if (existsSync(path)) {
      const raw = readFileSync3(path, "utf8");
      const parsed = raw.trim() === "" ? {} : JSON.parse(raw);
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
        return view({ modelCount, error: "opencode.json 不是 JSON 对象，已跳过（未改动）" });
      }
      config = parsed;
    } else {
      config = { $schema: "https://opencode.ai/config.json" };
    }
    const existing = config.providers;
    const providers = existing !== null && typeof existing === "object" && !Array.isArray(existing) ? { ...existing } : {};
    const activeKey = app.keys.requireApiKey ? app.keys.firstActiveKey() : undefined;
    providers[OPENCODE_PROVIDER_ID] = {
      name: "OCBer Router",
      package: "aisdk:@ai-sdk/openai-compatible",
      settings: {
        baseURL: app.endpoint(),
        ...activeKey !== undefined ? { apiKey: activeKey } : {}
      },
      models
    };
    config.providers = providers;
    const dir = dirname3(path);
    if (dir !== "" && dir !== ".")
      mkdirSync3(dir, { recursive: true });
    const tmp = `${path}.ocber.tmp`;
    writeFileSync3(tmp, `${JSON.stringify(config, null, 2)}
`, { mode: 384 });
    renameSync3(tmp, path);
    const syncedAt = Date.now();
    app.settings.setOpencodeSyncState(signature, syncedAt);
    return view({ modelCount, syncedAt, exists: true });
  } catch (err) {
    return view({ modelCount, error: err.message });
  }
}

// src/service/tps.ts
var WINDOW_MS = 5000;
var SAMPLE_LIMIT = 20000;
var RETRY_BASE_MS = 1000;
var RETRY_MAX_MS = 15000;
var DEFAULT_CHARS_PER_TOKEN = 0.25;
var MIN_CHARS_PER_TOKEN = 0.05;
var MAX_CHARS_PER_TOKEN = 1;
var CALIBRATION_WEIGHT = 0.3;
var MIN_CALIBRATION_CHARS = 40;
var MAX_STREAM_GAP_MS = 1000;
function readString(v) {
  return typeof v === "string" ? v : "";
}
function readNumber(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}
function readRecord(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v) ? v : undefined;
}

class TpsTracker {
  watch = null;
  controller = null;
  retryTimer = null;
  retryDelay = RETRY_BASE_MS;
  connection = "idle";
  lastError = null;
  samples = [];
  messageChars = new Map;
  countedParts = new Set;
  stepTokens = new Map;
  charsPerToken = DEFAULT_CHARS_PER_TOKEN;
  turnChars = 0;
  turnTokens = 0;
  turnSawTokens = false;
  turnStartedAt = null;
  lastCharAt = null;
  activeMs = 0;
  lastTurn = null;
  busy = false;
  pendingPermissions = new Set;
  pendingQuestions = new Set;
  sessionUsage = null;
  eventsSeen = 0;
  lastEventAt = null;
  watchSession(config) {
    const same = this.watch !== null && this.watch.origin === config.origin && this.watch.sessionId === config.sessionId;
    this.watch = config;
    if (same) {
      this.watch.title = config.title;
      return;
    }
    this.resetSession();
    this.lastError = null;
    this.connection = "idle";
    this.startStream();
  }
  stop() {
    this.watch = null;
    this.controller?.abort();
    this.controller = null;
    if (this.retryTimer !== null) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    this.connection = "idle";
  }
  snapshot() {
    const now = Date.now();
    const cutoff = now - WINDOW_MS;
    while (this.samples.length > 0 && this.samples[0].at < cutoff)
      this.samples.shift();
    const chars = this.samples.reduce((n, s) => n + s.chars, 0);
    const charsPerSecond = chars / (WINDOW_MS / 1000);
    const waiting = this.pendingPermissions.size > 0 ? "permission" : this.pendingQuestions.size > 0 ? "question" : null;
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
      lastEventAt: this.lastEventAt
    };
  }
  resetSession() {
    this.samples = [];
    this.messageChars.clear();
    this.countedParts.clear();
    this.stepTokens.clear();
    this.turnChars = 0;
    this.turnTokens = 0;
    this.turnSawTokens = false;
    this.turnStartedAt = null;
    this.lastCharAt = null;
    this.activeMs = 0;
    this.lastTurn = null;
    this.busy = false;
    this.pendingPermissions.clear();
    this.pendingQuestions.clear();
    this.sessionUsage = null;
    this.eventsSeen = 0;
    this.lastEventAt = null;
  }
  scheduleReconnect(message) {
    this.lastError = message;
    this.connection = "error";
    if (this.watch === null || this.retryTimer !== null)
      return;
    const delay = this.retryDelay;
    this.retryDelay = Math.min(RETRY_MAX_MS, this.retryDelay * 2);
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.startStream();
    }, delay);
  }
  async startStream() {
    const current = this.watch;
    if (current === null || current.sessionId === null)
      return;
    if (this.retryTimer !== null) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    this.controller?.abort();
    const local = new AbortController;
    this.controller = local;
    this.connection = "connecting";
    try {
      const response = await fetch(new URL("/api/global/event", current.origin), {
        headers: { Accept: "text/event-stream" },
        signal: local.signal
      });
      if (!response.ok || response.body === null) {
        this.scheduleReconnect(`事件流返回 HTTP ${response.status}`);
        return;
      }
      this.connection = "live";
      this.retryDelay = RETRY_BASE_MS;
      this.lastEventAt = Date.now();
      const reader = response.body.getReader();
      const decoder = new TextDecoder;
      let buffer = "";
      for (;; ) {
        const { value, done } = await reader.read();
        if (done)
          break;
        buffer += decoder.decode(value, { stream: true });
        const chunks = buffer.split(`

`);
        buffer = chunks.pop() ?? "";
        for (const chunk of chunks)
          this.handleSseChunk(chunk);
      }
      this.scheduleReconnect("事件流已断开");
    } catch (err) {
      if (local.signal.aborted)
        return;
      this.scheduleReconnect(err.message);
    }
  }
  handleSseChunk(chunk) {
    const data = [];
    for (const line of chunk.split(`
`)) {
      if (line.startsWith("data:"))
        data.push(line.slice(5).trimStart());
    }
    if (data.length === 0)
      return;
    let parsed;
    try {
      parsed = JSON.parse(data.join(`
`));
    } catch {
      return;
    }
    const envelope = readRecord(parsed);
    if (envelope === undefined)
      return;
    const inner = readRecord(envelope.payload) ?? envelope;
    this.eventsSeen += 1;
    this.handleEvent(inner, Date.now());
  }
  isWatched(sessionId) {
    return this.watch !== null && this.watch.sessionId !== null && sessionId === this.watch.sessionId;
  }
  recordChars(messageId, chars, now) {
    if (chars <= 0)
      return;
    this.samples.push({ at: now, chars });
    if (this.samples.length > SAMPLE_LIMIT)
      this.samples.splice(0, this.samples.length - SAMPLE_LIMIT);
    if (messageId !== "")
      this.messageChars.set(messageId, (this.messageChars.get(messageId) ?? 0) + chars);
    this.turnChars += chars;
    if (this.lastCharAt !== null && now - this.lastCharAt <= MAX_STREAM_GAP_MS)
      this.activeMs += now - this.lastCharAt;
    this.lastCharAt = now;
    this.lastEventAt = now;
  }
  calibrate(messageId, generated) {
    if (messageId === "")
      return;
    const chars = this.messageChars.get(messageId) ?? 0;
    if (chars < MIN_CALIBRATION_CHARS || generated <= 0)
      return;
    const ratio = Math.min(MAX_CHARS_PER_TOKEN, Math.max(MIN_CHARS_PER_TOKEN, generated / chars));
    this.charsPerToken = this.charsPerToken + (ratio - this.charsPerToken) * CALIBRATION_WEIGHT;
  }
  finalizeTurn(now) {
    if (this.turnStartedAt === null && this.turnChars === 0)
      return;
    const wallMs = this.turnStartedAt === null ? 0 : now - this.turnStartedAt;
    const active = Math.max(this.activeMs, this.turnChars > 0 ? 1 : 0);
    const tokens = this.turnSawTokens ? this.turnTokens : this.turnChars * this.charsPerToken;
    if (tokens > 0 && active > 0) {
      this.lastTurn = {
        tokensPerSecond: Math.round(tokens / (active / 1000) * 10) / 10,
        tokens: Math.round(tokens),
        chars: this.turnChars,
        activeMs: Math.round(active),
        wallMs,
        pausedMs: Math.max(0, wallMs - Math.round(active)),
        endedAt: now,
        source: this.turnSawTokens ? "tokens" : "estimate"
      };
    }
    this.turnChars = 0;
    this.turnTokens = 0;
    this.turnSawTokens = false;
    this.turnStartedAt = null;
    this.lastCharAt = null;
    this.activeMs = 0;
  }
  handleEvent(event, now) {
    const type = readString(event.type);
    if (type === "")
      return;
    const payload = readRecord(event.data) ?? readRecord(event.properties);
    if (payload === undefined)
      return;
    this.lastEventAt = now;
    if (type === "session.text.delta" || type === "session.reasoning.delta") {
      if (!this.isWatched(readString(payload.sessionID)))
        return;
      const messageId = readString(payload.assistantMessageID);
      const delta = readString(payload.delta);
      if (delta === "")
        return;
      const partId = `${messageId}:${type === "session.reasoning.delta" ? "r" : "t"}:${String(payload.ordinal ?? "")}`;
      this.countedParts.add(partId);
      this.recordChars(messageId, delta.length, now);
      return;
    }
    if (type === "session.text.ended" || type === "session.reasoning.ended") {
      if (!this.isWatched(readString(payload.sessionID)))
        return;
      const messageId = readString(payload.assistantMessageID);
      const partId = `${messageId}:${type === "session.reasoning.ended" ? "r" : "t"}:${String(payload.ordinal ?? "")}`;
      if (this.countedParts.has(partId))
        return;
      const text = readString(payload.text);
      if (text === "")
        return;
      this.recordChars(messageId, text.length, now);
      return;
    }
    if (type === "session.step.ended" || type === "session.step.failed") {
      if (!this.isWatched(readString(payload.sessionID)))
        return;
      const tokens = readRecord(payload.tokens);
      if (tokens === undefined)
        return;
      const messageId = readString(payload.assistantMessageID);
      const generated = readNumber(tokens.output) + readNumber(tokens.reasoning);
      if (generated <= 0)
        return;
      this.calibrate(messageId, generated);
      const previous = this.stepTokens.get(messageId) ?? 0;
      this.stepTokens.set(messageId, generated);
      this.turnTokens += generated - previous;
      if (generated > previous)
        this.turnSawTokens = true;
      return;
    }
    if (type === "session.usage.updated") {
      if (!this.isWatched(readString(payload.sessionID)))
        return;
      const tokens = readRecord(payload.tokens);
      if (tokens === undefined)
        return;
      const cache = readRecord(tokens.cache);
      const output = readNumber(tokens.output);
      const reasoning = readNumber(tokens.reasoning);
      this.sessionUsage = {
        cost: readNumber(payload.cost),
        input: readNumber(tokens.input),
        output,
        reasoning,
        cacheRead: readNumber(cache?.read),
        cacheWrite: readNumber(cache?.write),
        generated: output + reasoning
      };
      return;
    }
    if (type === "session.execution.started") {
      if (!this.isWatched(readString(payload.sessionID)))
        return;
      if (this.turnStartedAt === null)
        this.turnStartedAt = now;
      this.busy = true;
      return;
    }
    if (type === "session.execution.succeeded" || type === "session.execution.failed") {
      if (!this.isWatched(readString(payload.sessionID)))
        return;
      this.busy = false;
      this.finalizeTurn(now);
      return;
    }
    if (type === "session.execution.interrupted") {
      if (!this.isWatched(readString(payload.sessionID)))
        return;
      if (readString(payload.reason) === "shutdown")
        return;
      this.busy = false;
      this.finalizeTurn(now);
      return;
    }
    if (type === "session.idle") {
      if (!this.isWatched(readString(payload.sessionID)))
        return;
      this.busy = false;
      this.finalizeTurn(now);
      return;
    }
    if (type === "permission.asked" || type === "permission.v2.asked") {
      if (!this.isWatched(readString(payload.sessionID)))
        return;
      const id = readString(payload.id);
      if (id !== "")
        this.pendingPermissions.add(id);
      return;
    }
    if (type === "permission.replied" || type === "permission.v2.replied") {
      if (!this.isWatched(readString(payload.sessionID)))
        return;
      this.pendingPermissions.delete(readString(payload.requestID));
      return;
    }
    if (type === "form.created") {
      const form = readRecord(payload.form);
      if (form === undefined || !this.isWatched(readString(form.sessionID)))
        return;
      const id = readString(form.id);
      if (id !== "")
        this.pendingQuestions.add(id);
      return;
    }
    if (type === "form.replied" || type === "form.cancelled") {
      if (!this.isWatched(readString(payload.sessionID)))
        return;
      this.pendingQuestions.delete(readString(payload.id));
      return;
    }
    if (type === "question.asked" || type === "question.v2.asked") {
      if (!this.isWatched(readString(payload.sessionID)))
        return;
      const id = readString(payload.id);
      if (id !== "")
        this.pendingQuestions.add(id);
      return;
    }
    if (type === "question.replied" || type === "question.rejected" || type === "question.v2.replied" || type === "question.v2.rejected") {
      if (!this.isWatched(readString(payload.sessionID)))
        return;
      this.pendingQuestions.delete(readString(payload.requestID));
    }
  }
  dispose() {
    this.stop();
  }
}

// src/service/app.ts
var VERSION = "0.1.7";
var CATALOG_TTL_MS = 10 * 60 * 1000;

class App {
  dataDir;
  creds;
  config;
  combos;
  keys;
  settings;
  usage;
  tps = new TpsTracker;
  runtimes;
  startedAt = Date.now();
  endpointPort = 0;
  catalog = new Map;
  jobs = new Map;
  log;
  constructor(dataDir, log = () => {}) {
    this.dataDir = dataDir;
    this.log = log;
    this.creds = new CredentialStore(dataDir);
    this.config = new SupplierConfigStore(dataDir);
    this.combos = new CombosStore(dataDir);
    this.keys = new KeysStore(dataDir);
    this.settings = new SettingsStore(dataDir);
    this.usage = new UsageStore(dataDir);
    const env = {
      dataDir,
      log,
      store: this.config,
      credentials: this.creds
    };
    this.runtimes = [
      { module: createSupplier(profile)(env), pool: new AccountPool(profile.id) },
      { module: createSupplier(profile2)(env), pool: new AccountPool(profile2.id) }
    ];
    this.config.get(profile.id);
    this.config.get(profile2.id);
  }
  runtimeById(id) {
    return this.runtimes.find((r) => r.module.id === id);
  }
  aliasOf(id) {
    return this.config.get(id).alias || id;
  }
  supplierByAlias(alias) {
    for (const r of this.runtimes)
      if (this.aliasOf(r.module.id) === alias)
        return r.module.id;
    return;
  }
  activeRuntimes() {
    return this.runtimes.filter((r) => this.config.get(r.module.id).enabled);
  }
  async refreshCatalog(id, force) {
    const runtime = this.runtimeById(id);
    if (runtime === undefined)
      return;
    const cached = this.catalog.get(id);
    if (!force && cached !== undefined && Date.now() - cached.at < CATALOG_TTL_MS)
      return cached;
    let models = [];
    try {
      models = await runtime.module.listModels(force);
    } catch {
      models = [];
    }
    const ids = models.map((m) => m.id).filter((x) => typeof x === "string" && x !== "");
    const entry = { ids, source: cached !== undefined && ids.length === 0 ? cached.source : "upstream", at: Date.now() };
    if (ids.length === 0 && cached !== undefined)
      return cached;
    if (ids.length === 0)
      entry.source = "fallback";
    this.catalog.set(id, entry);
    return entry;
  }
  warmupCatalog() {
    for (const r of this.runtimes) {
      this.refreshCatalog(r.module.id, false).then(() => this.syncOpencode(false)).catch(() => {});
    }
  }
  catalogEntry(id) {
    return this.catalog.get(id);
  }
  supplierHasAccounts(id) {
    const runtime = this.runtimeById(id);
    return runtime !== undefined && runtime.module.status().accounts.length > 0;
  }
  enabledModelIds(id) {
    if (!this.supplierHasAccounts(id))
      return [];
    const cfg = this.config.get(id);
    const all = new Set(this.catalog.get(id)?.ids ?? []);
    for (const m of cfg.custom)
      all.add(m);
    return [...all].filter((m) => !cfg.disabled.includes(m));
  }
  modelViews(id) {
    const cfg = this.config.get(id);
    const hasAccounts = this.supplierHasAccounts(id);
    const all = new Set(this.catalog.get(id)?.ids ?? []);
    for (const m of cfg.custom)
      all.add(m);
    return [...all].map((m) => ({ id: m, enabled: hasAccounts && !cfg.disabled.includes(m), custom: cfg.custom.includes(m) }));
  }
  accountViews(id) {
    const runtime = this.runtimeById(id);
    if (runtime === undefined)
      return [];
    const now = runtime.module.status();
    const decorated = runtime.pool.decorate(now.accounts);
    return decorated.map((a) => ({
      uid: a.uid,
      nickname: a.nickname ?? id,
      credits: this.config.putCredits(id, a.uid, a.credits),
      cooling: a.cooling,
      until: a.until,
      reason: a.reason,
      err_count: a.err_count
    }));
  }
  supplierViews() {
    return this.runtimes.map((r) => {
      const id = r.module.id;
      const models = this.modelViews(id);
      return {
        id,
        name: r.module.name,
        icon: r.module.icon ?? "",
        enabled: this.config.get(id).enabled,
        alias: this.aliasOf(id),
        pollLogin: r.module.pollLogin?.() ?? false,
        modelCount: models.length,
        enabledModelCount: models.filter((m) => m.enabled).length,
        models: models.filter((m) => m.enabled).map((m) => m.id),
        accounts: this.accountViews(id)
      };
    });
  }
  supplierDetail(id) {
    const runtime = this.runtimeById(id);
    if (runtime === undefined)
      return;
    const catalog = this.catalog.get(id);
    return {
      id,
      name: runtime.module.name,
      icon: runtime.module.icon ?? "",
      enabled: this.config.get(id).enabled,
      alias: this.aliasOf(id),
      pollLogin: runtime.module.pollLogin?.() ?? false,
      modelSource: catalog?.source === "upstream" ? "upstream" : "fallback",
      models: this.modelViews(id),
      accounts: this.accountViews(id),
      poolOrder: this.config.get(id).poolOrder
    };
  }
  resolveCombo(name) {
    const targets = this.combos.get(name);
    if (targets === undefined)
      return;
    return {
      name,
      targets: targets.map((raw) => {
        const slash = raw.indexOf("/");
        if (slash > 0) {
          const supplier = this.supplierByAlias(raw.slice(0, slash));
          if (supplier === undefined)
            return { raw, supplier: raw.slice(0, slash), model: raw.slice(slash + 1), ok: false };
          return { raw, supplier, model: raw.slice(slash + 1), ok: true };
        }
        const owners = this.activeRuntimes().filter((r) => this.enabledModelIds(r.module.id).includes(raw));
        if (owners.length > 0)
          return { raw, supplier: owners[0].module.id, model: raw, ok: true };
        return { raw, supplier: "", model: "", ok: false };
      })
    };
  }
  comboViews() {
    return this.combos.list().map((c) => this.resolveCombo(c.name)).filter((c) => c !== undefined);
  }
  resolveTargets(requested) {
    const combo = this.resolveCombo(requested);
    if (combo !== undefined) {
      const targets = combo.targets.filter((t) => t.ok && this.config.get(t.supplier).enabled).map((t) => ({ supplierId: t.supplier, model: t.model }));
      if (targets.length > 0)
        return targets;
    }
    const slash = requested.indexOf("/");
    if (slash > 0) {
      const supplier = this.supplierByAlias(requested.slice(0, slash));
      if (supplier !== undefined && this.config.get(supplier).enabled) {
        return [{ supplierId: supplier, model: requested.slice(slash + 1) }];
      }
    }
    const active = this.activeRuntimes();
    const matched = active.filter((r) => this.enabledModelIds(r.module.id).includes(requested));
    if (matched.length > 0)
      return matched.map((r) => ({ supplierId: r.module.id, model: requested }));
    const known = active.some((r) => (this.catalog.get(r.module.id)?.ids.length ?? 0) > 0);
    if (known)
      return [];
    return active.map((r) => ({ supplierId: r.module.id, model: requested }));
  }
  job(id) {
    return this.jobs.get(id);
  }
  startJob(type, supplierId) {
    const id = randomBytes3(8).toString("hex");
    const job = {
      id,
      type,
      supplierId,
      state: "running",
      message: "进行中",
      startedAt: Date.now()
    };
    this.jobs.set(id, job);
    this.pruneJobs();
    if (type === "login")
      this.runLoginJob(job);
    else if (type === "checkin")
      this.runCheckinJob(job);
    else
      this.runModelsJob(job);
    return { ...job };
  }
  finish(job, state, message, result) {
    job.state = state;
    job.message = message;
    job.result = result;
    job.finishedAt = Date.now();
  }
  async runLoginJob(job) {
    const runtime = this.runtimeById(job.supplierId);
    if (runtime === undefined || runtime.module.generateLoginUrl === undefined) {
      this.finish(job, "error", "该供应商不支持登录");
      return;
    }
    try {
      const r = await runtime.module.generateLoginUrl();
      if (typeof r === "string") {
        job.loginUrl = r;
        job.message = "请在浏览器完成登录";
      } else if (r.ok && r.loginUrl !== undefined) {
        job.loginUrl = r.loginUrl;
        job.message = "请在浏览器完成登录";
      } else {
        this.finish(job, "error", r.error ?? "生成登录链接失败");
        return;
      }
      if (runtime.module.pollLogin?.() === true && runtime.module.completeLogin !== undefined) {
        const account = await runtime.module.completeLogin("");
        this.finish(job, "ok", `已添加 ${account.nickname}（${account.uid}）`, account);
        return;
      }
      this.finish(job, "ok", "登录链接已生成");
    } catch (err) {
      this.finish(job, "error", err.message);
    }
  }
  async runCheckinJob(job) {
    const runtime = this.runtimeById(job.supplierId);
    if (runtime === undefined || runtime.module.checkinNow === undefined) {
      this.finish(job, "error", "该供应商不支持签到");
      return;
    }
    const accounts = runtime.module.status().accounts;
    if (accounts.length === 0) {
      this.finish(job, "error", "还没有账号，先添加链接");
      return;
    }
    const results = [];
    for (const a of accounts) {
      try {
        const r = await runtime.module.checkinNow(a.uid);
        results.push({ uid: a.uid, nickname: a.nickname ?? job.supplierId, ok: r.ok, status: r.status, message: r.message });
      } catch (err) {
        results.push({ uid: a.uid, nickname: a.nickname ?? job.supplierId, ok: false, status: "error", message: err.message });
      }
    }
    const okCount = results.filter((r) => r.ok).length;
    this.finish(job, "ok", `签到完成：${okCount}/${results.length} 成功`, results);
  }
  async runModelsJob(job) {
    try {
      const entry = await this.refreshCatalog(job.supplierId, true);
      const count = entry?.ids.length ?? 0;
      this.finish(job, "ok", count > 0 ? `拉到 ${count} 个模型` : "上游不可达，已保留当前列表", { count });
    } catch (err) {
      this.finish(job, "error", err.message);
    }
  }
  pruneJobs() {
    const cutoff = Date.now() - 10 * 60 * 1000;
    for (const [id, job] of this.jobs) {
      if (job.state !== "running" && (job.finishedAt ?? 0) < cutoff)
        this.jobs.delete(id);
    }
    if (this.jobs.size > 64) {
      for (const [id, job] of [...this.jobs].slice(0, this.jobs.size - 64)) {
        if (job.state !== "running")
          this.jobs.delete(id);
      }
    }
  }
  endpoint() {
    return `http://127.0.0.1:${this.endpointPort || this.settings.get().port || DEFAULT_PORT}/v1`;
  }
  syncOpencode(force = false) {
    return syncOpencode(this, force);
  }
  syncQuietly() {
    try {
      this.syncOpencode(false);
    } catch {}
  }
  afterCatalogChange() {
    this.syncOpencode(false);
  }
  settingsView() {
    return {
      requireApiKey: this.keys.requireApiKey,
      port: this.settings.get().port || this.endpointPort || DEFAULT_PORT,
      opencodeSync: this.settings.get().opencodeSync
    };
  }
  state() {
    const opencode = this.syncOpencode(false);
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
      now: Date.now()
    };
  }
  dispose() {
    this.tps.dispose();
    for (const r of this.runtimes) {
      try {
        r.module.dispose();
      } catch {}
    }
    this.usage.flush();
  }
}

// service/main.ts
function log(message) {
  console.error(`[ocber-router] ${message}`);
}
async function main() {
  const adminPort = Number(process.env.OPENCHAMBER_SERVICE_PORT);
  const serviceToken = process.env.OPENCHAMBER_SERVICE_TOKEN ?? "";
  if (!Number.isInteger(adminPort) || adminPort <= 0 || serviceToken === "") {
    log("缺少 OPENCHAMBER_SERVICE_PORT / OPENCHAMBER_SERVICE_TOKEN，退出");
    process.exit(1);
  }
  const dataDir = resolveDataDir();
  const app = new App(dataDir, log);
  log(`v${VERSION} starting, data=${dataDir}`);
  const server = await startServer(app, serviceToken, adminPort);
  log(`ready: admin=127.0.0.1:${adminPort} endpoint=http://127.0.0.1:${server.publicPort}/v1`);
  app.warmupCatalog();
  let shuttingDown = false;
  const shutdown = async (signal) => {
    if (shuttingDown)
      return;
    shuttingDown = true;
    log(`shutting down (${signal})`);
    try {
      await server.close();
    } catch {}
    app.dispose();
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}
main().catch((err) => {
  log(`fatal: ${err.message}`);
  process.exit(1);
});
