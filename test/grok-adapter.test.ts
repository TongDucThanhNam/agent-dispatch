import { afterEach, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import {
  validateConfig, buildGrokArgs, grokEnv, createGrokProjection, startGrok, grokError, readGrokRuntime,
  openTelemetry, readEventContent, finishResult, callbackMessage, buildPrompt, nodeExecutable,
  registerRun, createCatalog, serveDashboard, sessionExportEntries, installSkills,
} from '../src/index.ts';
import { cli, rmTree } from './helpers.ts';

const sid = '12345678-1234-4234-8234-123456789abc', other = '87654321-1234-4234-8234-123456789abc';
const MODEL = 'grok-fixture', NODE = nodeExecutable(), projects: string[] = [];
afterEach(() => { for (const project of projects.splice(0)) rmTree(project); });
const save = (file, value) => fs.writeFileSync(file, JSON.stringify(value));
function fixture(extra: any = {}) {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'grok-dispatch-')); projects.push(project);
  const promptFile = path.join(project, 'brief.md'); fs.writeFileSync(promptFile, 'Fixture only.');
  const config = validateConfig({ workerKind: 'grok', project, promptFile, notify: false, runId: 'grok-fixture', ...extra });
  fs.mkdirSync(config.runDir, { recursive: true }); return config;
}
const init = (config, extra = {}) => ({ type: 'system', subtype: 'init', session_id: sid, cwd: config.project,
  model: MODEL, permissionMode: config.mode === 'plan' ? 'plan' : 'bypassPermissions', tools: ['x_search', 'web_search'], ...extra });
const partial = event => ({ type: 'stream_event', session_id: sid, parent_tool_use_id: null, event });
const assistant = (id, content, usage = {}, extra = {}) => ({ type: 'assistant', session_id: sid, parent_tool_use_id: null,
  message: { id, model: MODEL, content, usage, stop_reason: 'end_turn' }, ...extra });
const result = (extra = {}) => ({ type: 'result', subtype: 'success', is_error: false, session_id: sid,
  result: 'Verified report 🙂', stop_reason: 'end_turn', ...extra });

function records(config) {
  const tool = { type: 'tool_use', id: 'search_1', name: 'x_search', input: { query: 'PRIVATE_QUERY from:xai' } };
  return [init(config), partial({ type: 'message_start', message: { id: 'msg_1', model: MODEL,
    usage: { input_tokens: 100, cache_read_input_tokens: 40, cache_creation_input_tokens: 5, output_tokens: 0 } } }),
    partial({ type: 'content_block_start', index: 0, content_block: { ...tool, input: {} } }),
    partial({ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify(tool.input) } }),
    partial({ type: 'content_block_stop', index: 0 }),
    assistant('msg_1', [tool], { input_tokens: 100, cache_read_input_tokens: 40, cache_creation_input_tokens: 5, output_tokens: 10 }),
    partial({ type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 10 } }),
    partial({ type: 'message_stop' }),
    { type: 'user', session_id: sid, parent_tool_use_id: null, message: { content: [
      { type: 'tool_result', tool_use_id: 'search_1', content: 'PRIVATE_SEARCH_RESULT https://x.com/xai/status/123' }] } },
    assistant('msg_2', [{ type: 'server_tool_use', id: 'web_1', name: 'web_search', input: { query: 'official documentation' } },
      { type: 'web_search_tool_result', tool_use_id: 'web_1', content: [{ type: 'web_search_result', url: 'https://x.ai/cli', title: 'Grok Build' }] },
      { type: 'text', text: 'Final response.' }], { input_tokens: 200, output_tokens: 20 }),
    result({ usage: { input_tokens: 99999, output_tokens: 99999 } })];
}

