import { test, expect, spyOn } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { DatabaseSync } from 'node:sqlite';
import { createGeminiProjection, startGemini } from '../src/workers/gemini/adapter.ts';
import { geminiRequest, isGeminiSession, geminiModelId } from '../src/workers/gemini/desktop.ts';
import { validateConfig, configuredEffort } from '../src/core/config.ts';
import { buildPrompt, finishResult, callbackMessage } from '../src/core/supervisor.ts';
import { openTelemetry } from '../src/monitor/monitor-core.ts';
import { cli, rmTree } from './helpers.ts';

const sid = 'gemini_1234567890abcdef';
const responseId = 'model-response-message-contentr_1234567890abcdef';
const proof = { ownership: 'exact', effort: 'high', selection: { model: '4 Argon', effort: 'high', displayModel: 'Argon Cao', verified: true } };
function fixture() {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'ad-gemini-'));
  const runDir = path.join(project, '.agent-dispatch', 'gemini-fixture');
  fs.mkdirSync(runDir, { recursive: true });
  const config = validateConfig({ workerKind: 'gemini', project, runDir, runId: 'gemini-fixture', notify: false });
  return { config, project, runDir, prompt: 'Xin chào\nTrả lời nguyên văn.' };
}

test('Gemini config roundtrips model display labels and sends only the exact prompt', () => {
  const f = fixture();
  try {
    expect(f.config.expectedModel).toBe('4-argon');
    expect(validateConfig(f.config).geminiModel).toBe('4 Argon');
    expect(configuredEffort(f.config)).toBe('high');
    expect(geminiModelId('Flash Cao')).toBe('flash-cao');
    expect(buildPrompt(f.config, f.prompt)).toBe(f.prompt);
    expect(geminiRequest(f.config, f.prompt)).toMatchObject({ action: 'run', prompt: f.prompt, model: '4 Argon', timeoutSeconds: 300 });
    expect(isGeminiSession(sid)).toBe(true);
    expect(isGeminiSession('sess_any')).toBe(false);
    expect(() => validateConfig({ ...f.config, provider: 'other' })).toThrow('chat prompts only');
    expect(() => validateConfig({ ...f.config, geminiEffort: 'xhigh' })).toThrow('thinking level');
    expect(() => validateConfig({ ...f.config, geminiTimeoutSeconds: 0 })).toThrow('geminiTimeoutSeconds');
  } finally { rmTree(f.project); }
});

test('Gemini projection records only its owned conversation, with no invented token usage', () => {
  const f = fixture();
  const p = createGeminiProjection(f.config, { prompt: f.prompt });
  let reader: any;
  try {
    p.ingest({ event: 'submitting', model: '4 Argon', ...proof });
    p.ingest({ event: 'session', sessionId: sid, model: '4 Argon', ...proof });
    p.ingest({ event: 'ownership', sessionId: sid, userId: 'user-query-content-1', ownership: 'exact' });
    p.ingest({ event: 'response', ownership: 'exact', sessionId: sid, responseId, text: 'Đã nhận.\n```js\n42\n```' });
    expect(p.terminal).toBeNull();
    p.ingest({ event: 'complete', sessionId: sid, responseId, response: 'Đã nhận.\n```js\n42\n```', model: '4 Argon', ...proof, url: 'https://gemini.google.com/app/1234567890abcdef', completionSource: 'owned-response-dom' });
    expect(p.terminal).toMatchObject({ sessionId: sid, response: 'Đã nhận.\n```js\n42\n```' });
    reader = openTelemetry(f.config.dbPath);
    const result = reader.read({ project: f.project, startedAt: 0, sessionId: sid });
    expect(result.available).toBe(true);
    expect(result.model).toBe('4-argon');
    expect(result.provider).toBe('gemini-desktop');
    expect(() => p.ingest({ event: 'complete' })).toThrow('terminal');
  } finally { reader?.close(); p.close(); rmTree(f.project); }
});

