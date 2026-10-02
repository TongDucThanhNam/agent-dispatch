import { test, expect } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { validateConfig, openTelemetry, finishResult, stopOwnedWorker, skillState, installSkills, guideText } from '../src/index.ts';
import { readMcodeBridge, resolveMcodeSelection, verifyMcodeSession, mcodeClient, MCODE_API } from '../src/workers/mcode/desktop.ts';
import { createMcodeProjection, readMcodeSse, startMcode } from '../src/workers/mcode/adapter.ts';
import { rmTree } from './helpers.ts';

const sid = 'mvs_0123456789abcdef0123456789abcdef';
function fixture() {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'mcode-test-'));
  const config = validateConfig({ workerKind: 'mcode', project, notify: false, runId: 'mcode-fixture',
    model: 'minimax/fixture#thinking', effort: 'max', mcodeTurnId: 'dispatch-fixture' });
  fs.mkdirSync(config.runDir, { recursive: true });
  const session = { session_id: sid, agent_name: 'mavis', workspace_dir: project, interaction_mode: 0, status: { status_type: 0 },
    model: { provider_id: 'minimax', model_id: 'fixture', variant: 'thinking', thinking: { effort: 'max' } } };
  const runtime = { models: [{ provider_id: 'minimax', model_id: 'fixture', provider_kind: 'minimax-managed', selected: true,
    variant: 'thinking', supported_variants: ['', 'thinking'], effort_options: ['low', 'max'], thinking: { effort: 'max' } }],
    source: 'token_plan', agents: [{ name: 'mavis' }] };
  return { config, session, runtime, cleanup: () => rmTree(project) };
}
const frame = (value: unknown, cursor?: string) => ({ data_json: JSON.stringify(value), ...(cursor ? { cursor } : {}) });
function answer(config: any) {
  return frame({ type: 2, agent_message: { msg_id: 'answer', turn_id: config.mcodeTurnId, role: 'assistant',
    msg_content: 'Verified desktop report.', finish_reason: 'stop', usage: { input_tokens: 10, output_tokens: 3, cache_read: 2 } } });
}
const finished = frame({ type: 'session_status', session_status: { type: 'finished' } });
const done = { data_json: '[DONE]' };
const stream = (frames: any[]) => new Response(frames.map(f => `data: ${JSON.stringify(f)}\r\n\r\n`).join(''), { headers: { 'Content-Type': 'text/event-stream' } });

test('mcode configuration pins native IDs and rejects CLI/provider/plan substitutions', () => {
  const f = fixture();
  try {
    expect(f.config.dbPath).toBe(path.join(f.config.runDir, 'mcode-events.sqlite'));
    expect(f.config.mcodeModel).toBe('minimax/fixture');
    expect(() => validateConfig({ ...f.config, mode: 'plan' })).toThrow('yolo only');
    expect(() => validateConfig({ ...f.config, provider: 'api' })).toThrow('desktop');
    expect(() => validateConfig({ ...f.config, resumeSessionId: '12345678-1234-4234-8234-123456789abc' })).toThrow('desktop session');
    expect(() => validateConfig({ ...f.config, mcodeAgent: '../other' })).toThrow();
    resolveMcodeSelection(f.config, f.runtime);
    expect(f.config.expectedModel).toBe('fixture');
    expect(() => resolveMcodeSelection(f.config, { ...f.runtime, source: 'byok' })).toThrow('Token Plan');
    expect(() => resolveMcodeSelection({ ...f.config, mcodeEffort: 'medium' }, f.runtime)).toThrow('effort');
    expect(() => verifyMcodeSession(f.config, { ...f.session, workspace_dir: path.dirname(f.config.project) })).toThrow('project');
    expect(() => verifyMcodeSession(f.config, { ...f.session, model: { ...f.session.model, variant: '' } })).toThrow('pinned');
  } finally { f.cleanup(); }
});

