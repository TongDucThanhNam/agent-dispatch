import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import { DatabaseSync } from 'node:sqlite';
import { writeFileAtomic, sleep } from '../../core/fsutil.ts';
import { MCODE_API, probeMcode, resolveMcodeSelection, verifyMcodeSession } from './desktop.ts';

const json = JSON.stringify;
const finite = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
const parse = value => { try { return JSON.parse(value); } catch { return value; } };

/** An incremental SSE decoder, including multiline data and split UTF-8/CRLF. */
export async function readMcodeSse(body: ReadableStream<Uint8Array>, onFrame: (frame: any) => void) {
  const reader = body.getReader(), decoder = new TextDecoder('utf-8', { fatal: true });
  let pending = '', data: string[] = [], event = 'message';
  const line = (value: string) => {
    if (!value) {
      if (data.length) onFrame({ event, data: JSON.parse(data.join('\n')) });
      data = []; event = 'message'; return;
    }
    if (value.startsWith(':')) return;
    const colon = value.indexOf(':'), field = colon < 0 ? value : value.slice(0, colon);
    const content = colon < 0 ? '' : value.slice(colon + 1).replace(/^ /, '');
    if (field === 'data') data.push(content);
    if (field === 'event') event = content;
    if (data.reduce((n, s) => n + s.length, 0) > 16_000_000) throw Error('MiniMax Desktop emitted an oversized SSE frame.');
  };
  const drain = (end = false) => {
    let index: number;
    while ((index = pending.indexOf('\n')) >= 0) { line(pending.slice(0, index).replace(/\r$/, '')); pending = pending.slice(index + 1); }
    if (pending.length > 16_000_000) throw Error('MiniMax Desktop emitted an oversized SSE line.');
    if (end) { if (pending) line(pending.replace(/\r$/, '')); line(''); }
  };
  try {
    while (true) { const value = await reader.read(); if (value.done) break; pending += decoder.decode(value.value, { stream: true }); drain(); }
    pending += decoder.decode(); drain(true);
  } finally { try { await reader.cancel(); } finally { reader.releaseLock(); } }
}