test('Gemini rejects a wrong chat, wrong model and an unobserved final answer', () => {
  const f = fixture();
  const p = createGeminiProjection(f.config, { prompt: f.prompt });
  try {
    expect(() => p.ingest({ event: 'submitting', model: 'Pro' })).toThrow('model');
    expect(() => p.ingest({ event: 'submitting', model: '4 Argon' })).toThrow('thinking level');
    expect(() => p.ingest({ event: 'submitting', model: '4 Argon', ...proof, effort: 'low' })).toThrow('thinking level');
    p.ingest({ event: 'session', sessionId: sid, model: '4 Argon', ...proof });
    p.ingest({ event: 'ownership', sessionId: sid, userId: 'user-query-content-1', ownership: 'exact' });
    expect(() => p.ingest({ event: 'response', ownership: 'exact', sessionId: 'gemini_ffffffffffffffff', responseId, text: 'old' })).toThrow('different');
    expect(() => p.ingest({ event: 'complete', sessionId: sid, responseId, response: 'never observed', model: '4 Argon', ...proof })).toThrow('observed');
    expect(p.terminal).toBeNull();
  } finally { p.close(); rmTree(f.project); }
});

test('Gemini helper stream handles split UTF-8 and requires a final completion event', async () => {
  const f = fixture();
  f.config.geminiBackend = 'uia';
  const child: any = new EventEmitter(); child.stdout = new PassThrough(); child.exitCode = null; child.signalCode = null; child.kill = () => {};
  let invocation: any;
  const bridge = startGemini(f.config, { prompt: f.prompt }, { spawn: (...args) => { invocation = args; return child; } });
  try {
    expect(invocation[0]).toBe(f.config.geminiPython);
    expect(invocation[1]).toContain('-I');
    expect(invocation[2]).toMatchObject({ shell: false, windowsHide: true });
    const events = [{ event: 'session', sessionId: sid, model: '4 Argon' },
      { event: 'response', ownership: 'exact', sessionId: sid, responseId, text: 'Tiếng Việt: đã đọc.' }];
    const data = Buffer.from(events.map(e => JSON.stringify(e) + '\n').join(''));
    for (const byte of data) child.stdout.write(Buffer.from([byte]));
    child.exitCode = 0; child.emit('close', 0); bridge.finalize();
    expect(JSON.parse(fs.readFileSync(path.join(f.runDir, 'result.json'), 'utf8')).isError).toBe(true);
    expect(finishResult(f.config, { exitCode: 0, stopReason: null }).status).toBe('worker_failed');
  } finally { bridge.finalize(); rmTree(f.project); }
});

test('Gemini bridge streams UTF-8 without Python and never treats a dropped stream as success', async () => {
  const f = fixture();
  const requests: any[] = [];
  const frames = [{ event: 'session', sessionId: sid, model: '4 Argon', ...proof },
    { event: 'ownership', sessionId: sid, userId: 'user-query-content-1', ownership: 'exact' },
    { event: 'response', ownership: 'exact', sessionId: sid, responseId, text: 'Đã đọc tiếng Việt.' }];
  const bytes = Buffer.from(frames.map(x => JSON.stringify(x) + '\n').join(''));
  const runtime = startGemini(f.config, { prompt: f.prompt }, { client: async (route, request) => {
    requests.push({ route, request });
    return new Response(new ReadableStream({ start(controller) { for (const byte of bytes) controller.enqueue(Uint8Array.of(byte)); controller.close(); } }),
      { headers: { 'content-type': 'application/x-ndjson' } });
  } });
  try {
    await new Promise(resolve => runtime.child.once('close', resolve)); runtime.finalize();
    expect(runtime.child.exitCode).toBe(1);
    expect(requests.filter(r => r.route === '/run')).toHaveLength(1);
    expect(requests[0].request.prompt).toBe(f.prompt);
    expect(requests[0].request).toMatchObject({ model: '4 Argon', effort: 'high' });
    const result = JSON.parse(fs.readFileSync(path.join(f.runDir, 'result.json'), 'utf8'));
    expect(result.error.message).toContain('without verified completion');
    expect(result.response).toBeUndefined();
    expect(result.recoveredResponse).toMatchObject({ text: 'Đã đọc tiếng Việt.', completion: 'unconfirmed', sessionId: sid,
      responseId, userId: 'user-query-content-1', ownership: 'exact', rebindCount: 0, bytes: Buffer.byteLength('Đã đọc tiếng Việt.') });
    expect(finishResult(f.config, { exitCode: 1, stopReason: null }).status).toBe('worker_failed');
    fs.writeFileSync(path.join(f.runDir, 'config.json'), JSON.stringify(f.config));
    fs.writeFileSync(path.join(f.runDir, 'status.json'), JSON.stringify({ workerKind: 'gemini', workerExited: true, status: 'worker_failed', sessionId: sid, runId: f.config.runId }));
    const report = cli(['report', f.runDir]);
    expect(report.status).toBe(0);
    expect(report.stdout.startsWith('Recovered — completion unconfirmed\n')).toBe(true);
    expect(report.stdout).toContain('Đã đọc tiếng Việt.');
    expect(report.stdout).toContain('Session: ' + sid);
    expect(report.stdout).toContain(result.error.message);
    fs.unlinkSync(path.join(f.runDir, 'worker-report.md'));
    expect(cli(['report', f.runDir]).stdout).toBe(report.stdout);
    expect(fs.readFileSync(path.join(f.runDir, 'gemini-events.jsonl'), 'utf8')).toContain('Đã đọc tiếng Việt.');
  } finally { runtime.finalize(); rmTree(f.project); }
});

