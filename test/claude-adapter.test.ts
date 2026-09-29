import { afterEach, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import {
  validateConfig, buildClaudeArgs, claudeEnv, claudeError, readClaudeSelection, createClaudeProjection, startClaude,
  readClaudeRuntime,
  openTelemetry, readEventContent, readToolCallId, finishResult, callbackMessage, buildPrompt, nodeExecutable,
  registerRun, createCatalog, serveDashboard, sessionExportEntries,
} from '../src/index.ts';
import { cli, rmTree } from './helpers.ts';

const sid = '12345678-1234-4234-8234-123456789abc', other = '87654321-1234-4234-8234-123456789abc';
const MODEL = 'claude-sonnet-fixture', NODE = nodeExecutable(), projects: string[] = [];
afterEach(() => { for (const project of projects.splice(0)) rmTree(project); });
const save = (file, value) => fs.writeFileSync(file, JSON.stringify(value));
function fixture(extra: any = {}) {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-dispatch-')); projects.push(project);
  const promptFile = path.join(project, 'brief.md'); fs.writeFileSync(promptFile, 'Fixture only.');
  const config = validateConfig({ workerKind: 'claude', project, promptFile, notify: false, runId: 'claude-fixture', model: 'sonnet', ...extra });
  fs.mkdirSync(config.runDir, { recursive: true }); return config;
}
const init = (config, extra = {}) => ({ type: 'system', subtype: 'init', session_id: sid, cwd: config.project,
  model: MODEL, permissionMode: config.mode === 'plan' ? 'plan' : 'bypassPermissions', ...extra });
const partial = (event, extra = {}) => ({ type: 'stream_event', session_id: sid, parent_tool_use_id: null, event, ...extra });
const assistant = (id, content, usage = {}, extra = {}) => ({ type: 'assistant', session_id: sid, parent_tool_use_id: null,
  message: { id, model: MODEL, content, usage, stop_reason: null }, ...extra });
const result = (extra = {}) => ({ type: 'result', subtype: 'success', is_error: false, session_id: sid, result: 'Verified report 🙂', ...extra });

function records(config) {
  const first = { input_tokens: 100, cache_read_input_tokens: 50, cache_creation_input_tokens: 5, output_tokens: 0 };
  const thinking = { type: 'thinking', thinking: 'PRIVATE_REASONING' }, text = { type: 'text', text: 'Hello 🙂' };
  const tool = { type: 'tool_use', id: 'tool_1', name: 'Bash', input: { command: 'PRIVATE_COMMAND' } };
  return [
    init(config), partial({ type: 'message_start', message: { id: 'msg_1', model: MODEL, usage: first } }),
    partial({ type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } }),
    partial({ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: thinking.thinking } }),
    partial({ type: 'content_block_stop', index: 0 }), assistant('msg_1', [thinking], { ...first, output_tokens: 4 }),
    partial({ type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } }),
    partial({ type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: text.text } }),
    partial({ type: 'content_block_stop', index: 1 }), assistant('msg_1', [text], { ...first, output_tokens: 5 }),
    partial({ type: 'content_block_start', index: 2, content_block: { ...tool, input: {} } }),
    partial({ type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: JSON.stringify(tool.input) } }),
    partial({ type: 'content_block_stop', index: 2 }), assistant('msg_1', [tool], { ...first, output_tokens: 10 }),
    assistant('msg_1', [thinking, text, tool], { ...first, output_tokens: 10 }),
    partial({ type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 12 } }), partial({ type: 'message_stop' }),
    { type: 'user', session_id: sid, parent_tool_use_id: null, message: { content: [{ type: 'tool_result', tool_use_id: 'tool_1', content: 'PRIVATE_RESULT' }] } },
    assistant('msg_2', [{ type: 'text', text: 'Final reply.' }], { input_tokens: 9, output_tokens: 3 },
      { message: { id: 'msg_2', model: MODEL, content: [{ type: 'text', text: 'Final reply.' }], usage: { input_tokens: 9, output_tokens: 3 }, stop_reason: 'end_turn' } }),
    result({ usage: { input_tokens: 99999, output_tokens: 9999 }, modelUsage: { [MODEL]: { inputTokens: 99999 } }, total_cost_usd: 0.25 }),
  ];
}