export function createMcodeProjection(config: any, { prompt, startedAt = Date.now(), now = Date.now, onSession = (_id: string) => {} }: any) {
  if (path.resolve(config.dbPath) !== path.join(config.runDir, 'mcode-events.sqlite') || fs.existsSync(config.dbPath)) throw Error('MiniMax telemetry must be a fresh run-local database.');
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
      error_code TEXT,error_message TEXT,session_id TEXT,assistant_message_id TEXT,reasoning_tokens INTEGER,first_token_at INTEGER,duration_ms INTEGER);`);
  const putMessage = db.prepare('INSERT INTO message VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET time_updated=excluded.time_updated,data=excluded.data');
  const putPart = db.prepare('INSERT INTO part VALUES(?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET time_updated=excluded.time_updated,data=excluded.data');
  const putUsage = db.prepare('INSERT OR REPLACE INTO model_usage VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)');
  const messages = new Map<string, any>(), tools = new Map<string, any>(), cursors = new Set<string>();
  let sessionId: string | null = null, closed = false, done = false, finished = false, response = '', nativeError: any = null;
  const assistant = (at, end = false) => ({ role: 'assistant', modelID: config.expectedModel, providerID: config.expectedProvider,
    time: { created: at, ...(end ? { completed: now() } : {}) } });
  const touch = () => db.prepare('UPDATE session SET time_updated=? WHERE id=?').run(now(), sessionId);
  const scoped = (value: any) => {
    const sid = value.session_id, tid = value.turn_id ?? value.turnId;
    if ((sid && sid !== sessionId) || (tid && tid !== config.mcodeTurnId)) throw Error('MiniMax event belongs to a different session or turn.');
  };
  function message(value: any, complete: boolean) {
    scoped(value);
    if (value.role !== 'assistant') return;
    if (typeof value.msg_id !== 'string' || !value.msg_id) throw Error('MiniMax returned an invalid message ID.');
    const observedModel = value.context_usage_telemetry?.model;
    if (observedModel && observedModel !== config.expectedModel) throw Error('MiniMax returned a different runtime model.');
    const id = `mcode:${value.msg_id}`, at = now();
    const prev = messages.get(id) ?? { start: at, text: '', thinking: '', chunks: new Set<number>(), firstToken: null };
    if (!complete) {
      if (!Number.isSafeInteger(value.chunk_index) || value.chunk_index < 0) throw Error('MiniMax returned an invalid chunk index.');
      if (prev.chunks.has(value.chunk_index)) return;
      prev.chunks.add(value.chunk_index);
    }
    if (typeof value.msg_content === 'string') prev.text = complete ? value.msg_content : prev.text + value.msg_content;
    if (typeof value.thinking_content === 'string') prev.thinking = complete ? value.thinking_content : prev.thinking + value.thinking_content;
    if ((value.msg_content || value.thinking_content) && prev.firstToken == null) prev.firstToken = at;
    messages.set(id, prev);
    putMessage.run(id, sessionId, prev.start, at, json(assistant(prev.start, complete)));
    if (prev.text) putPart.run(id + ':text', id, sessionId, prev.start, at, json({ type: 'text', text: prev.text }));
    if (prev.thinking) putPart.run(id + ':reasoning', id, sessionId, prev.start, at, json({ type: 'reasoning', text: prev.thinking }));
    for (const tool of value.tool_calls ?? []) {
      if (typeof tool.tool_call_id !== 'string') throw Error('MiniMax returned an invalid tool-call ID.');
      const key = 'mcode:tool:' + tool.tool_call_id, previous = tools.get(key) ?? { start: at, args: '' };
      const next = { ...previous, ...tool, args: typeof tool.tool_call_args === 'string' ? tool.tool_call_args : previous.args + (tool.tool_call_args_delta ?? '') };
      tools.set(key, next);
      const status = ({ 1: 'running', 2: 'completed', 3: 'error', 4: 'pending', 5: 'pending' })[next.tool_call_status] ?? 'recorded';
      putPart.run(key, id, sessionId, next.start, at, json({ type: 'tool', callID: tool.tool_call_id, tool: next.tool_name ?? 'Tool',
        state: { status, input: parse(next.args), output: next.tool_call_result_data, error: next.tool_call_error,
          time: { start: next.start, ...(['completed', 'error'].includes(status) ? { end: at } : {}) } } }));
    }
    if (complete) {
      const u = value.usage;
      putUsage.run(id, id, 0, 'completed', config.expectedProvider, config.expectedModel, prev.start, at,
        finite(u?.input_tokens), finite(u?.output_tokens), finite(u?.cache_read), 0, null, null, sessionId, id,
        finite(u?.reasoning_tokens), prev.firstToken, finite(u?.request_duration_ms));
      if (value.finish_reason === 'stop' && prev.text) response = prev.text;
      if (value.finish_reason === 'error') nativeError = { message: 'MiniMax Desktop returned an assistant error.' };
    }
  }
  return {
    get sessionId() { return sessionId; },
    get active() { return !done && !finished && !closed; },
    get terminal() { return done && finished && response && !nativeError ? { sessionId, response } : null; },
    initialize(session: any) {
      if (closed || sessionId) throw Error('MiniMax projection is already initialized or closed.');
      verifyMcodeSession(config, session, config.resumeSessionId || undefined);
      sessionId = session.session_id;
      db.prepare('INSERT INTO session VALUES(?,?,?,?,?)').run(sessionId, config.project, null, startedAt, now());
      putMessage.run('mcode-input', sessionId, startedAt, now(), json({ role: 'user' }));
      putPart.run('mcode-input:text', 'mcode-input', sessionId, startedAt, now(), json({ type: 'text', text: prompt }));
      onSession(sessionId!);
    },
    ingest(frame: any) {
      if (closed || !sessionId) throw Error('MiniMax projection is not active.');
      if (!frame || typeof frame !== 'object') throw Error('Invalid MiniMax desktop frame.');
      if (frame.sse_error_code || frame.error || frame.key) throw Error('MiniMax desktop stream failed: ' + (frame.message ?? frame.key ?? 'runtime error'));
      if (done) throw Error('MiniMax emitted data after its terminal marker.');
      if (frame.cursor) { if (cursors.has(frame.cursor)) return; cursors.add(frame.cursor); }
      const raw = frame.data_json ?? frame.event_json;
      if (raw === '[DONE]') { done = true; return; }
      if (raw === undefined) return; // native action-delta-only frames
      if (typeof raw !== 'string') throw Error('Invalid MiniMax event payload.');
      const value = JSON.parse(raw); scoped(value);
      if (value.schema && value.schema !== 'archon.runtime.event.v1') throw Error('Unsupported MiniMax runtime event schema.');
      db.exec('BEGIN');
      try {
        if (value.agent_message) message(value.agent_message, true);
        if (value.agent_message_chunk) message(value.agent_message_chunk, false);
        const status = value.session_status?.type;
        if (status === 'finished') finished = true;
        if (['error', 'aborted', 'cancelled'].includes(status) || value.payload?.error || value.payload?.trace?.phase === 'turn_failed')
          nativeError = { message: value.payload?.error?.message ?? `MiniMax Desktop turn ended with ${status ?? 'an error'}.` };
        if (nativeError) throw Error(nativeError.message);
        touch(); db.exec('COMMIT');
      } catch (error) { db.exec('ROLLBACK'); throw error; }
    },
    close() { if (!closed) { closed = true; db.close(); } },
  };
}

/** Own a remote desktop turn, not the Electron process. No CLI or SDK backend. */
export function startMcode(config: any, { prompt, startedAt, onSession, onNotice, onFailure }: any, deps: any = {}) {
  const projection = createMcodeProjection(config, { prompt, startedAt, onSession });
  const log = fs.openSync(path.join(config.runDir, 'mcode-events.jsonl'), 'wx');
  const child: any = new EventEmitter(); child.pid = null; child.exitCode = null; child.signalCode = null;
  const controller = new AbortController();
  config.mcodeTurnId = config.mcodeTurnId ?? `dispatch-${crypto.randomUUID()}`;
  let client: any, submitted = false, ended = false, stopping = false, failure: any = null, permissions: any, pollBusy = false;
  let delivery: Promise<any> | undefined;
  const close = (code: number) => { if (ended) return; ended = true; clearInterval(permissions); child.exitCode = code; child.emit('close', code, null); };
  const abortOwnedTurn = async () => {
    if (!projection.sessionId || !submitted) return;
    // A stop must not race a still-being-delivered POST and "abort" an idle
    // session before that POST starts a turn. Do not cancel transport as proof.
    if (delivery) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try { await Promise.race([delivery.catch(() => {}), new Promise((_, reject) => {
        timer = setTimeout(() => reject(Error('Desktop message delivery is still unconfirmed; cannot confirm cancellation.')), 15_000);
      })]); } finally { clearTimeout(timer); }
    }
    const result = await client.request(`${MCODE_API}/session/${projection.sessionId}/abort`, { body: { turn_id: config.mcodeTurnId, reason: 'agent-dispatch stopped this owned turn' } });
    if (result.success !== true) throw Error('Desktop did not confirm abort of the dispatched turn.');
    for (let i = 0; i < 30; i++) {
      const value = await client.request(`${MCODE_API}/session/${projection.sessionId}`);
      if (value.session?.session_id !== projection.sessionId || ![0, 1, 2, 3].includes(value.session?.status?.status_type))
        throw Error('Desktop did not return a verifiable session release status.');
      if ([0, 2, 3].includes(value.session.status.status_type)) return;
      await sleep(200);
    }
    throw Error('Desktop turn release is unconfirmed; session ownership is retained.');
  };
  child.stop = async () => {
    if (ended) return;
    stopping = true;
    try { await abortOwnedTurn(); controller.abort(); close(130); }
    catch (error) { stopping = false; throw error; }
  };
  const run = async () => {
    try {
      const runtime = await (deps.probe ?? probeMcode)(config); client = runtime.client;
      if (ended || stopping) return;
      resolveMcodeSelection(config, runtime);
      const model = { provider_id: config.expectedProvider, model_id: config.expectedModel,
        ...(config.mcodeVariant != null ? { variant: config.mcodeVariant } : {}),
        ...(config.mcodeEffort ? { thinking: { effort: config.mcodeEffort } } : {}) };
      const value = config.resumeSessionId ? await client.request(`${MCODE_API}/session/${config.resumeSessionId}`)
        : await client.request(`${MCODE_API}/agent/${encodeURIComponent(config.mcodeAgent)}/session`, {
          body: { workspace_dir: config.project, title: `Dispatch ${config.runId}`, app_mode: 'coding', model, team_mode_off: true } });
      verifyMcodeSession(config, value.session, config.resumeSessionId || undefined);
      if (value.session.status?.status_type === 1) throw Error('The saved desktop session is already running; it will not be taken over.');
      if (ended || stopping) return;
      projection.initialize(value.session);
      // Only session-scoped AllowOnce replies; never alter global permissions or approve other sessions.
      permissions = setInterval(() => {
        if (pollBusy || ended || stopping || !projection.active) return; pollBusy = true;
        void (async () => {
          const pending = await client.request(MCODE_API + '/permission/requests');
          for (const request of pending.requests ?? []) if (request.session_id === projection.sessionId && request.agent_name === config.mcodeAgent) {
            if (ended || stopping || !projection.active) break;
            const reply = await client.request(`${MCODE_API}/agent/${encodeURIComponent(config.mcodeAgent)}/permission/${encodeURIComponent(request.request_id)}/reply`, { body: { reply: 0 } });
            if (reply.success !== true) throw Error('Desktop permission reply was not accepted.');
          }
          const question = await client.request(`${MCODE_API}/agent/${encodeURIComponent(config.mcodeAgent)}/questionnaire/pending?session_id=${projection.sessionId}`);
          if (question.request && projection.active) throw Error('MiniMax Desktop requires user interaction; open the recorded session to resolve it.');
        })().catch(error => { if (!ended && !stopping) { failure = error; onFailure?.(error); } }).finally(() => { pollBusy = false; });
      }, 1500);
      submitted = true;
      delivery = client.request(`${MCODE_API}/session/${projection.sessionId}/message`, {
        body: { content: prompt, turn_id: config.mcodeTurnId, model, enable_team: false }, signal: controller.signal, stream: true });
      const stream = await delivery;
      await readMcodeSse(stream.body, frame => {
        fs.writeSync(log, json(frame) + '\n');
        if (frame.event === 'error') throw Error('MiniMax Desktop SSE transport failed.');
        projection.ingest(frame.data);
      });
      if (ended) return;
      const final = await client.request(`${MCODE_API}/session/${projection.sessionId}`);
      verifyMcodeSession(config, final.session, projection.sessionId!);
      if (!projection.terminal || final.session.status?.status_type !== 0) throw Error('Desktop exited its stream without a verified successful terminal result.');
      close(0);
    } catch (error) {
      if (ended || stopping) return;
      failure = error;
      try { await abortOwnedTurn(); controller.abort(); close(1); }
      catch { onNotice?.('MiniMax desktop turn ownership is uncertain; the app is left running and the project lock is retained.'); onFailure?.(error); }
    }
  };
  queueMicrotask(() => { void run(); });
  let finalized = false;
  return { child, finalize() {
    if (finalized) return; finalized = true; clearInterval(permissions);
    const result = failure ? { sessionId: projection.sessionId, isError: true, error: { message: failure.message } }
      : projection.terminal ?? { sessionId: projection.sessionId, ...(child.exitCode === 130 ? { cancelled: true } : { isError: true, error: { message: 'Desktop completion is unconfirmed.' } }) };
    try { writeFileAtomic(path.join(config.runDir, 'result.json'), json(result) + '\n'); }
    finally { fs.closeSync(log); projection.close(); }
  } };
}
