// @ts-nocheck: ported from the JavaScript suite; it drives loosely typed internals with partial fixtures. Runtime-checked by bun test.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { DatabaseSync } from 'node:sqlite';
import { registerRun, createCatalog, serveDashboard } from '../src/index.ts';
import { openTelemetry } from '../src/index.ts';
import { readEventPreviews } from '../src/index.ts';
import { exportRunToFile } from '../src/index.ts';
import { rmTree } from './helpers.ts';

// ZCode-shaped fixture: two turns, TTFT/usage columns, an injected reminder, a compaction and a sub-session.
function fixture(t, { finished = false } = {}) {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'zcode-trajectory-export-')), runDir = path.join(project, '.zcode-dispatch', 'run-x');
  fs.mkdirSync(runDir, { recursive: true });
  const dbPath = path.join(project, 'db.sqlite'), db = new DatabaseSync(dbPath), now = Date.now() - 60_000, sid = 'sess_main';
  db.exec(`CREATE TABLE session(id TEXT,directory TEXT,parent_id TEXT,time_created INTEGER,time_updated INTEGER,title TEXT);
    CREATE TABLE message(id TEXT,session_id TEXT,time_created INTEGER,time_updated INTEGER,data TEXT);
    CREATE TABLE part(id TEXT,message_id TEXT,session_id TEXT,time_created INTEGER,time_updated INTEGER,data TEXT);
    CREATE TABLE todo(session_id TEXT,content TEXT,status TEXT,position INTEGER);
    CREATE TABLE model_usage(id TEXT,logical_request_id TEXT,attempt_index INTEGER,session_id TEXT,turn_id TEXT,assistant_message_id TEXT,status TEXT,
      provider_id TEXT,model_id TEXT,started_at INTEGER,first_token_at INTEGER,completed_at INTEGER,duration_ms INTEGER,time_to_first_token_ms INTEGER,
      finish_reason TEXT,tool_call_count INTEGER,input_tokens INTEGER,output_tokens INTEGER,reasoning_tokens INTEGER,cache_creation_input_tokens INTEGER,
      cache_read_input_tokens INTEGER,retry_count INTEGER,error_code TEXT,error_message TEXT,query_source TEXT);`);
  db.prepare('INSERT INTO session VALUES(?,?,?,?,?,?)').run(sid, project, null, now, now, 'main');
  db.prepare('INSERT INTO session VALUES(?,?,?,?,?,?)').run('sess_child', project, sid, now + 5, now + 5, 'child');
  const message = (id, data, at, session = sid) => db.prepare('INSERT INTO message VALUES(?,?,?,?,?)').run(id, session, at, at, JSON.stringify(data));
  const part = (id, msg, data, at, session = sid) => db.prepare('INSERT INTO part VALUES(?,?,?,?,?,?)').run(id, msg, session, at, at, JSON.stringify(data));
  const usage = (id, msg, turn, at, extra = {}) => db.prepare(`INSERT INTO model_usage(id,logical_request_id,attempt_index,session_id,turn_id,assistant_message_id,status,provider_id,model_id,
    started_at,first_token_at,completed_at,duration_ms,time_to_first_token_ms,finish_reason,tool_call_count,input_tokens,output_tokens,reasoning_tokens,cache_creation_input_tokens,
    cache_read_input_tokens,retry_count) VALUES(?,?,0,?,?,?,'completed','p','test-model',?,?,?,?,?,?,?,?,?,?,0,?,0)`)
    .run(id, msg, sid, turn, msg, at, at + 100, at + 400, 400, 100, extra.finish ?? 'tool-calls', 1, 1000, 60, 5, 900);
  message('u1', { role: 'user', semantics: { origin: 'real_user', kind: 'user_prompt' }, anchor: { turnId: 't1' } }, now);
  part('u1text', 'u1', { type: 'text', text: 'Build the page. api_key=SECRET123' }, now);
  message('a1', { role: 'assistant' }, now + 10); usage('r1', 'a1', 't1', now + 10);
  part('a1think', 'a1', { type: 'reasoning', text: 'Plan the build.' }, now + 11);
  part('a1tool', 'a1', { type: 'tool', tool: 'Bash', state: { status: 'completed', input: { command: 'npm test' }, output: 'all passed\nmore', time: { start: now + 500, end: now + 900 } } }, now + 500);
  message('rem', { role: 'user', synthetic: 1, semantics: { origin: 'agent_runtime', kind: 'todo_reminder' } }, now + 950);
  message('a2', { role: 'assistant' }, now + 1000); usage('r2', 'a2', 't1', now + 1000, { finish: 'stop' });
  part('a2text', 'a2', { type: 'text', text: 'Done with turn one.' }, now + 1001);
  part('cmp', 'a2', { type: 'compaction', compactReason: 'context_limit', preCompactTokenCount: 200000, truePostCompactTokenCount: 20000, summaryMessageId: 'sum', time: { start: now + 1500, end: now + 1600 } }, now + 1500);
  message('sum', { role: 'user', synthetic: 1, semantics: { origin: 'agent_runtime', kind: 'compact_summary' } }, now + 1600);
  part('sumtext', 'sum', { type: 'text', text: 'Summary of earlier work.' }, now + 1600);
  message('u2', { role: 'user', semantics: { origin: 'real_user', kind: 'user_prompt' }, anchor: { turnId: 't2' } }, now + 2000);
  message('a3', { role: 'assistant' }, now + 2010); usage('r3', 'a3', 't2', now + 2010);
  part('a3tool', 'a3', { type: 'tool', tool: 'Edit', state: { status: 'error', input: { file_path: 'src/a.js' }, error: 'old_string not found', time: { start: now + 2500, end: now + 2510 } } }, now + 2500);
  message('c1', { role: 'user' }, now + 6, 'sess_child'); part('c1text', 'c1', { type: 'text', text: 'child work' }, now + 6, 'sess_child');
  const config = { runId: 'run-x', runDir, project, dbPath, expectedModel: 'test-model' };
  const state = { runId: 'run-x', sessionId: sid, startedAt: now, updatedAt: now + 3000, workerPid: finished ? 0 : process.pid, runnerPid: finished ? 0 : process.pid,
    status: finished ? 'ready_for_review' : 'running', phase: finished ? 'finished' : 'working', workerExited: finished, endedAt: finished ? now + 3000 : null, tools: [], todos: [], notifications: {} };
  fs.writeFileSync(path.join(runDir, 'config.json'), JSON.stringify(config)); fs.writeFileSync(path.join(runDir, 'status.json'), JSON.stringify(state));
  fs.writeFileSync(path.join(runDir, 'worker-report.md'), 'Report body');
  t.after(() => { db.close(); rmTree(project); });
  return { project, runDir, dbPath, db, sid, now, config, state };
}

