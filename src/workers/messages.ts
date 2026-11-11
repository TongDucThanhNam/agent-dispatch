import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { StringDecoder } from 'node:string_decoder';
import { writeFileAtomic } from '../core/fsutil.ts';

export interface MessagesProfile {
  kind: 'claude' | 'grok';
  label: string;
  aliases?: readonly string[];
  normalizeModel?: (model: string) => string;
  errorOf: (raw: any, code?: string | null) => any;
}

const uuid = value => /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value ?? '');
const modelName = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9:._/-]{0,199}(?:\[1m\])?$/.test(value);
const finite = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
const json = value => JSON.stringify(value);
const normalized = value => { const resolved = fs.realpathSync(value); return process.platform === 'win32' ? resolved.toLowerCase() : resolved; };
const textOf = value => typeof value === 'string' ? value : Array.isArray(value)
  ? value.map(block => block?.type === 'text' ? block.text : block?.type === 'image' ? '[image]' : '').filter(Boolean).join('\n') : '';

/** Run-local Messages-stream projection; never edits native transcripts, preferences or credentials. */
export function createMessagesProjection(config, profile: MessagesProfile, { prompt, startedAt = Date.now(), now = Date.now, onSession = (_id?: any) => {}, onModel = (_model?: any) => {} }: any = {}) {
  const { kind, label, aliases = [], normalizeModel = (value: string) => value, errorOf } = profile;
  if (path.resolve(config.dbPath) !== path.join(config.runDir, `${kind}-events.sqlite`)) throw new Error(`${label} telemetry must be inside its run directory.`);
  if (fs.existsSync(config.dbPath)) throw new Error(`${label} telemetry already exists; inspect the run instead of duplicating it.`);
  const db = new DatabaseSync(config.dbPath);
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=500;
    CREATE TABLE session(id TEXT PRIMARY KEY,directory TEXT,parent_id TEXT,time_created INTEGER,time_updated INTEGER);
    CREATE TABLE message(id TEXT PRIMARY KEY,session_id TEXT,time_created INTEGER,time_updated INTEGER,data TEXT);
    CREATE INDEX message_session ON message(session_id,time_created);
    CREATE TABLE part(id TEXT PRIMARY KEY,message_id TEXT,session_id TEXT,time_created INTEGER,time_updated INTEGER,data TEXT);
    CREATE INDEX part_session ON part(session_id,time_created);
    CREATE INDEX part_message ON part(message_id);
    CREATE TABLE todo(session_id TEXT,content TEXT,status TEXT,position INTEGER);
    CREATE TABLE model_usage(id TEXT PRIMARY KEY,logical_request_id TEXT,attempt_index INTEGER,status TEXT,provider_id TEXT,model_id TEXT,
      started_at INTEGER,completed_at INTEGER,input_tokens INTEGER,output_tokens INTEGER,cache_read_input_tokens INTEGER,retry_count INTEGER,
      error_code TEXT,error_message TEXT,session_id TEXT,assistant_message_id TEXT,reasoning_tokens INTEGER,first_token_at INTEGER,duration_ms INTEGER,
      cache_creation_input_tokens INTEGER,finish_reason TEXT,tool_call_count INTEGER);`);
  const putMessage = db.prepare('INSERT INTO message VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET time_updated=excluded.time_updated,data=excluded.data');
  const putPart = db.prepare('INSERT INTO part VALUES(?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET time_updated=excluded.time_updated,data=excluded.data');
  const putUsage = db.prepare(`INSERT INTO model_usage VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET
    status=excluded.status,completed_at=excluded.completed_at,input_tokens=excluded.input_tokens,output_tokens=excluded.output_tokens,
    cache_read_input_tokens=excluded.cache_read_input_tokens,cache_creation_input_tokens=excluded.cache_creation_input_tokens,
    reasoning_tokens=excluded.reasoning_tokens,first_token_at=excluded.first_token_at,duration_ms=excluded.duration_ms,
    finish_reason=excluded.finish_reason,tool_call_count=excluded.tool_call_count`);
  const requests = new Map<string, any>(), active = new Map<string, any>(), calls = new Map<string, any>();
  const sessionIds = new Set<string>(), nextStart = new Map<string, number>();
  let sessionId: any = null, resolvedModel: any = null, terminal: any = null, lastError: any = null, closed = false, sequence = 0;
  const touch = (id, at) => db.prepare('UPDATE session SET time_updated=? WHERE id=?').run(at, id);
  function initialize(record, at) {
    if (!uuid(record.session_id)) throw new Error(`${label} returned an invalid session ID.`);
    if (sessionId && sessionId !== record.session_id) throw new Error(`${label} changed session during this run.`);
    if (config.resumeSessionId && config.resumeSessionId !== record.session_id) throw new Error(`${label} resumed a different session.`);
    if (normalized(record.cwd ?? '') !== normalized(config.project)) throw new Error(`${label} reported a different working directory.`);
    if (record.permissionMode !== (config.mode === 'plan' ? 'plan' : 'bypassPermissions')) throw new Error(`${label} did not activate the requested permission mode.`);
    if (!modelName(record.model) || record.model === 'unknown') throw new Error(`${label} did not report a usable model selection.`);
    const model = normalizeModel(record.model), expected = config[`${kind}ResolvedModel`] ?? config[`${kind}Model`];
    if (expected && !aliases.includes(normalizeModel(expected) as any) && normalizeModel(expected) !== model) throw new Error(`${label} reported a different model selection.`);
    if (sessionId) { if (model !== resolvedModel) throw new Error(`${label} changed model during this run.`); return; }
    sessionId = record.session_id; resolvedModel = model;
    config[`${kind}ResolvedModel`] = model; config.expectedModel = model;
    db.prepare('INSERT INTO session VALUES(?,?,?,?,?)').run(sessionId, config.project, null, startedAt, at); sessionIds.add(sessionId);
    putMessage.run(`${kind}-input`, sessionId, startedAt, at, json({ role: 'user' }));
    putPart.run(`${kind}-input-text`, `${kind}-input`, sessionId, startedAt, at, json({ type: 'text', text: prompt }));
    nextStart.set(sessionId, startedAt); onModel(model); onSession(sessionId);
  }
  function sessionFor(record, at) {
    if (!sessionId) throw new Error(`${label} emitted content before session initialization.`);
    if (!record.parent_tool_use_id) {
      if (record.session_id && record.session_id !== sessionId) throw new Error(`${label} event belongs to a different session.`);
      return sessionId;
    }
    if (typeof record.parent_tool_use_id !== 'string' || !/^[A-Za-z0-9_-]{1,200}$/.test(record.parent_tool_use_id)) throw new Error(`${label} returned an invalid subagent parent.`);
    const id = `${kind}-subagent-` + record.parent_tool_use_id;
    if (!sessionIds.has(id)) {
      db.prepare('INSERT INTO session VALUES(?,?,?,?,?)').run(id, config.project, calls.get(record.parent_tool_use_id)?.session ?? sessionId, at, at);
      sessionIds.add(id); nextStart.set(id, at);
    }
    return id;
  }
  function request(message, session, at) {
    if (!message || typeof message.id !== 'string' || !/^[A-Za-z0-9_-]{1,200}$/.test(message.id)) throw new Error(`${label} returned an invalid assistant message.`);
    const model = normalizeModel(message.model || resolvedModel);
    // Error pseudo-messages use a synthetic model; the terminal error is authoritative.
    if (session === sessionId && model !== resolvedModel && model !== '<synthetic>') throw new Error(`${label} changed the pinned model during this run.`);
    const key = session + ':' + message.id;
    let req = requests.get(key);
    if (!req) {
      req = { id: `${kind}-` + (session === sessionId ? '' : session + '-') + message.id, messageId: message.id, session, model: model === '<synthetic>' ? resolvedModel : model,
        start: nextStart.get(session) ?? at, end: null, firstToken: null, usage: {}, blocks: new Map(), fingerprints: new Set(), status: 'running', finish: null };
      requests.set(key, req);
    }
    active.set(session, req);
    for (const [key, value] of Object.entries(message.usage ?? {})) if (finite(value) != null) req.usage[key] = Math.max(req.usage[key] ?? 0, value as number);
    // Thinking is billed inside output_tokens; the breakdown, when the API returns it, is the only separate count.
    const thinking = finite(message.usage?.output_tokens_details?.thinking_tokens);
    if (thinking != null) req.usage.thinking_tokens = Math.max(req.usage.thinking_tokens ?? 0, thinking);
    if (message.stop_reason) req.finish = message.stop_reason;
    return req;
  }
  function saveRequest(req, at) {
    putMessage.run(req.id, req.session, req.start, at, json({ role: 'assistant', modelID: req.model, providerID: kind, time: { created: req.start, ...(req.end ? { completed: req.end } : {}) } }));
    const u = req.usage, known = ['input_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens'].some(key => finite(u[key]) != null);
    // Messages cache buckets are separate; store the complete prompt size like ZCode.
    const input = known ? (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) : null;
    putUsage.run(req.id, req.id, 0, req.status, kind, req.model, req.start, req.end, input, finite(u.output_tokens), finite(u.cache_read_input_tokens), 0,
      null, null, req.session, req.id, finite(u.thinking_tokens), req.firstToken, req.end != null ? req.end - req.start : null, finite(u.cache_creation_input_tokens), req.finish,
      [...req.blocks.values()].filter(block => block.type === 'tool_use' || block.type === 'server_tool_use').length);
    touch(req.session, at);
  }
  function saveBlock(req, index, block, at) {
    req.blocks.set(index, block);
    if (block.type === 'tool_use' || block.type === 'server_tool_use') {
      if (typeof block.id !== 'string' || !/^[A-Za-z0-9_-]{1,200}$/.test(block.id)) throw new Error(`${label} returned an invalid tool call.`);
      const previous = calls.get(block.id), call = { ...previous, id: `${kind}-call-` + block.id, callId: block.id, message: req.id, session: req.session,
        start: previous?.start ?? at, tool: block.name ?? 'Tool', input: block.input ?? previous?.input, status: previous?.status ?? 'running' };
      calls.set(block.id, call); saveCall(call, at);
    } else if (block.type === 'web_search_tool_result') {
      const call = calls.get(block.tool_use_id);
      if (!call || call.session !== req.session) throw new Error(`${label} returned a result for an unknown search.`);
      // Keep source URLs and titles for on-demand content/export, not in status/callbacks.
      call.output = typeof block.content === 'string' ? block.content : json(block.content);
      call.status = block.content?.type === 'web_search_tool_result_error' ? 'error' : 'completed';
      call.error = call.status === 'error' ? call.output : null; call.end = at; saveCall(call, at);
    } else if (block.type === 'text' || block.type === 'thinking') {
      putPart.run(req.id + '-' + index, req.id, req.session, req.start, at, json({ type: block.type === 'thinking' ? 'reasoning' : 'text', text: block.text ?? block.thinking ?? '' }));
    }
  }
  function saveCall(call, at) {
    putPart.run(call.id, call.message, call.session, call.start, at, json({ type: 'tool', tool: call.tool, callID: call.callId,
      state: { status: call.status, input: call.input, output: call.output, ...(call.error ? { error: call.error } : {}), time: { start: call.start, ...(call.end ? { end: call.end } : {}) } } }));
    if (call.tool === 'TodoWrite' && Array.isArray(call.input?.todos)) {
      db.prepare('DELETE FROM todo WHERE session_id=?').run(call.session);
      call.input.todos.forEach((todo, position) => { if (typeof todo?.content === 'string') db.prepare('INSERT INTO todo VALUES(?,?,?,?)').run(call.session, todo.content, todo.status ?? 'pending', position); });
    }
    touch(call.session, at);
  }
  function stream(record, session, at) {
    const event = record.event;
    if (!event || typeof event.type !== 'string') throw new Error(`${label} emitted an invalid partial event.`);
    if (event.type === 'message_start') {
      const req = request(event.message, session, at);
      if (finite(record.ttft_ms) != null) req.start = Math.max(startedAt, at - record.ttft_ms);
      saveRequest(req, at); return;
    }
    if (event.type === 'ping') return;
    const req = active.get(session); if (!req) throw new Error(`${label} emitted a partial event without an assistant message.`);
    const index = event.index;
    if (event.type === 'content_block_start' || event.type === 'content_block_delta' || event.type === 'content_block_stop') {
      if (!Number.isSafeInteger(index) || index < 0) throw new Error(`${label} returned an invalid content block index.`);
      if (event.type === 'content_block_start') saveBlock(req, index, { ...event.content_block }, at);
      else {
        const block = req.blocks.get(index); if (!block) throw new Error(`${label} updated an unknown content block.`);
        const delta = event.delta;
        if (event.type === 'content_block_delta') {
          if (delta?.type === 'text_delta') block.text = (block.text ?? '') + delta.text;
          else if (delta?.type === 'thinking_delta') block.thinking = (block.thinking ?? '') + delta.thinking;
          else if (delta?.type === 'input_json_delta') block.partialJson = (block.partialJson ?? '') + delta.partial_json;
          if (['text_delta', 'thinking_delta', 'input_json_delta'].includes(delta?.type)) req.firstToken ??= at;
        } else if (block.partialJson) { try { block.input = JSON.parse(block.partialJson); } catch { throw new Error(`${label} emitted invalid tool input JSON.`); } }
        saveBlock(req, index, block, at);
      }
    } else if (event.type === 'message_delta') {
      request({ id: req.messageId, model: req.model, usage: event.usage, stop_reason: event.delta?.stop_reason }, session, at);
    } else if (event.type === 'message_stop') { req.end = at; req.status = 'completed'; nextStart.set(session, at); }
    saveRequest(req, at);
  }
  function assistant(record, session, at) {
    const req = request(record.message, session, at);
    if (!Array.isArray(record.message.content)) throw new Error(`${label} returned invalid assistant content.`);
    for (const block of record.message.content) {
      const fingerprint = json(block); if (req.fingerprints.has(fingerprint)) continue; req.fingerprints.add(fingerprint);
      let index = [...req.blocks].find(([, existing]) => existing.type === block.type && (block.id ? existing.id === block.id
        : (existing.text ?? existing.thinking ?? '') === (block.text ?? block.thinking ?? '')))?.[0];
      index ??= req.blocks.size ? Math.max(...req.blocks.keys()) + 1 : 0;
      saveBlock(req, index, { ...req.blocks.get(index), ...block }, at);
    }
    if (req.finish) { req.end = at; req.status = 'completed'; nextStart.set(session, at); }
    if (record.aborted) req.status = 'cancelled';
    saveRequest(req, at);
    if (record.error) {
      const error = errorOf(textOf(record.message.content), record.error);
      if (session === sessionId) lastError = error;
      putMessage.run(`${kind}-error-` + (++sequence), session, at, at, json({ role: 'system', error }));
    } else if (session === sessionId) lastError = null;
  }
  function user(record, session, at) {
    for (const block of Array.isArray(record.message?.content) ? record.message.content : []) {
      if (block?.type !== 'tool_result') continue;
      const call = calls.get(block.tool_use_id); if (!call || call.session !== session) throw new Error(`${label} returned a result for an unknown tool call.`);
      call.callId = block.tool_use_id; call.output = textOf(block.content); call.status = block.is_error ? 'error' : 'completed';
      call.error = block.is_error ? call.output || 'Tool failed.' : null; call.end = at; saveCall(call, at); nextStart.set(session, at);
    }
    const text = textOf(record.message?.content);
    if (text) {
      const id = `${kind}-context-` + (++sequence);
      putMessage.run(id, session, at, at, json({ role: 'user', synthetic: true, semantics: { origin: 'runtime', kind: 'injected_context' } }));
      putPart.run(id + '-text', id, session, at, at, json({ type: 'text', text }));
    }
    touch(session, at);
  }
  function finish(record, at) {
    if (typeof record.subtype !== 'string' || typeof record.is_error !== 'boolean') throw new Error(`${label} returned an invalid terminal result.`);
    if (sessionId && record.session_id !== sessionId) throw new Error(`${label} result belongs to a different session.`);
    const success = record.subtype === 'success' && !record.is_error;
    if (success && !sessionId) throw new Error(`${label} success has no verified session.`);
    const messages = Array.isArray(record.errors) ? record.errors.filter(value => typeof value === 'string') : [];
    const error = !success ? errorOf({ message: messages.join('\n') || record.result || `${label} ended with ${record.subtype}.`, api_error_status: record.api_error_status },
      record.subtype === 'error_during_execution' ? lastError?.code ?? null : null) : null;
    terminal = { sessionId, response: typeof record.result === 'string' ? record.result : '', [`${kind}Status`]: record.subtype,
      ...(error ? { isError: true, error } : {}), ...(record.stop_reason === 'cancelled' ? { cancelled: true } : {}), usage: record.usage ?? null, modelUsage: record.modelUsage ?? null,
      costUsd: finite(record.total_cost_usd), turns: finite(record.num_turns), permissionDenials: record.permission_denials ?? [] };
    // Terminal usage is aggregate (including subagents); never add it to per-message rows.
    if (sessionId) {
      if (error) putMessage.run(`${kind}-terminal-error`, sessionId, at, at, json({ role: 'system', error }));
      touch(sessionId, at);
    }
  }
  return {
    get sessionId() { return sessionId; }, get terminal() { return terminal; },
    ingest(record) {
      if (closed) throw new Error(`${label} projection is closed.`);
      if (!record || typeof record !== 'object' || typeof record.type !== 'string') throw new Error(`${label} emitted an invalid stream event.`);
      if (terminal) return; // Newer CLIs can send informational events after the final result.
      const at = now(); db.exec('BEGIN');
      try {
        if (record.type === 'system' && record.subtype === 'init' && !record.parent_tool_use_id) initialize(record, at);
        else if (record.type === 'result' && !record.parent_tool_use_id) finish(record, at);
        else if (record.type === 'error' && kind === 'grok') {
          const error = errorOf(record);
          terminal = { sessionId, isError: true, error };
          if (sessionId) putMessage.run(`${kind}-terminal-error`, sessionId, at, at, json({ role: 'system', error }));
        }
        else if (['stream_event', 'assistant', 'user'].includes(record.type)) {
          const session = sessionFor(record, at);
          if (record.type === 'stream_event') stream(record, session, at);
          else if (record.type === 'assistant') assistant(record, session, at); else user(record, session, at);
        } else if (record.type === 'system' && record.subtype === 'compact_boundary') {
          const session = sessionFor(record, at), id = `${kind}-compact-` + (++sequence);
          putMessage.run(id, session, at, at, json({ role: 'system' }));
          putPart.run(id, id, session, at, at, json({ type: 'compaction', trigger: record.compact_metadata?.trigger, preCompactTokenCount: record.compact_metadata?.pre_tokens, time: { start: at, end: at } }));
          touch(session, at);
        } else if (record.type === 'system' && record.subtype === 'api_retry' && sessionId) {
          const id = `${kind}-retry-` + (++sequence), error = errorOf({ message: record.error || `${label} is retrying an API request.`, httpStatus: record.error_status }, record.error);
          putMessage.run(id, sessionId, at, at, json({ role: 'system' }));
          putPart.run(id, id, sessionId, at, at, json({ type: 'retry', attempt: record.attempt, error, time: { start: at } })); touch(sessionId, at);
        }
        db.exec('COMMIT');
      } catch (error) { db.exec('ROLLBACK'); throw error; }
    },
    close() { if (!closed) { closed = true; db.close(); } }
  };
}

export function startMessagesWorker(config, profile: MessagesProfile, invocation, { prompt, startedAt, stderrFd, onSession, onModel, onFailure, onLingering, onNotice },
  { spawnFn = spawn, exitGraceMs = 30_000, pipeGraceMs = 5_000 }: any = {}) {
  const { kind, label } = profile;
  const projection = createMessagesProjection(config, profile, { prompt, startedAt, onSession, onModel });
  let log: any, child: any;
  try {
    log = fs.openSync(path.join(config.runDir, `${kind}-events.jsonl`), 'wx');
    child = spawnFn(invocation.command, invocation.args, { cwd: config.project, env: invocation.env, shell: false, windowsHide: true,
      detached: process.platform !== 'win32', stdio: [invocation.promptFile ? 'ignore' : 'pipe', 'pipe', stderrFd] });
  } catch (error) { if (log != null) fs.closeSync(log); projection.close(); throw error; }
  let buffer = '', failure: any = null, finalized = false, drained = false, exitTimer: any = null, pipeTimer: any = null;
  const decoder = new StringDecoder('utf8');
  const fail = error => { if (!failure) { failure = error; onFailure?.(error); } };
  const processLine = line => {
    if (!line.trim() || failure || projection.terminal) return;
    try { projection.ingest(JSON.parse(line)); } catch (error) { fail(new Error(`${label} event stream could not be read: ` + error.message)); }
    if (projection.terminal && !exitTimer && !finalized) {
      exitTimer = setTimeout(() => { if (!finalized && child.exitCode === null && child.signalCode === null) onLingering?.(); }, exitGraceMs); exitTimer.unref?.();
    }
  };
  const flush = () => { if (drained) return; drained = true; buffer += decoder.end(); if (buffer.trim()) processLine(buffer); buffer = ''; };
  child.stdout.on('data', chunk => {
    if (finalized) return;
    try {
      fs.writeSync(log, chunk); if (projection.terminal) return;
      buffer += decoder.write(chunk);
      let index; while ((index = buffer.indexOf('\n')) >= 0) { const line = buffer.slice(0, index); buffer = buffer.slice(index + 1); processLine(line); }
      if (projection.terminal) buffer = '';
      else if (buffer.length > 16_000_000) { buffer = ''; fail(new Error(`${label} emitted an oversized stream event.`)); }
    } catch (error) { fail(error); }
  });
  child.stdout.on('end', flush); child.stdout.on('error', fail);
  child.stdin?.on('error', error => { if (!projection.terminal && (error as any).code !== 'EPIPE') fail(error); });
  child.stdin?.end(prompt);
  child.once('exit', () => {
    pipeTimer = setTimeout(() => { if (finalized) return; onNotice?.(`${label} exited but another process still holds its output; the runner stopped waiting.`); child.stdout.destroy(); child.stdin?.destroy(); }, pipeGraceMs); pipeTimer.unref?.();
  });
  return { child, finalize() {
    if (finalized) return; finalized = true; clearTimeout(exitTimer); clearTimeout(pipeTimer); flush();
    const result = failure ? { sessionId: projection.sessionId, isError: true, error: { message: failure.message } }
      : projection.terminal ?? { sessionId: projection.sessionId, isError: true, error: { message: `${label} exited without a terminal result; completion is unconfirmed.` } };
    try { writeFileAtomic(path.join(config.runDir, 'result.json'), json(result) + '\n'); } finally { fs.closeSync(log); projection.close(); }
  } };
}