test('desktop manifest validates loopback, installed process identity and PID reuse', async () => {
  const f = fixture();
  try {
    const exe = path.join(f.config.project, 'MiniMax Code.exe'); fs.writeFileSync(exe, 'fixture');
    const data = Buffer.from(JSON.stringify({ name: '@mmx-agent/electron', version: '3.0.74' }));
    const header = Buffer.from(JSON.stringify({ files: { 'package.json': { size: data.length, offset: '0' } } }));
    const prefix = Buffer.alloc(16); prefix.writeUInt32LE(header.length + 8, 4); prefix.writeUInt32LE(header.length, 12);
    fs.mkdirSync(path.join(f.config.project, 'resources')); fs.writeFileSync(path.join(f.config.project, 'resources/app.asar'), Buffer.concat([prefix, header, data]));
    const manifest = path.join(f.config.project, 'bridge.json'), at = Date.now();
    const value = { host: '127.0.0.1', port: 12345, pid: process.pid, owner: 'electron', mode: 'diagnostic', startupToken: 'PRIVATE_BRIDGE_TOKEN', startedAtMs: at };
    fs.writeFileSync(manifest, JSON.stringify(value));
    const config = { mcodeExe: exe, mcodeManifest: manifest };
    const processes = async () => [{ pid: process.pid, exe, startedAt: at - 1000 }];
    expect((await readMcodeBridge(config, { processes })).version).toBe('3.0.74');
    await expect(readMcodeBridge(config, { processes: async () => [{ pid: process.pid, exe, startedAt: at + 1 }] })).rejects.toThrow('process');
    fs.writeFileSync(manifest, JSON.stringify({ ...value, host: 'example.com' }));
    await expect(readMcodeBridge(config, { processes })).rejects.toThrow('invalid');
    const calls: any[] = [];
    const client = mcodeClient({ origin: 'http://127.0.0.1:12345', token: value.startupToken }, (async (url, opts) => { calls.push({ url, opts }); return Response.json({ success: true }); }) as typeof fetch);
    await client.request(MCODE_API + '/models/list');
    expect(calls[0].opts.redirect).toBe('error');
    expect(calls[0].opts.headers['x-mavis-runtime-token']).toBe(value.startupToken);
    await expect(client.request('/foreign')).rejects.toThrow('route');
  } finally { f.cleanup(); }
});

test('native chunks, final messages and tool results deduplicate into existing telemetry', () => {
  const f = fixture(), projection = createMcodeProjection(f.config, { prompt: 'Dispatch run: mcode-fixture\nPRIVATE_PROMPT', startedAt: Date.now() });
  try {
    projection.initialize(f.session);
    const chunk = frame({ agent_message_chunk: { msg_id: 'answer', turn_id: f.config.mcodeTurnId, role: 'assistant', chunk_index: 0, msg_content: 'Partial ',
      tool_calls: [{ tool_call_id: 'read1', tool_name: 'read', tool_call_status: 1, tool_call_args: '{"path":"PRIVATE_FILE"}' }] } }, 'cursor1');
    projection.ingest(chunk); projection.ingest(chunk);
    projection.ingest(frame({ agent_message: { msg_id: 'answer', turn_id: f.config.mcodeTurnId, role: 'assistant', msg_content: 'Verified desktop report.',
      finish_reason: 'stop', usage: { input_tokens: 10, output_tokens: 3, cache_read: 2 },
      tool_calls: [{ tool_call_id: 'read1', tool_name: 'read', tool_call_status: 2, tool_call_args: '{"path":"PRIVATE_FILE"}', tool_call_result_data: 'PRIVATE_RESULT' }] } }));
    projection.ingest(answer(f.config));
    expect(projection.terminal).toBeNull();
    projection.ingest(finished); projection.ingest(done);
    expect(projection.terminal?.response).toBe('Verified desktop report.');
    const reader = openTelemetry(f.config.dbPath);
    try {
      const value = reader.read({ project: f.config.project, runId: f.config.runId, sessionId: sid, startedAt: 0, includeTrajectory: true });
      expect(value.available).toBe(true); expect(value.model).toBe('fixture'); expect(value.usage.inputTokens).toBe(10);
      expect(value.trajectory.toolCalls).toBe(1);
      expect(JSON.stringify(value)).not.toContain('PRIVATE_PROMPT'); expect(JSON.stringify(value)).not.toContain('PRIVATE_FILE');
    } finally { reader.close(); }
    expect(() => projection.ingest(answer(f.config))).toThrow('terminal');
  } finally { projection.close(); f.cleanup(); }
});

test('foreign turns, unknown schemas and missing terminal markers never become success', () => {
  for (const invalid of [frame({ schema: 'future.event.v2' }), frame({ turn_id: 'other' }), { data_json: 'broken-json' }, { key: 'QUOTA', message: 'quota exhausted' }]) {
    const f = fixture(), p = createMcodeProjection(f.config, { prompt: 'Dispatch run: mcode-fixture' });
    try { p.initialize(f.session); expect(() => p.ingest(invalid)).toThrow(); expect(p.terminal).toBeNull(); }
    finally { p.close(); f.cleanup(); }
  }
  const f = fixture(), p = createMcodeProjection(f.config, { prompt: 'Dispatch run: mcode-fixture' });
  try { p.initialize(f.session); p.ingest(answer(f.config)); p.ingest(done); expect(p.terminal).toBeNull(); }
  finally { p.close(); f.cleanup(); }
});