test('Grok argv keeps search tools, exact session/model, private prompt file and native permissions', () => {
  const config = fixture({ resumeSessionId: sid, model: MODEL, effort: 'high' }), args = buildGrokArgs(config);
  expect(args[args.indexOf('--resume') + 1]).toBe(sid);
  expect(args[args.indexOf('--model') + 1]).toBe(MODEL);
  expect(args[args.indexOf('--prompt-file') + 1]).toBe(path.join(config.runDir, 'grok-prompt.md'));
  expect(args[args.indexOf('--output-format') + 1]).toBe('streaming-messages-json');
  expect(args[args.indexOf('--permission-mode') + 1]).toBe('bypassPermissions');
  for (const forbidden of ['--continue', '--fork-session', '--tools', '--disallowed-tools', '--disable-web-search']) expect(args).not.toContain(forbidden);
  expect(buildGrokArgs({ ...config, mode: 'plan' })).toContain('plan');
  expect(config.dbPath).toBe(path.join(config.runDir, 'grok-events.sqlite'));
  expect(() => validateConfig({ ...config, resumeSessionId: 'latest' })).toThrow('Grok session');
  expect(() => validateConfig({ ...config, mode: 'edit' })).toThrow('yolo or plan');
  expect(() => validateConfig({ ...config, grokModel: 'bad model' })).toThrow('Grok model');
  expect(() => validateConfig({ ...config, grokResolvedModel: 'unknown' })).toThrow('Grok model');
  expect(() => validateConfig({ ...config, grokEffort: 'high --tools' })).toThrow('effort');
  expect(() => validateConfig({ ...config, provider: 'other' })).toThrow('provider routing');
  const env = grokEnv(config, { PATH: 'fixture', XAI_API_KEY: 'fixture-secret', GROK_HOME: 'other', CODEX_THREAD_ID: other, CODEX_SANDBOX: 'sandbox', CLAUDECODE: '1' });
  expect(env).toEqual({ PATH: 'fixture', XAI_API_KEY: 'fixture-secret', GROK_HOME: config.grokHome });
});

test('Grok runtime preflight rejects a non-Grok executable without inference', async () => {
  const runtime = await readGrokRuntime(NODE);
  expect(runtime.ok).toBe(false); expect(runtime.version).toBeNull();
});

test('Grok projection preserves X search and inline web sources without double-counting usage', () => {
  const config = fixture(), startedAt = Date.now(); let clock = startedAt;
  const projection = createGrokProjection(config, { prompt: 'Dispatch run: grok-fixture\nPRIVATE_BRIEF', startedAt, now: () => clock += 10 });
  try {
    for (const record of records(config)) projection.ingest(record);
    expect(config.grokResolvedModel).toBe(MODEL); expect(config.expectedModel).toBe(MODEL);
    const reader = openTelemetry(config.dbPath), query = { project: config.project, startedAt, sessionId: sid, runId: config.runId };
    const telemetry = reader.read(query); reader.close();
    expect(telemetry).toMatchObject({ available: true, model: MODEL, provider: 'grok' });
    expect(telemetry.usage).toMatchObject({ inputTokens: 345, outputTokens: 30, cacheReadTokens: 40 });
    expect(telemetry.tools).toHaveLength(2);
    expect(telemetry.tools.every(tool => tool.status === 'completed')).toBe(true);
    expect(JSON.stringify(telemetry)).not.toContain('PRIVATE_');
    const search = readEventContent(config.dbPath, { ...query, eventId: 'part:grok-call-search_1', workerLabel: 'Grok Build' });
    expect(JSON.stringify(search)).toContain('https://x.com/xai/status/123');
    const web = readEventContent(config.dbPath, { ...query, eventId: 'part:grok-call-web_1', workerLabel: 'Grok Build' });
    expect(JSON.stringify(web)).toContain('https://x.ai/cli');
    expect(projection.terminal.sessionId).toBe(sid);
  } finally { projection.close(); }
});

test('Grok refuses wrong session, workspace, permission mode and model drift', () => {
  for (const [options, overrides, message] of [
    [{ resumeSessionId: other }, {}, /different session/], [{ model: 'another-model' }, {}, /model selection/],
    [{}, { cwd: os.tmpdir() }, /working directory/], [{}, { permissionMode: 'default' }, /permission mode/],
    [{}, { model: 'unknown' }, /model selection/], [{}, { session_id: 'title-not-uuid' }, /session ID/],
  ] as any[]) {
    const config = fixture(options), projection = createGrokProjection(config, { prompt: 'fixture' });
    try { expect(() => projection.ingest(init(config, overrides))).toThrow(message); } finally { projection.close(); }
  }
  const config = fixture(), projection = createGrokProjection(config, { prompt: 'fixture' });
  try {
    projection.ingest(init(config));
    expect(() => projection.ingest(assistant('wrong', [], {}, { message: { id: 'wrong', model: 'different-model', content: [] } }))).toThrow('pinned model');
    expect(() => projection.ingest(result({ session_id: other }))).toThrow('different session');
  } finally { projection.close(); }
});