test('recovery keeps the last validated revision and its original proof, never rejected text or cancellation', () => {
  for (const mode of ['error', 'cancelled']) {
    const f = fixture(), p = createGeminiProjection(f.config, { prompt: f.prompt });
    try {
      p.ingest({ event: 'session', sessionId: sid, model: '4 Argon', ...proof });
      p.ingest({ event: 'ownership', sessionId: sid, userId: 'user-query-content-1', ownership: 'exact' });
      for (const text of ['a long initial answer', 'a revised answer', 'short'])
        p.ingest({ event: 'response', sessionId: sid, responseId, ownership: 'exact', text });
      expect(() => p.ingest({ event: 'response', sessionId: sid, responseId, ownership: 'prefix', text: 'REJECTED FOREIGN TEXT' })).toThrow('ownership');
      const unsafe = 'sk-' + 'synthetic'.repeat(4);
      expect(() => p.ingest({ event: 'response', sessionId: sid, responseId, ownership: 'exact', text: unsafe })).toThrow('blocked');
      p.ingest({ event: mode, sessionId: sid, ownership: mode === 'error' ? 'unverified' : 'exact', submitted: true,
        message: 'Synthetic renderer timeout.', action: 'snapshot', stage: 'poll', elapsedMs: 20_000 });
      if (mode === 'error') {
        expect(p.terminal).toMatchObject({ isError: true, ownership: 'unverified', recoveredResponse: {
          text: 'short', completion: 'unconfirmed', ownership: 'exact', userId: 'user-query-content-1', bytes: 5,
          failure: { action: 'snapshot', stage: 'poll', elapsedMs: 20_000 },
        }, error: { action: 'snapshot', stage: 'poll', elapsedMs: 20_000 } });
        expect(JSON.stringify(p.terminal)).not.toContain('REJECTED');
        expect(JSON.stringify(p.terminal)).not.toContain(unsafe);
      } else {
        expect(p.terminal.cancelled).toBe(true); expect(p.terminal.recoveredResponse).toBeUndefined();
        expect(p.recovery.recoveredResponse).toBeUndefined();
      }
      expect(p.terminal.response).toBeUndefined();
    } finally { p.close(); rmTree(f.project); }
  }
});

