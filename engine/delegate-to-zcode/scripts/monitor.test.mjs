import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { clean, classifyError, openTelemetry, assess } from './monitor-core.mjs';
import { validateConfig, acquireProjectLock, finishResult, notifyOnce, servePanel, supervise, stopOwnedWorker, markReview, launch, publicState, callbackMessage } from './run.mjs';

const root = path.resolve(process.env.ZCODE_MONITOR_TEST_ROOT ?? path.join(process.cwd(), 'work', 'zcode-monitor-tests'));
fs.mkdirSync(root, { recursive: true });
function temp(name) { return fs.mkdtempSync(path.join(root, name + '-')); }
function configFor(name, extra = {}) {
  const project = temp(name), promptFile = path.join(project, 'brief.md');
  fs.writeFileSync(promptFile, 'Local monitor test. No model requests.');
  // main-review pins the historical flow these tests cover; script-astra has its own suite.
  return validateConfig({ project, promptFile, runId: name, reviewMode: 'main-review', threadId: '11111111-1111-4111-8111-111111111111',
    pollMs: 100, quietMs: 1000, stallMs: 2000, keepOpenMs: 0, ...extra });
}
function snapshot(extra = {}) { return { available: true, sessionId: 'sess_fixture', lastActivityAt: Date.now(), latestSuccessAt: 0,
  model: 'GLM-5.3-Flash', provider: 'builtin:zai-coding-plan', errors: [], tools: [], todos: [], ...extra }; }
function childCode(code, options = {}) {
  return spawn(process.execPath, ['--input-type=module', '-e', code], { windowsHide: true, shell: false,
    detached: process.platform !== 'win32', stdio: 'ignore', ...options });
}
function fixtureDb(project, now) {
  const dbPath = path.join(project, 'fixture.sqlite'), db = new DatabaseSync(dbPath);
  db.exec(`CREATE TABLE session(id TEXT PRIMARY KEY,directory TEXT,parent_id TEXT,time_created INTEGER,time_updated INTEGER);
    CREATE TABLE message(id TEXT PRIMARY KEY,session_id TEXT,time_created INTEGER,time_updated INTEGER,data TEXT);
    CREATE TABLE part(id TEXT PRIMARY KEY,message_id TEXT,session_id TEXT,time_created INTEGER,time_updated INTEGER,data TEXT);
    CREATE TABLE todo(session_id TEXT,content TEXT,status TEXT,position INTEGER);
    CREATE TABLE model_usage(id TEXT,logical_request_id TEXT,attempt_index INTEGER,status TEXT,provider_id TEXT,model_id TEXT,started_at INTEGER,completed_at INTEGER,
      input_tokens INTEGER,output_tokens INTEGER,cache_read_input_tokens INTEGER,retry_count INTEGER,error_code TEXT,error_message TEXT,session_id TEXT);`);
  const addSession = (sid, runId, created = now) => {
    db.prepare('INSERT INTO session VALUES(?,?,?,?,?)').run(sid, project, null, created, created);
    db.prepare('INSERT INTO message VALUES(?,?,?,?,?)').run('m_' + sid, sid, created, created, JSON.stringify({ role: 'user' }));
    db.prepare('INSERT INTO part VALUES(?,?,?,?,?,?)').run('p_' + sid, 'm_' + sid, sid, created, created,
      JSON.stringify({ type: 'text', text: `Dispatch run: ${runId}\n\nNever expose this private prompt. Quota exhausted is just quoted text here.` }));
  };
  return { db, dbPath, addSession };
}

test('provider quota codes differ from temporary 429, balance, authentication and access errors', () => {
  for (const code of ['1308', '1310', '1316', '1317', '1318', '1319', '1320', '1321']) {
    const error = classifyError({ error: { code, message: 'Usage limit reached. Resets at 2026-09-10T03:00:00Z' } });
    assert.equal(error.kind, 'quota'); assert.equal(error.stop, true); assert.match(error.resetHint, /2026-09-10/);
  }
  for (const code of ['1302', '1305']) assert.equal(classifyError({ code }).kind, 'rate_limit');
  assert.equal(classifyError({ statusCode: 429, message: 'Temporary overload' }).stop, false);
  assert.equal(classifyError({ code: '1113' }).kind, 'account');
  assert.equal(classifyError({ code: '1003' }).kind, 'auth');
  assert.equal(classifyError({ code: '1311' }).kind, 'account');
  assert.equal(classifyError({ code: '1313' }).kind, 'account');
});