test('Claude configuration and argv preserve exact sessions, stdin privacy, context selection and permissions', () => {
  const config = fixture({ resumeSessionId: sid, model: 'sonnet[1m]', effort: 'high' });
  config.claudeResolvedModel = MODEL;
  const args = buildClaudeArgs(config);
  expect(args[args.indexOf('--resume') + 1]).toBe(sid);
  expect(args[args.indexOf('--model') + 1]).toBe(MODEL + '[1m]');
  expect(args[args.indexOf('--permission-mode') + 1]).toBe('bypassPermissions');
  expect(args[args.indexOf('--permission-prompts') + 1]).toBe('none');
  expect(JSON.parse(args[args.indexOf('--settings') + 1]).env.CLAUDE_CODE_EFFORT_LEVEL).toBe('high');
  expect(args).not.toContain('--bare'); expect(args).not.toContain('--continue'); expect(args).not.toContain('--no-session-persistence');
  expect(config.dbPath).toBe(path.join(config.runDir, 'claude-events.sqlite'));
  const plan = buildClaudeArgs({ ...config, mode: 'plan' }); expect(plan[plan.indexOf('--permission-mode') + 1]).toBe('plan');
  expect(() => validateConfig({ ...config, resumeSessionId: 'sess_wrong' })).toThrow('Claude session');
  expect(() => validateConfig({ ...config, claudeEffort: 'invalid' })).toThrow('effort');
  expect(() => validateConfig({ ...config, claudeModel: 'opusplan' })).toThrow('switches models');
  expect(() => validateConfig({ ...config, provider: 'anthropic' })).toThrow('provider routing');
  expect(() => validateConfig({ ...config, mode: 'edit' })).toThrow('yolo or plan');
  expect(() => validateConfig({ ...config, claudeResolvedModel: 'bad model' })).toThrow('model');
  expect(validateConfig({ ...config, claudeModel: 'arn:aws:bedrock:region:account:inference-profile/model', claudeResolvedModel: null }).claudeModel).toStartWith('arn:');
  const env = claudeEnv(config, { PATH: 'fixture', CODEX_THREAD_ID: other, CODEX_SANDBOX: 'seatbelt', CLAUDECODE: '1', CLAUDE_CODE_CHILD_SESSION: '1',
    ANTHROPIC_AUTH_TOKEN: 'fixture-token', CLAUDE_CODE_EFFORT_LEVEL: 'low' });
  expect(env.CODEX_THREAD_ID).toBeUndefined(); expect(env.CODEX_SANDBOX).toBeUndefined(); expect(env.CLAUDECODE).toBe('1');
  expect(env.CLAUDE_CODE_CHILD_SESSION).toBe('1'); expect(env.ANTHROPIC_AUTH_TOKEN).toBe('fixture-token'); expect(env.CLAUDE_CONFIG_DIR).toBe(config.claudeHome);
  expect(env.CLAUDE_CODE_EFFORT_LEVEL).toBe('high');
});

test('model listing reads advisory settings without mutating them or requiring credentials', () => {
  const config = fixture(), home = path.join(config.project, 'claude-home'), local = path.join(config.project, '.claude');
  fs.mkdirSync(home); fs.mkdirSync(local);
  const userFile = path.join(home, 'settings.json');
  const user = { model: 'opus', effortLevel: 'medium', env: { ANTHROPIC_AUTH_TOKEN: 'not-returned' } }; save(userFile, user);
  save(path.join(local, 'settings.json'), { model: 'sonnet', env: { ANTHROPIC_MODEL: MODEL } });
  save(path.join(local, 'settings.local.json'), { effortLevel: 'low' });
  expect(readClaudeSelection(home, config.project, { CLAUDE_CODE_EFFORT_LEVEL: 'high' })).toEqual({ model: MODEL, effort: 'high' });
  expect(JSON.parse(fs.readFileSync(userFile, 'utf8'))).toEqual(user);
});