async function runFake(config, lines, { malformed = '', linger = false }: any = {}) {
  const script = path.join(config.project, 'fake-grok.mjs'), prompt = buildPrompt(config, 'Quoted "brief" $HOME $(not-a-shell) 🙂');
  const stream = lines.map(record => JSON.stringify(record)).join('\n') + malformed;
  fs.writeFileSync(script, `const bytes=Buffer.from(${JSON.stringify(stream)});let offset=0;
    const timer=setInterval(()=>{if(offset>=bytes.length){clearInterval(timer);${linger ? 'setInterval(()=>{},1000);' : ''}return;}
    process.stdout.write(bytes.subarray(offset,offset+=37));},1);`);
  const err = fs.openSync(path.join(config.runDir, 'stderr.log'), 'w'); let failure: any = null, lingering = false;
  const bridge = startGrok(config, { prompt, startedAt: Date.now(), stderrFd: err, onSession: undefined, onModel: undefined,
    onFailure: error => { failure = error; }, onNotice: undefined, onLingering: () => { lingering = true; bridge.child.kill(); } },
    { exitGraceMs: 20, pipeGraceMs: 20, spawnFn: (_exe, args, options) => {
      expect(options).toMatchObject({ cwd: config.project, shell: false, windowsHide: true });
      expect(options.env.GROK_HOME).toBe(config.grokHome); expect(options.stdio.slice(0, 2)).toEqual(['ignore', 'pipe']);
      expect(args).not.toContain(prompt);
      expect(fs.readFileSync(args[args.indexOf('--prompt-file') + 1], 'utf8')).toBe(prompt);
      return spawn(NODE, [script], options);
    } });
  fs.closeSync(err);
  try { await once(bridge.child, 'close'); } finally { bridge.finalize(); }
  return { failure, lingering, result: JSON.parse(fs.readFileSync(path.join(config.runDir, 'result.json'), 'utf8')) };
}

test('Grok worker handles chunked UTF-8, raw logs, final report and pinned resume configuration', async () => {
  const config = fixture({ resumeSessionId: sid }), lines = records(config);
  const output = await runFake(config, lines);
  expect(output.failure).toBeNull(); expect(output.result).toMatchObject({ sessionId: sid, response: 'Verified report 🙂' });
  expect(fs.readFileSync(path.join(config.runDir, 'grok-events.jsonl'), 'utf8')).toBe(lines.map(record => JSON.stringify(record)).join('\n'));
  expect(finishResult(config, { exitCode: 0, stopReason: null })).toMatchObject({ status: 'ready_for_review', sessionId: sid });
  const resumed = validateConfig({ ...config, runId: 'followup', runDir: undefined, resumeSessionId: output.result.sessionId });
  expect(resumed.grokResolvedModel).toBe(MODEL);
  const args = buildGrokArgs(resumed); expect(args[args.indexOf('--model') + 1]).toBe(MODEL);
  expect(callbackMessage(config, { workerExited: true }, { kind: 'ready_for_review' })).toStartWith('[Grok Build ');
});

