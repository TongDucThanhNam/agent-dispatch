import { expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Database } from 'bun:sqlite';
import { createHash } from 'node:crypto';
import { cli, rmTree } from './helpers.ts';
import { insightFixture } from './insights-fixture.ts';
import expected from './fixtures/insights-before.json';
import { computeInsights, type Finding } from '../shared/insights/insights.ts';
import { computeInsights as webInsights } from '../web/src/lib/insights.ts';
import { compactFindings, inputPaths, runInsights } from '../src/core/insights.ts';
import { WORKERS } from '../src/core/config.ts';
import { RECORD_DIR } from '../src/core/paths.ts';
import { ORCHESTRATORS, guideText, templateText } from '../src/guide/guide.ts';

const serial = (value: unknown) => JSON.parse(JSON.stringify(value, (_key,v)=>v instanceof Map ? [...v.entries()] : v));

test('shared extraction is deep-equal to the pre-extraction synthetic fixture and web entry', () => {
  const { run, previews, now } = insightFixture();
  expect(serial(computeInsights(run, previews, now))).toEqual(expected);
  expect(webInsights(run, previews, now)).toEqual(computeInsights(run, previews, now));
  expect(computeInsights(run, previews, now).mix?.results).toBeInstanceOf(Map);
});

// Same session/message/part/model_usage harness as trajectory-export; all content here is synthetic.
function fixture() {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'ad-insights-')), runDir = path.join(project, RECORD_DIR, 'run-1-abcd1234');
  fs.mkdirSync(runDir, { recursive: true });
  const dbPath = path.join(project, 'session.sqlite'), db = new Database(dbPath), startedAt = 1_000_000;
  db.exec(`CREATE TABLE session(id TEXT,directory TEXT,parent_id TEXT,time_created INTEGER,time_updated INTEGER);
    CREATE TABLE message(id TEXT,session_id TEXT,time_created INTEGER,time_updated INTEGER,data TEXT);
    CREATE TABLE part(id TEXT,message_id TEXT,session_id TEXT,time_created INTEGER,time_updated INTEGER,data TEXT);
    CREATE TABLE model_usage(id TEXT,logical_request_id TEXT,attempt_index INTEGER,session_id TEXT,status TEXT,
      provider_id TEXT,model_id TEXT,started_at INTEGER,completed_at INTEGER,input_tokens INTEGER,output_tokens INTEGER,
      cache_read_input_tokens INTEGER,retry_count INTEGER,error_code TEXT,error_message TEXT);`);
  db.query('INSERT INTO session VALUES(?,?,?,?,?)').run('s', project, null, startedAt, startedAt);
  db.query('INSERT INTO message VALUES(?,?,?,?,?)').run('m', 's', startedAt, startedAt + 100, JSON.stringify({ role: 'assistant' }));
  db.query('INSERT INTO model_usage VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run('r', 'r', 0, 's', 'completed', 'test', 'model', startedAt,
    startedAt + 100, 1000, 100, 900, 0, null, null);
  const config = { runId: 'run-1-abcd1234', runDir, project, dbPath, workerKind: 'zcode' };
  const state = { runId: config.runId, sessionId: 's' as string | null, startedAt, updatedAt: startedAt + 1000, endedAt: startedAt + 1000,
    workerExited: true, runnerPid: 0, status: 'ready_for_review', phase: 'finished' };
  const save = () => { fs.writeFileSync(path.join(runDir,'config.json'), JSON.stringify(config)); fs.writeFileSync(path.join(runDir,'status.json'), JSON.stringify(state)); };
  let index = 0;
  const tool = (label: string, input: unknown, extra: Record<string, unknown> = {}, session = 's', at = startedAt + 200) => {
    const id = `t${index++}`;
    db.query('INSERT INTO part VALUES(?,?,?,?,?,?)').run(id, 'm', session, at, at + 10, JSON.stringify({ type: 'tool', tool: label, callID: id,
      state: { status: 'completed', input, output: 'ok✓', time: { start: at, end: at + 10 }, ...extra } }));
    return `part:${id}`;
  };
  save();
  return { project, runDir, dbPath, db, config, state, tool, save,
    close() { db.close(); expect(path.resolve(project).startsWith(path.resolve(os.tmpdir()) + path.sep)).toBe(true); rmTree(project); } };
}

