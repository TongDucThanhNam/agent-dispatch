import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { StringDecoder } from 'node:string_decoder';
import { EventEmitter } from 'node:events';
import { randomBytes } from 'node:crypto';
import { saveJson, sleep } from '../../core/fsutil.ts';
import { GEMINI_SCRIPT, geminiRequest, isGeminiSession } from './desktop.ts';
import { assertSafeGeminiPrompt } from './prompt.ts';
import { readGeminiBridge, geminiBridgeClient } from './bridge.ts';

/** Rendered chat messages only. Token usage and hidden model reasoning are unknown. */
export function createGeminiProjection(config: any, { prompt, startedAt = Date.now(), onSession = (_id: string) => {} }: any) {
  if (path.resolve(config.dbPath) !== path.join(config.runDir, 'gemini-events.sqlite') || fs.existsSync(config.dbPath)) throw Error('Gemini telemetry must be a fresh run-local database.');
  const db = new DatabaseSync(config.dbPath);
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=500;
    CREATE TABLE session(id TEXT PRIMARY KEY,directory TEXT,parent_id TEXT,time_created INTEGER,time_updated INTEGER);
    CREATE TABLE message(id TEXT PRIMARY KEY,session_id TEXT,time_created INTEGER,time_updated INTEGER,data TEXT);
    CREATE TABLE part(id TEXT PRIMARY KEY,message_id TEXT,session_id TEXT,time_created INTEGER,time_updated INTEGER,data TEXT);
    CREATE TABLE todo(session_id TEXT,content TEXT,status TEXT,position INTEGER);
    CREATE TABLE model_usage(id TEXT PRIMARY KEY,logical_request_id TEXT,attempt_index INTEGER,status TEXT,provider_id TEXT,model_id TEXT,
      started_at INTEGER,completed_at INTEGER,input_tokens INTEGER,output_tokens INTEGER,cache_read_input_tokens INTEGER,retry_count INTEGER,
      error_code TEXT,error_message TEXT,session_id TEXT,assistant_message_id TEXT,reasoning_tokens INTEGER,first_token_at INTEGER,duration_ms INTEGER);`);
  let sessionId: string | null = null, responseId: string | null = null, response = '', terminal: any = null, closed = false;
  let url: string | null = null, userId: string | null = null, ownership = 'unverified', submitted = false;
  let rebindCount = 0, ownershipObservations: { userId: string; level: string }[][] = [];
  let validatedResponse: any = null, lastCommand: any = null;
  const userIdPattern = /^user-query-content-[A-Za-z0-9_-]{1,160}$/;
  const evidence = (level: any) => ['exact', 'marker', 'prefix'].includes(level);
  const recovery = (failure = lastCommand ?? { action: 'stream', stage: 'transport' }, includeResponse = true) => {
    const id = sessionId ?? config.resumeSessionId ?? null;
    return { sessionId: id, url: url ?? (id ? 'https://gemini.google.com/app/' + id.slice(7) : null), ownership, submitted, rebindCount,
      ...(ownershipObservations.length ? { ownershipObservations } : {}),
      ...(includeResponse && !terminal?.cancelled && validatedResponse ? { recoveredResponse: { ...validatedResponse, failure } } : {}) };
  };
  const message = db.prepare('INSERT INTO message VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET time_updated=excluded.time_updated,data=excluded.data');
  const part = db.prepare('INSERT INTO part VALUES(?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET time_updated=excluded.time_updated,data=excluded.data');
  const transaction = (write: () => void) => {
    db.exec('BEGIN');
    try { write(); db.exec('COMMIT'); }
    catch (error) { db.exec('ROLLBACK'); throw error; }
  };
  return {
    get sessionId() { return sessionId; }, get terminal() { return terminal; }, get recovery() { return recovery(); },
    ingest(frame: any) {
      if (closed || terminal) throw Error('Gemini emitted data after its terminal event.');
      if (!frame || typeof frame !== 'object') throw Error('Invalid Gemini event.');
      if (frame.event === 'command') {
        if (typeof frame.action !== 'string' || !/^[a-z-]{1,40}$/.test(frame.action) ||
            typeof frame.stage !== 'string' || !/^[a-z-]{1,40}$/.test(frame.stage) ||
            !Number.isFinite(frame.elapsedMs) || frame.elapsedMs < 0 || !['ok', 'error', 'timeout', 'read-grace', 'read-retry'].includes(frame.outcome))
          throw Error('Invalid Gemini command diagnostic.');
        lastCommand = { action: frame.action, stage: frame.stage, elapsedMs: frame.elapsedMs };
        return;
      }
      const verifySelection = () => {
        if (config.geminiBackend !== 'bridge') return;
        const s = frame.selection;
        if (frame.effort !== config.geminiEffort || s?.verified !== true || s.model !== config.geminiModel || s.effort !== config.geminiEffort || !s.displayModel)
          throw Error('Gemini did not verify the requested model and thinking level before delivery.');
      };
      const at = Date.now();
      if (frame.event === 'error') {
        if (frame.sessionId && (!isGeminiSession(frame.sessionId) || sessionId && frame.sessionId !== sessionId || config.resumeSessionId && frame.sessionId !== config.resumeSessionId))
          throw Error('Gemini error belongs to a different conversation.');
        sessionId ??= frame.sessionId ?? null;
        if (sessionId) { url = 'https://gemini.google.com/app/' + sessionId.slice(7); onSession(sessionId); }
        ownership = evidence(frame.ownership) ? frame.ownership : 'unverified'; submitted ||= frame.submitted === true;
        if (frame.rebindCount != null) {
          if (!Number.isInteger(frame.rebindCount) || frame.rebindCount < rebindCount || userId && frame.rebindCount !== rebindCount) throw Error('Invalid Gemini error rebinding count.');
          rebindCount = frame.rebindCount;
        }
        if (Array.isArray(frame.ownershipObservations)) ownershipObservations = frame.ownershipObservations.filter(Array.isArray).map(poll => poll.map(item => ({
          userId: typeof item?.userId === 'string' && userIdPattern.test(item.userId) ? item.userId : '[invalid-id]',
          level: evidence(item?.level) ? item.level : 'unverified',
        })));
        const diagnostic = typeof frame.action === 'string' && /^[a-z-]{1,40}$/.test(frame.action) &&
          typeof frame.stage === 'string' && /^[a-z-]{1,40}$/.test(frame.stage) && Number.isFinite(frame.elapsedMs) && frame.elapsedMs >= 0
          ? { action: frame.action, stage: frame.stage, elapsedMs: frame.elapsedMs } : lastCommand;
        terminal = { ...recovery(diagnostic ?? undefined), isError: true, error: { message: frame.message ?? 'Gemini failed.', ...diagnostic } }; return;
      }
      if (frame.event === 'cancelled' && frame.beforeSubmission === true && !sessionId) { terminal = { sessionId: null, cancelled: true, rebindCount: 0 }; return; }
      if (frame.event === 'submitting') {
        if (frame.model !== config.geminiModel) throw Error('Gemini model changed before delivery.');
        verifySelection(); submitted = true;
        return;
      }
      if (frame.event === 'session') {
        if (sessionId || !isGeminiSession(frame.sessionId) || (config.resumeSessionId && config.resumeSessionId !== frame.sessionId)) throw Error('Gemini returned a different or invalid session.');
        if (frame.model !== config.geminiModel) throw Error('Gemini model differs from the pinned app selection.');
        verifySelection();
        sessionId = frame.sessionId; url = 'https://gemini.google.com/app/' + sessionId!.slice(7);
        ownership = config.geminiBackend === 'bridge' ? 'unverified' : 'exact';
        transaction(() => {
          db.prepare('INSERT INTO session VALUES(?,?,?,?,?)').run(sessionId, config.project, null, startedAt, at);
          message.run('gemini-input', sessionId, startedAt, at, JSON.stringify({ role: 'user' }));
          part.run('gemini-input:text', 'gemini-input', sessionId, startedAt, at, JSON.stringify({ type: 'text', text: prompt }));
        });
        onSession(sessionId!); return;
      }
      if (!sessionId || frame.sessionId !== sessionId) throw Error('Gemini event belongs to a different or unconfirmed conversation.');
      if (frame.event === 'ownership' && config.geminiBackend === 'bridge') {
        if (!evidence(frame.ownership) || typeof frame.userId !== 'string' || !userIdPattern.test(frame.userId)) throw Error('Invalid Gemini ownership evidence.');
        if (userId && userId !== frame.userId) {
          if (frame.previousUserId !== userId || frame.rebindCount !== rebindCount + 1 ||
              frame.ownership === 'prefix' && (!evidence(ownership) || frame.sameVisibleText !== true))
            throw Error('Gemini changed the owned user turn without a valid rebinding frame.');
          rebindCount++;
        } else if (frame.previousUserId != null || (frame.rebindCount ?? rebindCount) !== rebindCount) throw Error('Invalid Gemini rebinding sequence.');
        userId = frame.userId; ownership = frame.ownership; return;
      }
      if (frame.rebindCount != null && frame.rebindCount !== rebindCount) throw Error('Gemini terminal rebinding count does not match its ownership events.');
      if (frame.event === 'cancelled') {
        if (config.geminiBackend === 'bridge' && !evidence(ownership)) throw Error('Gemini cancellation has no verified user-turn ownership.');
        terminal = { ...recovery(undefined, false), cancelled: true }; return;
      }
      if (config.geminiBackend === 'bridge' && (!evidence(ownership) || frame.ownership !== ownership)) throw Error('Gemini response has no verified user-turn ownership.');
      if (!['response', 'complete'].includes(frame.event) || typeof frame.responseId !== 'string' || !/^model-response-message-content[A-Za-z0-9_-]+$/.test(frame.responseId)) throw Error('Unsupported Gemini response event.');
      if (responseId && responseId !== frame.responseId) throw Error('Gemini changed the assistant response.');
      const text = frame.event === 'complete' ? frame.response : frame.text;
      if (typeof text !== 'string' || !text.trim()) throw Error('Gemini returned empty response content.');
      if (frame.event === 'complete' && (text !== response || frame.model !== config.geminiModel)) throw Error('Gemini final response does not match the observed turn.');
      if (frame.event === 'complete' && config.geminiBackend === 'bridge' && !['owned-response-dom', 'native-turn-lifecycle-and-dom'].includes(frame.completionSource)) throw Error('Gemini bridge did not identify its completion evidence.');
      if (frame.event === 'complete') verifySelection();
      // Only safe, projection-validated text may become the recovery checkpoint.
      try { assertSafeGeminiPrompt(text, config.geminiAllowEmails); }
      catch (error) { throw Error(error.message.replace('Gemini prompt blocked:', 'Gemini response blocked:')); }
      transaction(() => {
        message.run(frame.responseId, sessionId, startedAt, at, JSON.stringify({ role: 'assistant', providerID: 'gemini-desktop', modelID: config.expectedModel,
          time: { created: startedAt, ...(frame.event === 'complete' ? { completed: at } : {}) } }));
        part.run(frame.responseId + ':text', frame.responseId, sessionId, startedAt, at, JSON.stringify({ type: 'text', text }));
        db.prepare('UPDATE session SET time_updated=? WHERE id=?').run(at, sessionId);
      });
      responseId = frame.responseId; response = text;
      validatedResponse = { text, completion: 'unconfirmed', sessionId, url, responseId, userId, ownership, rebindCount, bytes: Buffer.byteLength(text) };
      if (frame.event === 'complete') terminal = { ...recovery(undefined, false), response, model: frame.model, ...(frame.selection ? { effort: frame.effort, selection: frame.selection } : {}), ...(frame.completionSource ? { completionSource: frame.completionSource } : {}) };
    },
    close() { if (!closed) { closed = true; db.close(); } },
  };
}

export function startGemini(config: any, options: any, deps: any = {}) {
  assertSafeGeminiPrompt(options.prompt, config.geminiAllowEmails);
  if (config.geminiBackend !== 'uia') return startGeminiBridge(config, options, deps);
  const projection = createGeminiProjection(config, options);
  const requestFile = path.join(config.runDir, 'gemini-request.json');
  fs.writeFileSync(requestFile, JSON.stringify(geminiRequest(config, options.prompt)), { flag: 'wx', mode: 0o600 });
  const log = fs.openSync(path.join(config.runDir, 'gemini-events.jsonl'), 'wx');
  const child: any = (deps.spawn ?? spawn)(config.geminiPython, ['-I', '-u', GEMINI_SCRIPT, requestFile],
    { shell: false, windowsHide: true, stdio: ['ignore', 'pipe', options.stderrFd ?? 'pipe'] });
  const decoder = new StringDecoder('utf8');
  let pending = '', failure: any = null, finalized = false;
  const ingest = (line: string) => {
    if (!line.trim() || failure) return;
    try { projection.ingest(JSON.parse(line)); fs.writeSync(log, line + '\n'); } catch (error) { failure = error; fs.writeFileSync(path.join(config.runDir, 'gemini-stop'), 'stop'); }
  };
  child.stdout.on('data', chunk => {
    pending += decoder.write(chunk);
    let end: number;
    while ((end = pending.indexOf('\n')) >= 0) { ingest(pending.slice(0, end)); pending = pending.slice(end + 1); }
    if (pending.length > 8_000_000 && !failure) { failure = Error('Gemini event exceeds the supported size.'); fs.writeFileSync(path.join(config.runDir, 'gemini-stop'), 'stop'); }
  });
  child.once('error', error => { failure = error; });
  child.once('close', () => { pending += decoder.end(); if (pending.trim()) ingest(pending); });
  // Killing this helper cannot prove the remote turn stopped. Request the exact
  // owned Stop control instead, and wait for its confirmed cancellation event.
  child.stop = async () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    fs.writeFileSync(path.join(config.runDir, 'gemini-stop'), 'stop');
    for (let i = 0; i < 100; i++) {
      if (child.exitCode !== null || child.signalCode !== null) {
        if (projection.terminal?.cancelled || projection.terminal?.response) return;
        throw Error('Gemini cancellation is unconfirmed; inspect the app.');
      }
      await sleep(200);
    }
    throw Error('Gemini has not confirmed cancellation; the app is left running.');
  };
  // Native accessibility can block in a provider. Bound the helper, not Gemini.
  const watchdog = setTimeout(() => { failure = Error('Gemini helper timed out; app completion is unconfirmed.'); child.kill(); }, ((config.geminiTimeoutSeconds ?? 300) + 70) * 1000);
  child.once('close', () => clearTimeout(watchdog));
  return { child, finalize() {
    if (finalized) return; finalized = true; clearTimeout(watchdog);
    const result = failure ? { ...projection.recovery, isError: true, error: { message: failure.message } }
      : projection.terminal ?? { ...projection.recovery, isError: true, error: { message: 'Gemini exited without verified completion. Inspect the app before retrying.' } };
    try { saveJson(path.join(config.runDir, 'result.json'), result); }
    finally { fs.closeSync(log); projection.close(); }
  } };
}

/** The dispatcher owns one authenticated bridge request, never Gemini.exe. */
export function startGeminiBridge(config: any, options: any, deps: any = {}) {
  assertSafeGeminiPrompt(options.prompt, config.geminiAllowEmails);
  const projection = createGeminiProjection(config, options), requestId = randomBytes(16).toString('hex');
  const request = { requestId, prompt: options.prompt, allowEmails: config.geminiAllowEmails ?? [], sessionId: config.resumeSessionId ?? null,
    model: config.geminiModel, effort: config.geminiEffort, timeoutSeconds: config.geminiTimeoutSeconds ?? 300 };
  fs.writeFileSync(path.join(config.runDir, 'gemini-request.json'), JSON.stringify(request), { flag: 'wx', mode: 0o600 });
  const log = fs.openSync(path.join(config.runDir, 'gemini-events.jsonl'), 'wx');
  const child: any = new EventEmitter(); child.pid = null; child.exitCode = null; child.signalCode = null;
  let failure: any = null, finalized = false, stopping = false, client: any, delivery: Promise<Response> | null = null;
  const controller = new AbortController();
  const close = (code: number) => { child.exitCode = code; child.emit('close', code, null); };
  const ingest = (line: string) => {
    if (!line.trim()) return;
    projection.ingest(JSON.parse(line)); fs.writeSync(log, line + '\n');
  };
  child.stop = async () => {
    if (child.exitCode !== null) return;
    stopping = true;
    const unconfirmed = () => Error('Gemini did not confirm cancellation; the app was not killed.');
    const confirm = async () => {
      // A stop may precede bridge discovery or race POST delivery. Never resend.
      if (delivery) {
        await delivery;
        if (child.exitCode === null) {
          // Completion may race the stop route (409). Only the terminal stream
          // can establish whether it completed or was actually cancelled.
          try { await client('/stop', { requestId }); } catch {}
        }
      }
      while (child.exitCode === null) await sleep(200);
      if (!projection.terminal?.cancelled && !projection.terminal?.response) throw unconfirmed();
    };
    // Bound the WHOLE operation, not just the final polling loop: delivery and
    // the /stop acknowledgement can themselves stall. Abort only our transport.
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([confirm(), new Promise<never>((_, reject) => {
        timer = setTimeout(() => { controller.abort(); reject(unconfirmed()); }, 20_000);
      })]);
    } finally { clearTimeout(timer); }
  };
  const run = async () => {
    const timeout = setTimeout(() => controller.abort(), (request.timeoutSeconds + 45) * 1000);
    try {
      client = deps.client ?? geminiBridgeClient(await readGeminiBridge(config.geminiExe));
      if (stopping) { projection.ingest({ event: 'cancelled', beforeSubmission: true }); close(130); return; }
      const sending: Promise<Response> = client('/run', request, controller.signal); delivery = sending;
      const response = await sending;
      if (!response.headers.get('content-type')?.includes('application/x-ndjson') || !response.body) throw Error('Gemini did not return its event stream.');
      const decoder = new TextDecoder(); let pending = '';
      for await (const chunk of response.body) {
        pending += decoder.decode(chunk, { stream: true });
        let end: number;
        while ((end = pending.indexOf('\n')) >= 0) { ingest(pending.slice(0, end)); pending = pending.slice(end + 1); }
        if (pending.length > 8_000_000) throw Error('Gemini event is too large.');
      }
      pending += decoder.decode(); if (pending.trim()) ingest(pending);
      if (!projection.terminal) throw Error('Gemini bridge closed without verified completion. Do not resend automatically.');
      close(projection.terminal.isError ? 1 : projection.terminal.cancelled ? 130 : 0);
    } catch (error) {
      failure = error;
      if (delivery && !projection.terminal) { try { await client('/stop', { requestId }); } catch {} }
      controller.abort(); close(1);
    } finally { clearTimeout(timeout); }
  };
  queueMicrotask(() => { void run(); });
  return { child, finalize() {
    if (finalized) return; finalized = true;
    const result = failure ? { ...projection.recovery, isError: true, error: { message: failure.message } } : projection.terminal;
    try { saveJson(path.join(config.runDir, 'result.json'), result); }
    finally { fs.closeSync(log); projection.close(); }
  } };
}