test('nested provider response bodies are recognized without reading unrelated prompt fields', () => {
  assert.equal(classifyError({ name: 'APIError', data: { statusCode: 429, responseBody: JSON.stringify({ error: { code: '1308', message: 'Quota reached' } }) } }).kind, 'quota');
  assert.equal(classifyError({ prompt: 'quota exhausted', message: 'An unrelated error' }).kind, 'provider_error');
  assert.equal(classifyError({ message: 'Connection reset: ECONNRESET' }).kind, 'network');
  assert.equal(classifyError({ message: 'No permission client configured for Bash' }).kind, 'permission');
});

test('display sanitization removes secrets and limits error output', () => {
  const text = clean('Authorization: Bearer secret-token api_key=private password="hidden" sk-fakeSecretKey01234', 200);
  for (const secret of ['secret-token', 'private', 'hidden', 'sk-fakeSecretKey01234']) assert.ok(!text.includes(secret));
  assert.equal(clean('a'.repeat(500), 40).length, 40);
});

test('silence warns and alerts once by key; it never authorizes automatic termination', () => {
  const t = snapshot({ lastActivityAt: 1000 });
  const quiet = assess(t, { startedAt: 1000, now: 4000, quietMs: 2000, stallMs: 5000 });
  assert.equal(quiet.phase, 'quiet'); assert.equal(quiet.alert, null); assert.equal(quiet.stop, undefined);
  const stalled = assess(t, { startedAt: 1000, now: 8000, quietMs: 2000, stallMs: 5000 });
  assert.equal(stalled.phase, 'possibly_stalled'); assert.equal(stalled.alert.key, 'inactivity'); assert.equal(stalled.stop, undefined);
});

test('quota stops immediately, temporary failures have a bounded budget and prolonged waiting alerts', () => {
  const quota = classifyError({ code: '1308', message: 'Usage limit reached' });
  assert.equal(assess(snapshot({ errors: [quota] }), { now: 1000, startedAt: 0 }).stop.kind, 'quota');
  const temporary = classifyError({ code: '1305' });
  assert.equal(assess(snapshot({ errors: [temporary] }), { now: 1000, startedAt: 0 }).phase, 'waiting_retry');
  assert.equal(assess(snapshot({ errors: [temporary, temporary, temporary] }), { now: 1000, startedAt: 0 }).stop.kind, 'retry_exhausted');
  const stalled = assess(snapshot({ errors: [temporary], lastActivityAt: 1000 }), { now: 10_000, startedAt: 1000, quietMs: 2000, stallMs: 5000 });
  assert.equal(stalled.alert.kind, 'possibly_stalled'); assert.equal(stalled.stop, undefined);
});

test('repeated identical tool failures alert without killing the worker; a later success clears them', () => {
  const tools = [1, 2, 3].map(x => ({ name: 'Bash', status: 'error', error: 'Missing file', updatedAt: 9000 + x }));
  const result = assess(snapshot({ tools }), { now: 10_000, startedAt: 1000, stallMs: 30_000 });
  assert.equal(result.phase, 'repeated_tool_error'); assert.equal(result.stop, undefined);
  tools.unshift({ name: 'Bash', status: 'completed', updatedAt: 9500 });
  assert.equal(assess(snapshot({ tools }), { now: 10_000, startedAt: 1000, stallMs: 30_000 }).alert, null);
});