test('path heuristic normalizes project prefixes, avoids identifiers/URLs and ignores run artifacts', () => {
  expect(inputPaths(JSON.stringify({ cmd: 'cat C:\\repo\\src\\a.ts ./src/a.ts; r.output; console.log(x); cat AGENTS.md; cat .agent-dispatch/run/a.json; https://host/file.ts' }), 'C:/repo'))
    .toEqual(['src/a.ts', 'AGENTS.md']);
  expect(inputPaths(JSON.stringify({ file_path: 'src/unusual.xyz' }), 'C:/repo')).toEqual(['src/unusual.xyz']);
  expect(inputPaths(JSON.stringify({ path: 'src/extensionless', cmd: 'cat Dockerfile .env', file_path: 'NOTICE' }), 'C:/repo'))
    .toEqual(['src/extensionless', 'Dockerfile', '.env', 'NOTICE']);
  expect(inputPaths(JSON.stringify({ path: 'docs/my file.txt', cmd: 'rg x src; text(rs[0].output); print("\\n"); cat C:/repo' }), 'C:/repo'))
    .toEqual(['docs/my file.txt']);
  expect(inputPaths(JSON.stringify({ cmd: "& 'C:/Program Files/Git/bin/bash.exe' -c 'sed -n 1,9p src/a.ts'; emc.cmd health" }), 'C:/repo'))
    .toEqual(['src/a.ts']);
});

test('insights CLI reads available telemetry, full inputs and session totals without changing files', () => {
  const f = fixture();
  try {
    const ids = [f.tool('Read', { path: path.join(f.project, 'src/a.ts') }), f.tool('Bash', { cmd: 'cat ./src/a.ts src/a.ts' }),
      f.tool('Read', { path: 'src\\a.ts' })];
    for (let i = 0; i < 3; i++) {
      f.tool('Edit', { path: 'src/edited.ts' });
      f.tool('exec', 'tools.apply_patch("src/patched.ts")');
      f.tool('Read', { path: '.agent-dispatch/run/status.json' });
      f.tool('Read', { path: 'src/foreign.ts' }, {}, 'other');
      f.tool('Read', { path: 'src/old.ts' }, {}, 's', f.state.startedAt - 3000);
    }
    const snapshot = () => [f.dbPath, ...fs.readdirSync(f.runDir).map(name=>path.join(f.runDir,name))]
      .map(file=>[file, createHash('sha256').update(fs.readFileSync(file)).digest('hex'), fs.statSync(file).mtimeMs]);
    const before = snapshot(), result = cli(['insights','abcd1234'], { cwd: f.project });
    expect(result.status).toBe(0); expect(result.stdout.trim().split('\n')).toHaveLength(1);
    expect(result.envelope).toMatchObject({ v: 1, ok: true, cmd: 'insights' });
    const data = result.envelope.data;
    expect(data.coverage).toMatchObject({ available: true, settled: true, trajectory: { truncated: false }, inputs: { writes: 3, truncated: 0 } });
    expect(data.coverage.previews.loaded).toBe(data.coverage.previews.total);
    expect(data.reads).toEqual({ basis: 'paths mentioned in tool inputs', hotFiles: [{ path: 'src/a.ts', calls: 3, firstIds: ids }] });
    expect(data.coverage.images.available).toBe(false);
    expect(data.totals).toEqual({ requests: 1, inputTokens: 1000, cachedTokens: 900, outputTokens: 100, toolCalls: 12, toolOutputBytes: 60 });
    expect(snapshot()).toEqual(before);
    expect(fs.readdirSync(f.project).sort()).toEqual([RECORD_DIR, 'session.sqlite']);
  } finally { f.close(); }
});