test('runtime preflight rejects a non-Claude executable without launching a model', async () => {
  const runtime = await readClaudeRuntime(NODE);
  expect(runtime.ok).toBe(false); expect(runtime.version).toBeNull(); expect(runtime.error).toContain('2.1.259');
});

test('projection deduplicates partial/full blocks and cumulative usage while keeping compact telemetry content-free', () => {
  const config = fixture(), startedAt = Date.now(); let clock = startedAt;
  const projection = createClaudeProjection(config, { prompt: 'Dispatch run: claude-fixture\nPRIVATE_BRIEF', startedAt, now: () => clock += 10 });
  try {
    for (const record of records(config)) projection.ingest(record);
    expect(config.expectedModel).toBe(MODEL); expect(config.claudeResolvedModel).toBe(MODEL);
    const reader = openTelemetry(config.dbPath), query = { project: config.project, runId: config.runId, startedAt, sessionId: sid, includeTrajectory: true };
    const telemetry = reader.read(query); reader.close();
    expect(telemetry.available).toBe(true); expect(telemetry.model).toBe(MODEL); expect(telemetry.provider).toBe('claude');
    expect(telemetry.usage).toMatchObject({ modelCalls: 2, inputTokens: 164, outputTokens: 15, cacheReadTokens: 50 });
    expect(telemetry.tools).toHaveLength(1); expect(telemetry.tools[0].status).toBe('completed');
    expect(telemetry.trajectory.requests).toBe(2); expect(telemetry.trajectory.toolCalls).toBe(1);
    for (const secret of ['PRIVATE_BRIEF', 'PRIVATE_REASONING', 'PRIVATE_COMMAND', 'PRIVATE_RESULT', 'Hello']) expect(JSON.stringify(telemetry)).not.toContain(secret);
    const content = readEventContent(config.dbPath, { ...query, eventId: 'request:claude-msg_1', workerLabel: 'Claude Code' });
    expect(content.sections.find(x => x.field === 'text')?.text).toBe('Hello 🙂');
    expect(content.sections.find(x => x.field === 'reasoning')?.text).toBe('PRIVATE_REASONING');
    const tool = readEventContent(config.dbPath, { ...query, eventId: 'part:claude-call-tool_1' });
    expect(JSON.parse(tool.sections.find(x => x.field === 'input')!.text)).toEqual({ command: 'PRIVATE_COMMAND' });
    expect(tool.sections.find(x => x.field === 'output')?.text).toBe('PRIVATE_RESULT');
    expect(readToolCallId(config.dbPath, { ...query, eventId: 'part:claude-call-tool_1' })).toBe('tool_1');
    expect(projection.terminal).toMatchObject({ sessionId: sid, response: 'Verified report 🙂', costUsd: 0.25 });
  } finally { projection.close(); }
});

test('subagents stay isolated from root model/usage checks and are included in exports', async () => {
  const config = fixture(), startedAt = Date.now(), projection = createClaudeProjection(config, { prompt: 'Dispatch run: claude-fixture', startedAt });
  try {
    projection.ingest(init(config));
    projection.ingest(assistant('msg_root', [{ type: 'tool_use', id: 'agent_1', name: 'Agent', input: { prompt: 'Investigate' } }]));
    projection.ingest(assistant('msg_child', [{ type: 'text', text: 'Subagent evidence' }], {}, { parent_tool_use_id: 'agent_1',
      message: { id: 'msg_child', model: 'claude-haiku-fixture', content: [{ type: 'text', text: 'Subagent evidence' }], usage: { input_tokens: 20, output_tokens: 5 }, stop_reason: 'end_turn' } }));
    projection.ingest(assistant('msg_final', [{ type: 'text', text: 'Root report' }], { input_tokens: 10, output_tokens: 2 }));
    projection.ingest(result());
    const reader = openTelemetry(config.dbPath), telemetry = reader.read({ project: config.project, runId: config.runId, startedAt, sessionId: sid, includeTrajectory: true }); reader.close();
    expect(telemetry.model).toBe(MODEL); expect(telemetry.usage.inputTokens).toBe(10); expect(telemetry.trajectory.stats.subagents).toBe(1);
    const archive = sessionExportEntries({ runDir: config.runDir, config, state: { sessionId: sid, startedAt, workerExited: true } });
    expect(archive.manifest.subagents).toEqual(['claude-subagent-agent_1']);
    const names: string[] = [], childChunks: Buffer[] = [];
    for await (const entry of archive.entries) {
      names.push(entry.path);
      if (entry.path.startsWith('subagents/')) for await (const chunk of entry.chunks!) childChunks.push(Buffer.from(chunk));
    }
    expect(names).toContain('subagents/claude-subagent-agent_1/session.jsonl');
    expect(Buffer.concat(childChunks).toString()).toContain('Subagent evidence');
  } finally { projection.close(); }
});