// Parse a ZIP produced by zipStream through its central directory and inflate each entry.
function unzip(buffer) {
  const end = buffer.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06])), count = buffer.readUInt16LE(end + 10);
  let at = buffer.readUInt32LE(end + 16); const files = {};
  for (let i = 0; i < count; i++) {
    const compressed = buffer.readUInt32LE(at + 20), size = buffer.readUInt32LE(at + 24), nameLength = buffer.readUInt16LE(at + 28), local = buffer.readUInt32LE(at + 42), crc = buffer.readUInt32LE(at + 16);
    const name = buffer.toString('utf8', at + 46, at + 46 + nameLength), start = local + 30 + buffer.readUInt16LE(local + 26);
    const data = zlib.inflateRawSync(buffer.subarray(start, start + compressed)); assert.equal(data.length, size); assert.equal(zlib.crc32(data), crc);
    files[name] = data.toString('utf8'); at += 46 + nameLength;
  }
  return files;
}

test('trajectory numbers turns, steps and requests, classifies injected context and reports whole-run stats', t => {
  const f = fixture(t), reader = openTelemetry(f.dbPath);
  const { trajectory } = reader.read({ project: f.project, sessionId: f.sid, startedAt: f.now, includeTrajectory: true }); reader.close();
  const byId = Object.fromEntries(trajectory.events.map(x => [x.id, x]));
  assert.equal(trajectory.turns, 2); assert.equal(trajectory.requests, 3); assert.equal(trajectory.toolCalls, 2);
  assert.deepEqual([byId['request:r1'].turn, byId['request:r1'].step, byId['request:r1'].request], [1, 1, 1]);
  assert.deepEqual([byId['request:r2'].turn, byId['request:r2'].step], [1, 2]);
  assert.deepEqual([byId['request:r3'].turn, byId['request:r3'].step, byId['request:r3'].request], [2, 1, 3]);
  assert.equal(byId['part:a1tool'].step, 1); assert.equal(byId['part:a3tool'].isError, true);
  assert.equal(byId['message:u1'].kind, 'input'); assert.equal(byId['message:u1'].opensTurn, true);
  assert.equal(byId['message:rem'].kind, 'context'); assert.equal(byId['message:rem'].label, 'Todo reminder');
  assert.equal(byId['request:r1'].ttftMs, 100); assert.equal(byId['request:r1'].reasoningTokens, 5); assert.equal(byId['request:r2'].finishReason, 'stop');
  assert.deepEqual([byId['part:cmp'].kind, byId['part:cmp'].preTokens, byId['part:cmp'].postTokens, byId['part:cmp'].reason], ['compaction', 200000, 20000, 'context_limit']);
  const s = trajectory.stats;
  assert.equal(s.requests, 3); assert.equal(s.inputTokens, 3000); assert.equal(s.cacheHitRate, 90); assert.equal(s.avgTtftMs, 100); assert.equal(s.compactions, 1); assert.equal(s.subagents, 1);
  assert.deepEqual(s.tools.map(x => [x.name, x.calls, x.errors]).sort(), [['Bash', 1, 0], ['Edit', 1, 1]]);
  // Telemetry stays content-free; text is only available through the on-demand readers.
  for (const secret of ['Build the page', 'npm test', 'Plan the build', 'SECRET123']) assert.ok(!JSON.stringify(trajectory).includes(secret));
});