test('Grok errors, missing terminal, malformed output, cancellation and lingering processes fail safely', async () => {
  const missing = fixture(); await runFake(missing, [init(missing), assistant('partial', [{ type: 'text', text: 'Incomplete' }])]);
  expect(finishResult(missing, { exitCode: 0, stopReason: null }).status).toBe('worker_failed');
  const malformed = fixture(); const broken = await runFake(malformed, [init(malformed)], { malformed: '\nnot json\n' });
  expect(broken.failure).not.toBeNull(); expect(finishResult(malformed, { exitCode: 0, stopReason: null }).status).toBe('worker_failed');
  const auth = fixture(); await runFake(auth, [{ type: 'error', message: '401 Unauthorized', code: 'authentication_error' }]);
  expect(finishResult(auth, { exitCode: 1, stopReason: null })).toMatchObject({ status: 'blocked', error: { kind: 'auth' } });
  const quota = fixture(); await runFake(quota, [init(quota), result({ subtype: 'error_during_execution', is_error: true, errors: ["You've hit your usage limit."] })]);
  expect(finishResult(quota, { exitCode: 1, stopReason: null })).toMatchObject({ status: 'blocked', error: { kind: 'quota' } });
  const cancelled = fixture(); await runFake(cancelled, [init(cancelled), result({ stop_reason: 'cancelled' })]);
  expect(finishResult(cancelled, { exitCode: 0, stopReason: null }).status).toBe('cancelled');
  const lingering = fixture(); const output = await runFake(lingering, [init(lingering), result(), { type: 'notice' }], { linger: true });
  expect(output.lingering).toBe(true); expect(output.result.isError).toBeUndefined();
  expect(grokError('API Error: 429 rate limit')).toMatchObject({ httpStatus: 429 });
});

test('Grok dashboard and export retain the worker label and searchable source content', async () => {
  const config = fixture(), startedAt = Date.now(), projection = createGrokProjection(config, { prompt: 'Dispatch run: grok-fixture', startedAt });
  for (const record of records(config)) projection.ingest(record); projection.close();
  save(path.join(config.runDir, 'config.json'), config);
  const state = { runId: config.runId, workerExited: true, startedAt, updatedAt: Date.now(), sessionId: sid, status: 'ready_for_review', tools: [], notifications: {} };
  save(path.join(config.runDir, 'status.json'), state);
  const root = path.join(config.project, 'hub'), key = registerRun(config.runDir, root), catalog = createCatalog(root); catalog.refresh();
  expect(catalog.snapshot(key).selected.workerLabel).toBe('Grok Build');
  const panel = await serveDashboard({ root, catalog });
  try {
    const response = await fetch(panel.url + 'runs/' + key + '/content?event=request%3Agrok-msg_2');
    const content: any = await response.json();
    expect(response.status).toBe(200); expect(content.sections[0].title).toBe('Grok Build response');
    const archive = sessionExportEntries({ runDir: config.runDir, config, state });
    expect(archive.manifest.workerKind).toBe('grok');
    let session = '';
    for await (const entry of archive.entries) if (entry.path === 'session.jsonl') {
      if (entry.data) session += entry.data.toString();
      if (entry.chunks) for await (const chunk of entry.chunks) session += chunk.toString();
    }
    expect(session).toContain('x_search'); expect(session).toContain('https://x.com/xai/status/123');
  } finally { await panel.close(); }
});

test('Grok CLI and targeted skill installation preserve other delegates', () => {
  const config = fixture(), env = { ZCODE_DASHBOARD_ROOT: path.join(config.project, 'hub') };
  const guide = cli(['guide', 'grok'], { cwd: config.project, env });
  expect(guide.status).toBe(0); expect(guide.stdout).toContain('agent-dispatch launch --worker grok');
  const file = path.join(config.project, 'config.json'); save(file, { ...config, grokExe: path.join(config.project, 'missing-grok.exe') });
  const check = cli(['check', '--config', file], { cwd: config.project, env });
  expect(check.envelope.error.code).toBe('WORKER_UNAVAILABLE'); expect(check.envelope.error.message).toContain('Grok executable');
  const roots = { claude: path.join(config.project, 'claude-skills'), codex: path.join(config.project, 'codex-skills') };
  const existing = path.join(roots.codex, 'delegate-to-codex'); fs.mkdirSync(existing, { recursive: true });
  fs.writeFileSync(path.join(existing, 'SKILL.md'), 'Do not replace');
  const installed = installSkills({ roots, worker: 'grok', includeMissing: true, force: true });
  expect(installed.actions.map(action => action.skill)).toEqual(['delegate-to-grok', 'delegate-to-grok']);
  expect(fs.readFileSync(path.join(existing, 'SKILL.md'), 'utf8')).toBe('Do not replace');
  expect(fs.readFileSync(path.join(roots.codex, 'delegate-to-grok', 'agents', 'openai.yaml'), 'utf8')).toContain('allow_implicit_invocation: true');
});