test('projection verifies workspace, permissions, exact resume session and resolved model', () => {
  const cases: [any, any, RegExp][] = [
    [{}, { cwd: os.tmpdir() }, /working directory/], [{}, { permissionMode: 'manual' }, /permission mode/],
    [{ resumeSessionId: other }, {}, /different session/], [{ model: 'claude-other-fixture' }, {}, /model selection/],
    [{}, { session_id: 'bad-session' }, /session ID/],
  ];
  for (const [options, record, pattern] of cases) {
    const config = fixture(options), projection = createClaudeProjection(config, { prompt: 'fixture' });
    try { expect(() => projection.ingest(init(config, record))).toThrow(pattern); } finally { projection.close(); }
  }
  const config = fixture(), projection = createClaudeProjection(config, { prompt: 'fixture' });
  try {
    expect(() => projection.ingest(result())).toThrow('no verified session'); projection.ingest(init(config));
    expect(() => projection.ingest(result({ session_id: other }))).toThrow('different session');
    expect(() => projection.ingest(assistant('wrong', [], {}, { message: { id: 'wrong', model: 'claude-other-fixture', content: [] } }))).toThrow('pinned model');
  } finally { projection.close(); }
});

test('retries, compactions, tool failures, todos and synthetic API errors retain their semantics', () => {
  const config = fixture(), startedAt = Date.now(); let clock = startedAt;
  const projection = createClaudeProjection(config, { prompt: 'Dispatch run: claude-fixture', startedAt, now: () => clock += 20 });
  try {
    projection.ingest(init(config));
    projection.ingest({ type: 'system', subtype: 'api_retry', session_id: sid, attempt: 1, error: 'rate_limit', error_status: 429 });
    projection.ingest({ type: 'system', subtype: 'compact_boundary', session_id: sid, compact_metadata: { trigger: 'auto', pre_tokens: 1000 } });
    projection.ingest(assistant('msg_todo', [{ type: 'tool_use', id: 'todo_1', name: 'TodoWrite', input: { todos: [{ content: 'Run tests', status: 'in_progress' }] } }]));
    projection.ingest({ type: 'user', session_id: sid, message: { content: [{ type: 'tool_result', tool_use_id: 'todo_1', is_error: true, content: 'Tool failed' }] } });
    projection.ingest(assistant('msg_error', [], {}, { error: 'billing_error', message: { id: 'msg_error', model: '<synthetic>', content: [{ type: 'text', text: 'Credit balance too low' }] } }));
    projection.ingest(result({ subtype: 'error_during_execution', is_error: true, errors: ['Credit balance too low'] }));
    const reader = openTelemetry(config.dbPath), telemetry = reader.read({ project: config.project, runId: config.runId, sessionId: sid, startedAt, includeTrajectory: true }); reader.close();
    expect(telemetry.todos).toEqual([{ content: 'Run tests', status: 'in_progress' }]);
    expect(telemetry.tools[0]).toMatchObject({ status: 'error', error: 'Tool failed' });
    expect(telemetry.trajectory.stats).toMatchObject({ compactions: 1, retryParts: 1, toolErrors: 1 });
    expect(projection.terminal.error.code).toBe('insufficient_quota');
    save(path.join(config.runDir, 'result.json'), projection.terminal);
    expect(finishResult(config, { exitCode: 1, stopReason: null })).toMatchObject({ status: 'blocked', error: { kind: 'quota' } });
  } finally { projection.close(); }
});