test('each response frame commits all three SQLite writes together and failed commits roll back the checkpoint', () => {
  const f = fixture(), p = createGeminiProjection(f.config, { prompt: f.prompt });
  const original = DatabaseSync.prototype.exec, commands: string[] = [];
  let failCommit = false;
  const spy = spyOn(DatabaseSync.prototype, 'exec').mockImplementation(function(this: DatabaseSync, sql: string) {
    commands.push(sql);
    if (failCommit && sql === 'COMMIT') { failCommit = false; throw Error('Synthetic transaction failure.'); }
    return original.call(this, sql);
  });
  let db: DatabaseSync | undefined;
  try {
    p.ingest({ event: 'session', sessionId: sid, model: '4 Argon', ...proof });
    p.ingest({ event: 'ownership', sessionId: sid, userId: 'user-query-content-1', ownership: 'exact' });
    commands.length = 0;
    p.ingest({ event: 'response', sessionId: sid, responseId, ownership: 'exact', text: 'committed text' });
    expect(commands).toEqual(['BEGIN', 'COMMIT']);
    commands.length = 0; failCommit = true;
    expect(() => p.ingest({ event: 'response', sessionId: sid, responseId, ownership: 'exact', text: 'uncommitted text' })).toThrow('transaction');
    expect(commands).toEqual(['BEGIN', 'COMMIT', 'ROLLBACK']);
    expect(p.recovery.recoveredResponse.text).toBe('committed text');
    db = new DatabaseSync(f.config.dbPath);
    const row: any = db.prepare('SELECT data FROM part WHERE id=?').get(responseId + ':text');
    expect(JSON.parse(row.data).text).toBe('committed text');
    p.ingest({ event: 'complete', sessionId: sid, responseId, response: 'committed text', model: '4 Argon', ...proof, completionSource: 'owned-response-dom' });
    expect(p.terminal.response).toBe('committed text');
  } finally { spy.mockRestore(); db?.close(); p.close(); rmTree(f.project); }
});

test('unsafe transport text is never persisted or recovered; the last safe checkpoint survives', async () => {
  const f = fixture(), unsafe = 'sk-' + 'synthetic'.repeat(4);
  const frames = [{ event: 'session', sessionId: sid, model: '4 Argon', ...proof },
    { event: 'ownership', sessionId: sid, userId: 'user-query-content-1', ownership: 'exact' },
    { event: 'response', sessionId: sid, responseId, ownership: 'exact', text: 'Safe observed answer.' },
    { event: 'response', sessionId: sid, responseId, ownership: 'exact', text: unsafe }];
  let deliveries = 0;
  const worker = startGemini(f.config, { prompt: f.prompt }, { client: async (route: string) => {
    if (route !== '/run') return new Response('{}');
    deliveries++;
    return new Response(frames.map(frame => JSON.stringify(frame) + '\n').join(''), { headers: { 'content-type': 'application/x-ndjson' } });
  } });
  try {
    await new Promise(resolve => worker.child.once('close', resolve)); worker.finalize();
    const saved = fs.readFileSync(path.join(f.runDir, 'result.json'), 'utf8'), result = JSON.parse(saved);
    expect(worker.child.exitCode).toBe(1); expect(deliveries).toBe(1);
    expect(result.response).toBeUndefined();
    expect(result.recoveredResponse.text).toBe('Safe observed answer.');
    expect(result.error.message).toContain('Gemini response blocked:');
    expect(saved).not.toContain(unsafe);
    expect(fs.readFileSync(path.join(f.runDir, 'gemini-events.jsonl'), 'utf8')).not.toContain(unsafe);
  } finally { worker.finalize(); rmTree(f.project); }
});

test('Gemini bridge stop before delivery never submits a prompt', async () => {
  const f = fixture(); let calls = 0;
  const runtime = startGemini(f.config, { prompt: f.prompt }, { client: async () => { calls++; throw Error('Should not submit.'); } });
  try {
    await runtime.child.stop(); runtime.finalize();
    expect(calls).toBe(0);
    expect(JSON.parse(fs.readFileSync(path.join(f.runDir, 'result.json'), 'utf8')).cancelled).toBe(true);
  } finally { runtime.finalize(); rmTree(f.project); }
});