test('unavailable, missing ref and corrupt/mismatched database have distinct contracts', () => {
  const f = fixture();
  try {
    f.state.sessionId = null; f.save();
    let result = cli(['insights',f.runDir]);
    expect(result.status).toBe(0); expect(result.envelope.data.coverage).toMatchObject({ available: false, reason: expect.stringContaining('session') });
    expect(result.envelope.data).not.toHaveProperty('findings');
    f.state.sessionId = 's'; f.config.dbPath = path.join(f.project,'missing.sqlite'); f.save();
    result = cli(['insights',f.runDir]);
    expect(result.status).toBe(0); expect(result.envelope.data.coverage.available).toBe(false);
    fs.writeFileSync(f.config.dbPath, 'not sqlite');
    result = cli(['insights',f.runDir]);
    expect(result.status).toBe(1); expect(result.envelope.error.code).toBe('IO_ERROR');
    f.config.dbPath = f.dbPath; f.config.project = path.join(f.project, 'elsewhere'); f.save();
    result = cli(['insights',f.runDir]);
    expect(result.status).toBe(1); expect(result.envelope.error.code).toBe('IO_ERROR');
    expect(result.envelope.error.message).toContain('different project');
    result = cli(['insights',path.join(f.project, 'unknown')]);
    expect(result.status).toBe(3); expect(result.envelope.error.code).toBe('RUN_NOT_FOUND');
  } finally { f.close(); }
});

test('caps preserve finding text/order/counts and full lifts caps without serializing internal maps', () => {
  const findings = Array.from({ length: 12 }, (_,i) => ({ key: String(i), area: 'Errors', severity: 'low', title: 'title', detail: 'detail', ids: ['a','b','c','d'] } as Finding));
  expect(compactFindings(findings)).toMatchObject({ dropped: { findings: 2, ids: 18 } });
  expect(compactFindings(findings).findings).toHaveLength(10);
  const f = fixture();
  try {
    for (let i = 0; i < 12; i++) for (let j = 0; j < 4; j++) f.tool(`tool${i}`, { path: `src/f${i}.ts` }, { status: 'error', error: `Failure ${i}: same missing resource` });
    const compact = cli(['insights', f.runDir]), full = cli(['insights', f.runDir, '--full']);
    expect(compact.status).toBe(0); expect(full.status).toBe(0);
    const a = compact.envelope.data, b = full.envelope.data;
    expect(b.findings.length).toBeGreaterThan(10); expect(a.findings.length).toBeLessThanOrEqual(10);
    expect(compact.stdout.length).toBeLessThanOrEqual(4000);
    expect(a.findings).toEqual(b.findings.slice(0,a.findings.length).map(f=>({ ...f, ids: f.ids.slice(0,3) })));
    expect(a.dropped).toEqual({ findings: b.findings.length - a.findings.length,
      ids: b.findings.reduce((n,f)=>n+f.ids.length,0)-a.findings.reduce((n,f)=>n+f.ids.length,0) });
    expect(b.dropped).toEqual({ findings: 0, ids: 0 }); expect(b).not.toHaveProperty('mix');
    expect(a.reads.hotFiles).toHaveLength(5); expect(a.reads.hotFiles.every(f=>f.firstIds.length===3)).toBe(true);
  } finally { f.close(); }
});

test('settled status/full/wait gain only optional enrichment; analysis failure cannot fail them', () => {
  const f = fixture();
  try {
    for (const args of [['status'],['status','--full'],['wait']]) {
      const result = cli([...args,f.runDir]);
      expect(result.status).toBe(0); expect(result.envelope.next).toContain('agent-dispatch insights abcd1234');
      expect(result.envelope.data.insightCounts).toEqual({ high: 0, medium: 0, low: 0 });
    }
    f.config.dbPath = path.join(f.project,'bad.sqlite'); fs.writeFileSync(f.config.dbPath,'bad'); f.save();
    for (const command of ['status','wait']) {
      const result = cli([command,f.runDir]);
      expect(result.status).toBe(0); expect(result.envelope.data).not.toHaveProperty('insightCounts');
      expect(result.envelope.next).toContain('agent-dispatch insights abcd1234');
    }
  } finally { f.close(); }
});