async function runFake(config, lines: any[], { malformed = '', linger = false }: any = {}) {
  const script = path.join(config.project, 'fake-claude.mjs'), prompt = buildPrompt(config, 'Quoted "brief" $HOME $(not-a-shell) 🙂');
  const stream = lines.map(record => JSON.stringify(record)).join('\n') + malformed;
  fs.writeFileSync(script, `import fs from 'node:fs'; let input='';process.stdin.setEncoding('utf8');process.stdin.on('data',s=>input+=s);process.stdin.on('end',()=>{
    fs.writeFileSync(${JSON.stringify(path.join(config.runDir, 'captured-prompt.txt'))},input);
    const bytes=Buffer.from(${JSON.stringify(stream)});let offset=0;const timer=setInterval(()=>{if(offset>=bytes.length){clearInterval(timer);${linger ? 'setInterval(()=>{},1000);' : ''}return;}process.stdout.write(bytes.subarray(offset,offset+=7));},1);
  });`);
  const err = fs.openSync(path.join(config.runDir, 'stderr.log'), 'w'); let failure: any = null, lingering = false;
  const bridge = startClaude(config, { prompt, startedAt: Date.now(), stderrFd: err, onSession: undefined, onModel: undefined,
    onFailure: error => failure = error, onNotice: undefined, onLingering: () => { lingering = true; bridge.child.kill(); } },
    { exitGraceMs: 30, pipeGraceMs: 30, spawnFn: (_exe, args, options) => {
      expect(options.shell).toBe(false); expect(options.windowsHide).toBe(true); expect(options.cwd).toBe(config.project);
      expect(options.env.CLAUDE_CONFIG_DIR).toBe(config.claudeHome); expect(args).not.toContain(prompt);
      expect(options.stdio.slice(0, 2)).toEqual(['pipe', 'pipe']); return spawn(NODE, [script], options);
    } });
  fs.closeSync(err);
  try { await once(bridge.child, 'close'); } finally { bridge.finalize(); }
  expect(fs.readFileSync(path.join(config.runDir, 'captured-prompt.txt'), 'utf8')).toBe(prompt);
  return { failure, lingering, result: JSON.parse(fs.readFileSync(path.join(config.runDir, 'result.json'), 'utf8')) };
}

test('fake native worker preserves UTF-8 chunk boundaries, the raw stream, final report and exact resume handle', async () => {
  const config = fixture({ resumeSessionId: sid }), lines = [init(config), assistant('msg_1', [{ type: 'text', text: 'Ready 🙂' }]), result()];
  const { failure, result: output } = await runFake(config, lines);
  expect(failure).toBeNull(); expect(output).toMatchObject({ sessionId: sid, response: 'Verified report 🙂' });
  expect(fs.readFileSync(path.join(config.runDir, 'claude-events.jsonl'), 'utf8')).toBe(lines.map(record => JSON.stringify(record)).join('\n'));
  expect(finishResult(config, { exitCode: 0, stopReason: null })).toMatchObject({ status: 'ready_for_review', sessionId: sid });
  expect(callbackMessage(config, { workerExited: true }, { kind: 'ready_for_review' })).toStartWith('[Claude Code ');
});

test('zero exit with partial content, malformed JSON, or an error result never reports success', async () => {
  const partialConfig = fixture(), malformedConfig = fixture(), errorConfig = fixture();
  const partialRun = await runFake(partialConfig, [init(partialConfig), assistant('msg_partial', [{ type: 'text', text: 'Partial reply' }])]);
  expect(partialRun.result.isError).toBe(true); expect(finishResult(partialConfig, { exitCode: 0, stopReason: null }).status).toBe('worker_failed');
  const malformed = await runFake(malformedConfig, [init(malformedConfig)], { malformed: '\nnot json\n' });
  expect(malformed.failure).not.toBeNull(); expect(finishResult(malformedConfig, { exitCode: 0, stopReason: null }).status).toBe('worker_failed');
  await runFake(errorConfig, [init(errorConfig), result({ subtype: 'error_during_execution', is_error: true, errors: ["You've hit your usage limit. Try again at 8 PM."] })]);
  expect(finishResult(errorConfig, { exitCode: 0, stopReason: null })).toMatchObject({ status: 'blocked', error: { kind: 'quota' } });
  const authConfig = fixture();
  const projection = createClaudeProjection(authConfig, { prompt: 'fixture' });
  try { projection.ingest(result({ subtype: 'error_during_execution', is_error: true, errors: ['Not logged in.'] })); expect(projection.terminal.sessionId).toBeNull(); }
  finally { projection.close(); }
});