test('previews are short, redacted and scoped to the run session', t => {
  const f = fixture(t), query = { sessionId: f.sid, project: f.project, startedAt: f.now };
  const { previews } = readEventPreviews(f.dbPath, { ...query, ids: ['message:u1', 'request:r1', 'request:r2', 'part:a1tool', 'part:a3tool', 'part:cmp', 'message:missing'] });
  assert.match(previews['message:u1'].text, /^Build the page\. api_key=\[redacted\]$/);
  assert.equal(previews['request:r1'].text, 'Thinking: Plan the build.'); assert.equal(previews['request:r1'].result, '→ Bash');
  assert.equal(previews['request:r2'].text, 'Done with turn one.');
  assert.deepEqual(previews['part:a1tool'], { text: 'npm test', result: 'all passed' });
  assert.deepEqual(previews['part:a3tool'], { text: 'src/a.js', result: 'old_string not found' });
  assert.equal(previews['part:cmp'].text, 'Summary of earlier work.'); assert.equal(previews['message:missing'], undefined);
  assert.throws(() => readEventPreviews(f.dbPath, { ...query, ids: ["part:' OR 1=1"] }), /Invalid/);
  assert.throws(() => readEventPreviews(f.dbPath, { ...query, ids: Array(201).fill('part:a') }), /Invalid/);
  assert.throws(() => readEventPreviews(f.dbPath, { ...query, project: path.dirname(f.project), ids: ['part:a1tool'] }), /different project/);
});

test('dashboard lists finished runs under Recent, hydrates them on demand and serves previews and the session-log ZIP', async t => {
  const f = fixture(t, { finished: true }), root = path.join(f.project, 'hub'), key = registerRun(f.runDir, root);
  const catalog = createCatalog(root, { alive: () => false }), panel = await serveDashboard({ root, catalog, pollMs: 1000 });
  try {
    let snapshot = catalog.snapshot();
    assert.equal(snapshot.runs.length, 0); assert.deepEqual(snapshot.recent.map(x => x.key), [key]); assert.equal(snapshot.selected, null);
    snapshot = await (await fetch(panel.url + 'snapshot?run=' + key)).json();
    assert.equal(snapshot.selected.trajectory.requests, 3); assert.equal(snapshot.selected.hydrated, undefined); assert.equal(snapshot.selected.contentSource, undefined);
    const previews = await (await fetch(panel.url + 'runs/' + key + '/previews?ids=' + encodeURIComponent('part:a1tool,message:u1'))).json();
    assert.equal(previews.previews['part:a1tool'].text, 'npm test');
    assert.equal((await fetch(panel.url + 'runs/' + key + '/previews?ids=bad')).status, 400);
    const head = await fetch(panel.url + 'runs/' + key + '/export', { method: 'HEAD' });
    assert.equal(head.status, 200); assert.equal(head.headers.get('content-type'), 'application/zip'); assert.match(head.headers.get('content-disposition'), /run-x-session-log\.zip/);
    const response = await fetch(panel.url + 'runs/' + key + '/export'), files = unzip(Buffer.from(await response.arrayBuffer()));
    for (const name of ['export.json', 'run/config.json', 'run/status.json', 'run/worker-report.md', 'trajectory.json', 'session.jsonl', 'tables/model_usage.jsonl', 'tables/todo.jsonl', 'subagents/sess_child/session.jsonl']) assert.ok(name in files, name);
    const lines = files['session.jsonl'].trim().split('\n').map(x => JSON.parse(x));
    assert.equal(lines[0].type, 'header'); assert.equal(lines[0].session.id, f.sid);
    assert.equal(lines.filter(x => x.type === 'message').length, 7); assert.equal(lines.filter(x => x.type === 'part').length, 7);
    assert.equal(lines.find(x => x.id === 'a1think').data.text, 'Plan the build.');
    assert.equal(files['tables/model_usage.jsonl'].trim().split('\n').length, 3);
    assert.equal(JSON.parse(files['export.json']).sessionId, f.sid); assert.equal(JSON.parse(files['trajectory.json']).controlUrl, undefined);
    assert.equal((await fetch(panel.url + 'runs/' + key + '/export', { headers: { Origin: 'https://example.com' } })).status, 403);
    assert.equal((await fetch(panel.url + 'runs/' + '0'.repeat(24) + '/export')).status, 404);
  } finally { await panel.close(); }
});

test('export refuses a session from another project and still exports run files when no session is bound', async t => {
  const f = fixture(t, { finished: true });
  f.db.prepare('UPDATE session SET directory=? WHERE id=?').run(path.join(f.project, 'elsewhere'), f.sid);
  await assert.rejects(exportRunToFile(f.runDir, path.join(f.project, 'a.zip')), /different project/);
  assert.equal(fs.existsSync(path.join(f.project, 'a.zip')), false);
  fs.writeFileSync(path.join(f.runDir, 'status.json'), JSON.stringify({ ...f.state, sessionId: null }));
  const result = await exportRunToFile(f.runDir, path.join(f.project, 'b.zip')), files = unzip(fs.readFileSync(result.path));
  assert.match(result.note, /no bound worker session/); assert.ok('run/config.json' in files); assert.equal('session.jsonl' in files, false);
});