test('active analysis uses now, reports unsettled and status does not enrich', () => {
  const f = fixture();
  try {
    f.state.runnerPid = process.pid; f.state.workerExited = false; f.state.phase = 'working'; f.state.status = 'running';
    f.state.updatedAt = Date.now(); f.state.endedAt = null as any; f.save();
    f.tool('sleep', { seconds: 180 }, { status: 'running', time: { start: f.state.startedAt + 200 } });
    const result: any = runInsights(f.runDir, { now: f.state.startedAt + 200_000, full: true });
    expect(result.coverage.settled).toBe(false); expect(result.findings.map(f=>f.key)).toContain('sleep');
    const status = cli(['status',f.runDir]);
    expect(status.status).toBe(0); expect(status.envelope.data).not.toHaveProperty('insightCounts');
    expect(status.envelope.next).not.toContain('agent-dispatch insights abcd1234');
  } finally { f.close(); }
});

test('bounded full input reads disclose missing/cut inputs and see paths beyond previews', () => {
  const f = fixture();
  try {
    for (let i = 0; i < 3; i++) f.tool('Read', { padding: 'x'.repeat(70_000), path: 'src/deep.ts' });
    f.tool('Read', { padding: 'x'.repeat(300_000), path: 'src/unseen.ts' }); f.tool('Read', null);
    const result: any = runInsights(f.runDir);
    expect(result.coverage.inputs).toMatchObject({ loaded: 4, total: 5, missing: 1, truncated: 1 });
    expect(result.reads.hotFiles.map(f=>({path:f.path,calls:f.calls}))).toEqual([{ path: 'src/deep.ts', calls: 3 }]);
  } finally { f.close(); }
});

test('Codex counts recorded tool images and decoded bytes, scoped to trajectory tools', () => {
  const f = fixture();
  try {
    f.config.workerKind = 'codex'; f.save(); const id = f.tool('view_image', { path: 'a.png' }).slice(5);
    const record = call_id => JSON.stringify({ type: 'response_item', payload: { type: 'function_call_output', call_id,
      output: [{ type: 'input_image', image_url: 'data:image/png;base64,AQID' }, { type: 'input_image', image_url: 'data:image/jpeg;base64,BAU=' }] } });
    fs.writeFileSync(path.join(f.runDir,'codex-rollout.jsonl'), record(id)+'\n'+record('outside')+'\n');
    const result: any = runInsights(f.runDir);
    expect(result.reads.images).toEqual({ count: 2, bytes: 5 }); expect(result.coverage.images.available).toBe(true);
  } finally { f.close(); }
});

test('a truncated trajectory is explicit while totals remain whole-run aggregates', () => {
  const f = fixture();
  try {
    f.db.transaction(() => { for (let i = 0; i < 2005; i++) f.tool('Edit', { path: 'src/a.ts' }, {}, 's', f.state.startedAt + i); })();
    const result: any = runInsights(f.runDir, { full: true });
    expect(result.coverage.trajectory).toEqual({ events: 2000, truncated: true });
    expect(result.totals.toolCalls).toBe(2005); expect(result.totals.toolOutputBytes).toBe(10025);
    expect(result.findings.map(f=>f.key)).toContain('truncated');
  } finally { f.close(); }
});

test('reading maps and optional project Navigation slot render through the CLI', () => {
  const discovery = cli(['template','discovery']), assignment = cli(['template','assignment']);
  expect(discovery.status).toBe(0); expect(assignment.status).toBe(0);
  expect(discovery.stdout).toContain('6. **Reading map**'); expect(discovery.stdout).toContain('7. **Proposals**');
  expect(discovery.stdout).toContain('`path:start-end`'); expect(discovery.stdout).toContain('command that located them');
  expect(assignment.stdout).toContain('Navigation: <Optional'); expect(assignment.stdout).toContain('AGENTS.md section');
  expect(assignment.stdout).toContain('reading map the plan carries'); expect(assignment.stdout).toContain('corrected where');
  expect(templateText('discovery')).toContain('1,500–4,000');
});

test('every worker × caller guide is at most 8192 UTF-8 bytes', () => {
  for (const worker of WORKERS) for (const caller of ORCHESTRATORS) {
    const guide = guideText(worker, caller);
    expect(guide).toContain('reading map'); expect(guide).toContain('agent-dispatch insights <ref>');
    expect(Buffer.byteLength(guide)).toBeLessThanOrEqual(8192);
  }
});