test('terminal results survive a lingering process and trailing informational events', async () => {
  const config = fixture();
  const run = await runFake(config, [init(config), result(), { type: 'system', subtype: 'informational', content: 'Session ended.' }], { linger: true });
  expect(run.lingering).toBe(true); expect(run.failure).toBeNull(); expect(run.result.response).toBe('Verified report 🙂');
});

test('Claude dashboard serves message/tool content and export-ready trajectory after a reload', async () => {
  const config = fixture(), startedAt = Date.now(), projection = createClaudeProjection(config, { prompt: 'Dispatch run: claude-fixture', startedAt });
  for (const record of records(config)) projection.ingest(record); projection.close();
  save(path.join(config.runDir, 'config.json'), config);
  save(path.join(config.runDir, 'status.json'), { runId: config.runId, sessionId: sid, startedAt, updatedAt: Date.now(), workerExited: true,
    status: 'ready_for_review', tools: [], notifications: {} });
  const root = path.join(config.project, 'dashboard'), key = registerRun(config.runDir, root), catalog = createCatalog(root); catalog.refresh();
  expect(catalog.snapshot(key).selected.workerLabel).toBe('Claude Code');
  expect(catalog.snapshot(key).selected.trajectory.requests).toBe(2);
  const panel = await serveDashboard({ root, catalog });
  try {
    const response = await fetch(panel.url + 'runs/' + key + '/content?event=request%3Aclaude-msg_2');
    expect(response.status).toBe(200); const content: any = await response.json();
    expect(content.sections[0]).toMatchObject({ title: 'Claude Code response', text: 'Final reply.' });
  } finally { await panel.close(); }
});

test('CLI recognizes the Claude guide/worker and checks availability without starting a model', () => {
  const config = fixture(), root = path.join(config.project, 'registry'), env = { ZCODE_DASHBOARD_ROOT: root };
  const guide = cli(['guide', 'claude', '--orchestrator', 'codex'], { cwd: config.project, env });
  expect(guide.status).toBe(0); expect(guide.stdout).toContain('agent-dispatch launch --worker claude');
  const file = path.join(config.project, 'config.json'); save(file, { ...config, claudeExe: path.join(config.project, 'missing-claude.exe') });
  const check = cli(['check', '--config', file], { cwd: config.project, env });
  expect(check.envelope.error.code).toBe('WORKER_UNAVAILABLE'); expect(check.envelope.error.message).toContain('Claude executable');
  expect(fs.existsSync(path.join(config.runDir, 'startup.json'))).toBe(false);
  const skills = cli(['skills', 'install', '--worker', 'claude', '--include-missing', '--dry-run'], { cwd: config.project, env });
  expect(skills.status).toBe(0); expect(skills.envelope.data.actions).toHaveLength(2);
  expect(skills.envelope.data.actions.every(action => action.skill === 'delegate-to-claude')).toBe(true);
});

test('Claude error categories preserve actionable quota/auth/account/rate blockers', async () => {
  const { classifyError } = await import('../src/index.ts');
  expect(classifyError(claudeError('API Error: 401 Unauthorized', 'authentication_failed'))).toMatchObject({ kind: 'auth', stop: true });
  expect(classifyError(claudeError('Billing unavailable', 'billing_error'))).toMatchObject({ kind: 'quota', stop: true });
  expect(classifyError(claudeError('Your account is on hold', 'account_on_hold'))).toMatchObject({ kind: 'account', stop: true });
  expect(classifyError(claudeError('Please wait', 'rate_limit'))).toMatchObject({ kind: 'rate_limit', stop: false });
});