test('Gemini stop bounds pending delivery and pending stop acknowledgements, never resubmitting', async () => {
  const originalTimeout = globalThis.setTimeout;
  const timer = spyOn(globalThis, 'setTimeout').mockImplementation(((fn, ms, ...args) =>
    originalTimeout(fn, ms === 20_000 ? 10 : ms, ...args)) as typeof setTimeout);
  try {
    for (const blocked of ['delivery', 'stop']) {
      const f = fixture(); let sends = 0, stops = 0, signal: AbortSignal;
      let started!: () => void;
      const sending = new Promise<void>(resolve => { started = resolve; });
      const runtime = startGemini(f.config, { prompt: f.prompt }, { client: async (route, _request, abort) => {
        if (route === '/stop') {
          if (++stops === 1 && blocked === 'stop') return new Promise(() => {});
          return new Response('{}');
        }
        sends++; signal = abort; started();
        if (blocked === 'delivery') return new Promise((_resolve, reject) => {
          abort.addEventListener('abort', () => reject(Error('delivery aborted')), { once: true });
        });
        return new Response(new ReadableStream({ start(controller) {
          abort.addEventListener('abort', () => controller.error(Error('stream aborted')), { once: true });
        } }), { headers: { 'content-type': 'application/x-ndjson' } });
      } });
      const closed = new Promise(resolve => runtime.child.once('close', resolve));
      try {
        await sending;
        await expect(runtime.child.stop()).rejects.toThrow('did not confirm cancellation');
        await closed; runtime.finalize();
        expect(signal!.aborted).toBe(true); expect(sends).toBe(1); expect(runtime.child.exitCode).toBe(1);
        const result = JSON.parse(fs.readFileSync(path.join(f.runDir, 'result.json'), 'utf8'));
        expect(result.cancelled).toBeUndefined(); expect(result.response).toBeUndefined(); expect(result.isError).toBe(true);
      } finally { runtime.finalize(); rmTree(f.project); }
    }
  } finally { timer.mockRestore(); }
});

test('Gemini stop tolerates a 409 racing verified stream completion', async () => {
  const f = fixture(); let stream: ReadableStreamDefaultController, ready!: () => void, sends = 0;
  const sending = new Promise<void>(resolve => { ready = resolve; });
  const frame = (value: any) => stream.enqueue(new TextEncoder().encode(JSON.stringify(value) + '\n'));
  const runtime = startGemini(f.config, { prompt: f.prompt }, { client: async route => {
    if (route === '/stop') {
      frame({ event: 'complete', sessionId: sid, responseId, response: 'Finished.', model: '4 Argon', ...proof, completionSource: 'owned-response-dom' });
      stream.close(); throw Error('Gemini bridge HTTP 409: No matching owned turn.');
    }
    sends++;
    return new Response(new ReadableStream({ start(controller) {
      stream = controller;
      frame({ event: 'session', sessionId: sid, model: '4 Argon', ...proof });
      frame({ event: 'ownership', sessionId: sid, userId: 'user-query-content-1', ownership: 'exact' });
      frame({ event: 'response', sessionId: sid, responseId, text: 'Finished.', ownership: 'exact' });
      ready();
    } }), { headers: { 'content-type': 'application/x-ndjson' } });
  } });
  try {
    await sending; await runtime.child.stop(); runtime.finalize();
    expect(runtime.child.exitCode).toBe(0); expect(sends).toBe(1);
    expect(JSON.parse(fs.readFileSync(path.join(f.runDir, 'result.json'), 'utf8')).response).toBe('Finished.');
  } finally { runtime.finalize(); rmTree(f.project); }
});

test('Gemini keeps long answers intact and callbacks do not request coding delegation', () => {
  const f = fixture();
  try {
    const response='Tiếng Việt\n'.repeat(8000)+'END_OF_ANSWER';
    fs.writeFileSync(path.join(f.runDir,'result.json'),JSON.stringify({sessionId:sid,response}));
    expect(finishResult(f.config,{exitCode:0,stopReason:null}).status).toBe('ready_for_review');
    expect(fs.readFileSync(path.join(f.runDir,'worker-report.md'),'utf8')).toBe(response);
    const callback=callbackMessage(f.config,{workerExited:true},{kind:'complete'});
    expect(callback).toContain('Return the answer for the requested chat task');
    expect(callback).not.toContain('template assignment');
  } finally { rmTree(f.project); }
});