test('SSE decoding preserves split UTF-8, comments, CRLF, multiline data and EOF', async () => {
  const bytes = new TextEncoder().encode(': heartbeat\r\ndata: {\r\ndata: "data_json":"Unicode 🙂"}\r\n\r\ndata: {"data_json":"[DONE]"}');
  const body = new ReadableStream<Uint8Array>({ start(c) { for (const byte of bytes) c.enqueue(new Uint8Array([byte])); c.close(); } });
  const frames: any[] = []; await readMcodeSse(body, f => { frames.push(f); });
  expect(frames.map(f => f.data.data_json)).toEqual(['Unicode 🙂', '[DONE]']);
  await expect(readMcodeSse(new Response('data: not-json\n\n').body!, () => {})).rejects.toThrow();
});

test('desktop adapter delivers stdin-equivalent prompt, pins a visible session and resumes exact ID', async () => {
  for (const resume of [false, true]) {
    const f = fixture(), calls: any[] = [];
    if (resume) f.config.resumeSessionId = sid;
    const client = { request: async (route, opts: any = {}) => {
      calls.push({ route, opts });
      if (opts.stream) return stream([answer(f.config), finished, done]);
      return { session: f.session };
    } };
    const bridge = startMcode(f.config, { prompt: 'Dispatch run: mcode-fixture\n"quoted" $HOME\nPRIVATE_PROMPT', startedAt: Date.now() }, { probe: async () => ({ ...f.runtime, client }) });
    try {
      const [code] = await once(bridge.child, 'close'); bridge.finalize(); expect(code).toBe(0);
      const delivery = calls.find(c => c.opts.stream);
      expect(delivery.route).toBe(`${MCODE_API}/session/${sid}/message`);
      expect(delivery.opts.body.content).toContain('"quoted" $HOME'); expect(delivery.opts.body.turn_id).toBe('dispatch-fixture');
      expect(delivery.opts.body.model.thinking.effort).toBe('max');
      expect(calls.some(c => c.route.includes('/agent/mavis/session'))).toBe(!resume);
      expect(finishResult(f.config, { exitCode: code, stopReason: null }).status).toBe('ready_for_review');
      expect(fs.readFileSync(path.join(f.config.runDir, 'mcode-events.jsonl'), 'utf8')).toContain('[DONE]');
    } finally { bridge.finalize(); f.cleanup(); }
  }
});

test('stop aborts only the owned desktop turn and never kills the app', async () => {
  const f = fixture(), calls: any[] = []; let active = false, sent!: () => void;
  const delivered = new Promise<void>(resolve => { sent = resolve; });
  const client = { request: async (route, opts: any = {}) => {
    calls.push({ route, opts });
    if (opts.stream) { active = true; sent(); return new Response(new ReadableStream({ start(c) { opts.signal.addEventListener('abort', () => c.error(Error('aborted')), { once: true }); } }), { headers: { 'Content-Type': 'text/event-stream' } }); }
    if (route.endsWith('/abort')) { active = false; return { success: true }; }
    return { session: { ...f.session, status: { status_type: active ? 1 : 0 } } };
  } };
  const bridge = startMcode(f.config, { prompt: 'Dispatch run: mcode-fixture', startedAt: Date.now() }, { probe: async () => ({ ...f.runtime, client }) });
  try {
    const exit = once(bridge.child, 'close'); await delivered;
    expect(bridge.child.pid).toBeNull(); await stopOwnedWorker(bridge.child);
    expect((await exit)[0]).toBe(130); bridge.finalize();
    const abort = calls.find(c => c.route.endsWith('/abort'));
    expect(abort.route).toBe(`${MCODE_API}/session/${sid}/abort`); expect(abort.opts.body.turn_id).toBe('dispatch-fixture');
    expect(calls.some(c => c.route.includes('/permission/'))).toBe(false);
    expect(finishResult(f.config, { exitCode: 130, stopReason: { kind: 'user_stop' } }).status).toBe('cancelled');
  } finally { bridge.finalize(); f.cleanup(); }
});