test('session discovery uses the run marker, not the newest session; telemetry excludes transcript content', () => {
  const project = temp('db-discovery'), now = Date.now(), { db, dbPath, addSession } = fixtureDb(project, now);
  addSession('sess_correct', 'wanted'); addSession('sess_unrelated', 'another', now + 1);
  db.prepare('INSERT INTO part VALUES(?,?,?,?,?,?)').run('tool1', 'm_sess_correct', 'sess_correct', now + 2, now + 3,
    JSON.stringify({ type: 'tool', tool: 'Bash', state: { status: 'running', input: { command: 'echo PRIVATE_COMMAND' }, output: 'PRIVATE_OUTPUT', time: { start: now + 2 } } }));
  db.prepare('INSERT INTO part VALUES(?,?,?,?,?,?)').run('thought', 'm_sess_correct', 'sess_correct', now + 3, now + 4,
    JSON.stringify({ type: 'reasoning', text: 'PRIVATE_REASONING' }));
  db.prepare('INSERT INTO todo VALUES(?,?,?,?)').run('sess_correct', 'Run the focused checks', 'in_progress', 0); db.close();
  const before = crypto.createHash('sha256').update(fs.readFileSync(dbPath)).digest('hex');
  const reader = openTelemetry(dbPath), info = reader.read({ project, runId: 'wanted', startedAt: now }); reader.close();
  assert.equal(info.sessionId, 'sess_correct'); assert.equal(info.tools[0].name, 'Bash'); assert.equal(info.todos.length, 1); assert.equal(info.errors.length, 0);
  for (const secret of ['PRIVATE_COMMAND', 'PRIVATE_OUTPUT', 'PRIVATE_REASONING', 'private prompt']) assert.ok(!JSON.stringify(info).includes(secret));
  assert.equal(crypto.createHash('sha256').update(fs.readFileSync(dbPath)).digest('hex'), before);
});

test('one failure represented in three database tables only counts as one; later success suppresses stale errors', () => {
  const project = temp('db-errors'), now = Date.now(), { db, dbPath, addSession } = fixtureDb(project, now);
  addSession('sess_errors', 'errors');
  const error = { code: '1305', message: 'Temporarily overloaded' };
  db.prepare('INSERT INTO message VALUES(?,?,?,?,?)').run('errmessage', 'sess_errors', now + 1, now + 1, JSON.stringify({ role: 'assistant', error }));
  db.prepare('INSERT INTO part VALUES(?,?,?,?,?,?)').run('retry', 'errmessage', 'sess_errors', now + 1, now + 1, JSON.stringify({ type: 'retry', error }));
  db.prepare('INSERT INTO model_usage VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run('usage1', 'request1', 0, 'error', 'builtin:zai-coding-plan', 'GLM-5.3-Flash', now, now + 1, 0, 0, 0, 0, '1305', error.message, 'sess_errors');
  const reader = openTelemetry(dbPath);
  const read = () => reader.read({ project, sessionId: 'sess_errors', runId: 'errors', startedAt: now });
  assert.equal(read().errors.length, 1);
  assert.equal(assess(read(), { startedAt: now, now: now + 2 }).phase, 'waiting_retry');
  db.prepare('INSERT INTO model_usage VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run('usage2', 'request2', 0, 'completed', 'builtin:zai-coding-plan', 'GLM-5.3-Flash', now + 3, now + 4, 100, 10, 80, 0, null, null, 'sess_errors');
  const recovered = read(); assert.equal(recovered.errors.length, 0); assert.equal(recovered.usage.modelCalls, 2); assert.equal(recovered.usage.cacheReadTokens, 80);
  reader.close(); db.close();
});

test('a resumed run ignores old errors and a session from another project is rejected', () => {
  const project = temp('db-resume'), now = Date.now(), { db, dbPath, addSession } = fixtureDb(project, now - 100_000);
  addSession('sess_old', 'old', now - 100_000);
  db.prepare('INSERT INTO message VALUES(?,?,?,?,?)').run('olderr', 'sess_old', now - 90_000, now - 90_000, JSON.stringify({ role: 'assistant', error: { code: '1308' } }));
  db.close(); const reader = openTelemetry(dbPath);
  assert.equal(reader.read({ project, sessionId: 'sess_old', runId: 'new', startedAt: now }).errors.length, 0);
  assert.equal(reader.read({ project: temp('other-project'), sessionId: 'sess_old', runId: 'new', startedAt: now }).available, false); reader.close();
});

test('unknown schema or missing telemetry is an observable limitation rather than false completion', () => {
  const missing = openTelemetry(path.join(temp('missing-db'), 'missing.sqlite'));
  assert.equal(missing.read({}).available, false); missing.close();
  const result = assess({ available: false }, { now: 20_000, startedAt: 0, stallMs: 10_000 });
  assert.equal(result.alert.kind, 'monitor_unavailable'); assert.equal(result.stop, undefined);
});

test('project locks prevent duplicate launch and are not silently reclaimed', () => {
  const config = configFor('locks'), lock = acquireProjectLock(config);
  assert.throws(() => acquireProjectLock(config), /lock already exists/);
  lock.setWorker(987654); lock.release(); assert.equal(fs.existsSync(lock.lockPath), false);
});

test('configuration rejects escaping run directories, non-task callback IDs and invalid thresholds', () => {
  const config = configFor('validation');
  assert.throws(() => validateConfig({ ...config, runDir: path.dirname(config.project) }), /inside the project/);
  assert.throws(() => validateConfig({ ...config, threadId: '/root/agent' }), /UUID/);
  assert.throws(() => validateConfig({ ...config, quietMs: 5000, stallMs: 2000 }), /stallMs/);
});

test('exit zero without a report is not success; final response fallback remains reviewable', () => {
  const config = configFor('reports'); fs.mkdirSync(config.runDir, { recursive: true });
  assert.equal(finishResult(config, { exitCode: 0 }).status, 'missing_report');
  fs.writeFileSync(path.join(config.runDir, 'result.json'), JSON.stringify({ sessionId: 'sess_test', response: '## Result\nVerified the fixture.' }));
  assert.equal(finishResult(config, { exitCode: 0 }).status, 'ready_for_review');
  assert.equal(finishResult(config, { exitCode: 1 }).status, 'worker_failed');
  fs.writeFileSync(path.join(config.runDir, 'result.json'), JSON.stringify({ error: { code: '1308', message: 'Usage limit reached' } }));
  assert.equal(finishResult(config, { exitCode: 1 }).status, 'blocked');
});

test('notification delivery is persisted before sending, deduplicated, and not blindly retried after uncertainty', async () => {
  const config = configFor('notification'), state = { notifications: {} }; let calls = 0, writes = 0;
  const deps = { persist() { writes++; }, async runCallback() { calls++; assert.equal(state.notifications.terminal.state, 'sending'); throw new Error('Connection lost after enqueue'); } };
  const event = { key: 'terminal', kind: 'quota' };
  await notifyOnce(config, state, event, deps); await notifyOnce(config, state, event, deps);
  assert.equal(calls, 1); assert.ok(writes >= 2); assert.equal(state.notifications.terminal.state, 'unconfirmed');
});

test('panel serves only its token-scoped data and rejects cross-origin actions', async () => {
  const config = configFor('http'); let stopped = 0;
  const panel = await servePanel(config, () => ({ status: 'running', safe: true }), { stop: async () => { stopped++; return 'Stopped'; } });
  try {
    assert.equal((await fetch(panel.url)).status, 200);
    assert.deepEqual(await (await fetch(panel.url + 'status')).json(), { status: 'running', safe: true });
    assert.equal((await fetch(new URL('/status', panel.url))).status, 404);
    assert.equal((await fetch(panel.url + 'stop', { method: 'POST', headers: { Origin: 'https://untrusted.example' } })).status, 403);
    assert.equal(stopped, 0);
    assert.equal((await fetch(panel.url + 'stop', { method: 'POST' })).status, 200); assert.equal(stopped, 1);
    assert.equal((await fetch(panel.url + 'config.json')).status, 405);
  } finally { await panel.close(); }
});

test('full local runner captures a report, queues one review callback and records an accepted review', async () => {
  const config = configFor('completed'), queued = [];
  const state = await supervise(config, {
    spawnWorker({ out, err }) { return childCode(`process.stdout.write(JSON.stringify({sessionId:'sess_fixture',response:'Fixture implementation finished. No live model call.'}));`, { stdio: ['ignore', out, err] }); },
    telemetryFactory() { return { read: () => snapshot({ usage: { modelCalls: 1, inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, retries: 0 } }), close() {} }; },
    async runCallback(thread, message) { queued.push({ thread, message }); return { ok: true, exitCode: 0 }; }
  });
  assert.equal(state.status, 'ready_for_review'); assert.equal(state.workerExited, true); assert.equal(state.exitCode, 0); assert.equal(queued.length, 1);
  assert.match(queued[0].message, /Read worker-report.md first/); assert.ok(!fs.existsSync(path.join(config.project, '.zcode-dispatch/active-run.lock')));
  const review = path.join(config.project, 'review.md'); fs.writeFileSync(review, 'Fixture verified.');
  assert.equal(markReview(config.runDir, 'accepted', review).status, 'complete');
});

test('quota protection stops only the spawned worker and leaves an unrelated process alive', async t => {
  const unrelated = childCode('setInterval(()=>{},1000)'); t.after(() => { if (unrelated.exitCode === null) unrelated.kill(); });
  const config = configFor('quota-stop'), queued = [];
  const state = await supervise(config, {
    spawnWorker({ out, err }) { return childCode('setInterval(()=>{},1000)', { stdio: ['ignore', out, err] }); },
    telemetryFactory() { return { read: () => snapshot({ errors: [{ id: 'quota', at: Date.now(), ...classifyError({ code: '1308', message: 'Limit reached. Resets at 2026-09-10T03:00:00Z' }) }] }), close() {} }; },
    async runCallback(thread, message) { queued.push(message); return { ok: true, exitCode: 0 }; }
  });
  assert.equal(state.status, 'blocked'); assert.equal(state.error.kind, 'quota'); assert.equal(state.workerExited, true); assert.equal(queued.length, 1);
  assert.equal(unrelated.exitCode, null); assert.doesNotThrow(() => process.kill(unrelated.pid, 0));
  assert.equal(state.sessionId, 'sess_fixture'); assert.match(state.error.resetHint, /2026-09-10/);
});

test('an observed model mismatch stops the worker; absent provider telemetry alone does not', async () => {
  const config = configFor('model-mismatch', { notify: false });
  let stops = 0;
  const state = await supervise(config, {
    spawnWorker({ out, err }) { return childCode('setInterval(()=>{},1000)', { stdio: ['ignore', out, err] }); },
    telemetryFactory() { return { read: () => snapshot({ model: 'UnexpectedModel' }), close() {} }; },
    async stopWorker(child) { stops++; await stopOwnedWorker(child); }
  });
  assert.equal(stops, 1); assert.equal(state.error.kind, 'model_mismatch'); assert.equal(state.status, 'blocked');
  const missing = configFor('model-unknown', { notify: false });
  const finished = await supervise(missing, {
    spawnWorker({ out, err }) { return childCode("process.stdout.write(JSON.stringify({sessionId:'sess_fixture',response:'Complete'}));", { stdio: ['ignore', out, err] }); },
    telemetryFactory() { return { read: () => snapshot({ provider: null }), close() {} }; },
    async stopWorker(child) { stops++; await stopOwnedWorker(child); }
  });
  assert.equal(stops, 1); assert.equal(finished.status, 'ready_for_review');
});

test('invalid launch input does not start a background runner', async () => {
  const config = configFor('missing-prompt'); fs.unlinkSync(config.promptFile);
  await assert.rejects(launch(config), /assignment file does not exist/);
  assert.equal(fs.existsSync(path.join(config.runDir, 'config.json')), false);
});

test('a racing duplicate reports failure without starting a worker or waking Astra again', async () => {
  const owner = configFor('race-owner'), lock = acquireProjectLock(owner);
  const duplicate = validateConfig({ ...owner, runId: 'race-duplicate', runDir: path.join(owner.project, '.zcode-dispatch/race-duplicate') });
  let spawned = 0, notified = 0;
  try {
    const result = await supervise(duplicate, { spawnWorker() { spawned++; throw new Error('Must not start'); }, async runCallback() { notified++; return { ok: true }; } });
    assert.equal(result.status, 'worker_failed'); assert.equal(spawned, 0); assert.equal(notified, 0);
    assert.ok(fs.existsSync(lock.lockPath));
    assert.match(JSON.parse(fs.readFileSync(path.join(duplicate.runDir, 'startup.json'))).error, /lock already exists/);
  } finally { lock.release(); }
});

test('a reopened stale record is explicitly unconfirmed, not a live running claim', () => {
  const config = configFor('stale-view');
  const state = { status: 'running', phase: 'working', workerExited: false, runnerPid: process.pid, updatedAt: Date.now() - 120_000 };
  const view = publicState(config, state, true);
  assert.equal(view.status, 'unconfirmed'); assert.match(view.alert.message, /stale/);
  assert.equal(publicState(config, { ...state, workerExited: true, status: 'ready_for_review' }, true).status, 'ready_for_review');
});

test('a failed stop callback does not falsely state that the worker exited', () => {
  const config = configFor('stop-failed-message');
  const message = callbackMessage(config, { workerExited: false }, { kind: 'stop_failed' });
  assert.match(message, /may still be active/); assert.ok(!message.includes('worker has exited'));
});