test('only owned session/agent permissions receive AllowOnce, never global or foreign approvals', async () => {
  const f = fixture(), calls: any[] = []; let granted!: () => void;
  const approval = new Promise<void>(resolve => { granted = resolve; });
  const client = { request: async (route, opts: any = {}) => {
    calls.push({ route, opts });
    if (opts.stream) return new Response(new ReadableStream({ start(c) { opts.signal.addEventListener('abort', () => c.error(Error('aborted')), { once: true }); } }), { headers: { 'Content-Type': 'text/event-stream' } });
    if (route.endsWith('/permission/requests')) return { requests: [
      { request_id: 'foreign-session', agent_name: 'mavis', session_id: 'mvs_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' },
      { request_id: 'foreign-agent', agent_name: 'explore', session_id: sid },
      { request_id: 'owned', agent_name: 'mavis', session_id: sid },
    ] };
    if (route.endsWith('/permission/owned/reply')) { granted(); return { success: true }; }
    if (route.includes('/questionnaire/pending')) return {};
    if (route.endsWith('/abort')) return { success: true };
    return { session: f.session };
  } };
  const bridge = startMcode(f.config, { prompt: 'Dispatch run: mcode-fixture', startedAt: Date.now() }, { probe: async () => ({ ...f.runtime, client }) });
  try {
    const exit = once(bridge.child, 'close'); await approval; await stopOwnedWorker(bridge.child); await exit;
    const replies = calls.filter(c => c.route.endsWith('/reply'));
    expect(replies.length).toBe(1); expect(replies[0].opts.body.reply).toBe(0); expect(replies[0].route).toContain('/permission/owned/reply');
    expect(calls.some(c => c.route.includes('/preferences') || c.route.includes('/config'))).toBe(false);
  } finally { bridge.finalize(); f.cleanup(); }
});

test('missing completion is a failure, while an unconfirmed abort retains remote ownership', async () => {
  for (const abortOk of [true, false]) {
    const f = fixture(); let active = false, notice!: () => void;
    const uncertain = new Promise<void>(resolve => { notice = resolve; });
    const client = { request: async (route, opts: any = {}) => {
      if (opts.stream) { active = true; return stream([answer(f.config)]); }
      if (route.endsWith('/abort')) { if (!abortOk) throw Error('unconfirmed'); active = false; return { success: true }; }
      return { session: { ...f.session, status: { status_type: active ? 1 : 0 } } };
    } };
    const bridge = startMcode(f.config, { prompt: 'Dispatch run: mcode-fixture', startedAt: Date.now(), onNotice: notice }, { probe: async () => ({ ...f.runtime, client }) });
    try {
      if (abortOk) { expect((await once(bridge.child, 'close'))[0]).toBe(1); bridge.finalize(); expect(finishResult(f.config, { exitCode: 1, stopReason: null }).status).not.toBe('ready_for_review'); }
      else { await uncertain; expect(bridge.child.exitCode).toBeNull(); await expect(bridge.child.stop()).rejects.toThrow('unconfirmed'); }
    } finally { bridge.finalize(); f.cleanup(); }
  }
});

test('abort acknowledgement without a valid release snapshot cannot release ownership', async () => {
  const f = fixture(); let submitted!: () => void, aborted = false;
  const sent = new Promise<void>(resolve => { submitted = resolve; });
  const client = { request: async (route, opts: any = {}) => {
    if (opts.stream) { submitted(); return new Response(new ReadableStream(), { headers: { 'Content-Type': 'text/event-stream' } }); }
    if (route.endsWith('/abort')) { aborted = true; return { success: true }; }
    return aborted ? {} : { session: f.session };
  } };
  const bridge = startMcode(f.config, { prompt: 'Dispatch run: mcode-fixture', startedAt: Date.now() }, { probe: async () => ({ ...f.runtime, client }) });
  try {
    await sent; await expect(bridge.child.stop()).rejects.toThrow('verifiable'); expect(bridge.child.exitCode).toBeNull();
  } finally { bridge.finalize(); f.cleanup(); }
});

test('mcode skill and guide use Desktop without replacing other worker skills', () => {
  const f = fixture();
  try {
    const roots = { codex: path.join(f.config.project, 'codex'), claude: path.join(f.config.project, 'claude') };
    const result = installSkills({ worker: 'mcode', includeMissing: true, roots, force: true });
    expect(result.actions.length).toBe(2);
    expect(skillState(path.join(roots.codex, 'delegate-to-mcode'))).toBe('thin');
    expect(fs.existsSync(path.join(roots.codex, 'delegate-to-claude'))).toBe(false);
    const guide = guideText('mcode', 'generic'); expect(guide).toContain('desktop app'); expect(guide).toContain('AllowOnce');
  } finally { f.cleanup(); }
});
