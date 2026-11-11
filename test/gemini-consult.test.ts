import { test, expect } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { asset } from '../src/core/paths.ts';
import { validateConfig } from '../src/core/config.ts';
import { consultationPrompt } from '../src/workers/gemini/prompt.ts';
import { createGeminiProjection, startGeminiBridge } from '../src/workers/gemini/adapter.ts';
import { prepare, resume } from '../src/core/launch.ts';
import { supervise } from '../src/core/supervisor.ts';
import { acquireProjectLock } from '../src/core/lock.ts';
import { cli, rmTree } from './helpers.ts';

const safety = createRequire(import.meta.url)(asset('node', 'gemini-safety.cjs'));
const sid = 'gemini_1234567890abcdef', url = 'https://gemini.google.com/app/1234567890abcdef';
const selection = { model: '4 Argon', effort: 'high', displayModel: 'Argon Cao', verified: true };
const proof = { model: '4 Argon', effort: 'high', selection };
function fixture() {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'ad-consult-'));
  const promptFile = path.join(project, 'question.md'), context = path.join(project, 'context.md');
  fs.writeFileSync(promptFile, 'Keep this question\nverbatim.\n');
  fs.writeFileSync(context, '\uFEFFMeasured facts: 42 frames at 60 fps.\n');
  const config = validateConfig({ project, promptFile, workerKind: 'gemini', stage: 'discovery', notify: false, keepOpenMs: 0 });
  fs.mkdirSync(config.runDir, { recursive: true });
  return { project, promptFile, context, config };
}

test('sanitiser lists only redacted spans for synthetic credentials; email exceptions are exact, not blanket', () => {
  // Deliberately synthetic examples, never real credentials.
  const samples = ['sk-' + 'a'.repeat(30), 'sk-ant-api03-' + 'b'.repeat(25), 'github_pat_' + 'c'.repeat(25), 'ghp_' + 'd'.repeat(30),
    'xoxb-' + '1'.repeat(20), 'AIza' + 'A'.repeat(35), 'AKIA' + 'X'.repeat(16), 'hf_' + 'h'.repeat(30),
    'eyJ' + 'a'.repeat(15) + '.' + 'b'.repeat(20) + '.' + 'c'.repeat(20), '-----BEGIN RSA PRIVATE KEY-----',
    'Authorization: Bearer synthetic', 'api_key = "synthetic-credential"', 'fixture@example.invalid'];
  for (const sample of samples) {
    const spans = safety.sensitiveSpans('prefix ' + sample);
    expect(spans.length).toBeGreaterThan(0);
    try { safety.assertSafePrompt('prefix ' + sample); throw Error('accepted unsafe sample'); }
    catch (error: any) { expect(error.message).toContain('[REDACTED]'); expect(error.message).not.toContain(sample); expect(error.message).toContain('[7,'); }
  }
  expect(() => safety.assertSafePrompt('first@example.invalid', ['first@example.invalid'])).not.toThrow();
  expect(() => safety.assertSafePrompt('second@example.invalid', ['first@example.invalid'])).toThrow('email');
  expect(() => safety.assertSafePrompt('Authorization: Bearer synthetic', ['first@example.invalid'])).toThrow('authorization');
  for (const value of [true, '*', ['*'], ['@example.invalid'], ['bad'], ['a@example.invalid extra']]) expect(() => safety.validateAllowEmails(value)).toThrow('explicit list');
});

test('context prepends delimiters and preserves the question; context and full prompt are privacy checked', () => {
  const f = fixture();
  try {
    const question = fs.readFileSync(f.promptFile, 'utf8');
    const config = validateConfig({ ...f.config, geminiContextFile: f.context, geminiTimeoutSeconds: 900 });
    expect(consultationPrompt(config, question)).toBe('=== Context ===\nMeasured facts: 42 frames at 60 fps.\n\n\n=== Question ===\n' + question);
    expect(validateConfig(config).geminiTimeoutSeconds).toBe(900);
    for (const n of [10, 3600]) expect(validateConfig({ ...config, geminiTimeoutSeconds: n }).geminiTimeoutSeconds).toBe(n);
    for (const n of [9, 3601, 3.5, '900']) expect(() => validateConfig({ ...config, geminiTimeoutSeconds: n })).toThrow('geminiTimeoutSeconds');
    fs.writeFileSync(f.context, 'hidden@example.invalid');
    expect(() => consultationPrompt(config, question)).toThrow('email');
    expect(consultationPrompt({ ...config, geminiAllowEmails: ['hidden@example.invalid'] }, question)).toContain('=== Question ===');
    fs.writeFileSync(f.context, ' '); expect(() => consultationPrompt(config, question)).toThrow('empty');
    fs.writeFileSync(f.context, 'x'.repeat(100_000)); expect(() => consultationPrompt(config, question)).toThrow('100,000');
  } finally { rmTree(f.project); }
});

test('secret rejection precedes persistence, bridge discovery and delivery', async () => {
  const f = fixture(); let calls = 0;
  const prompt = 'Authorization: Bearer synthetic';
  try {
    expect(() => startGeminiBridge(f.config, { prompt }, { client: () => { calls++; } })).toThrow('[REDACTED]');
    expect(fs.readdirSync(f.config.runDir)).toEqual([]);
    fs.writeFileSync(f.promptFile, prompt);
    await expect(prepare(f.config, { probeGeminiRuntime: async () => { calls++; throw Error('unexpected probe'); } })).rejects.toThrow('[REDACTED]');
    expect(calls).toBe(0);
  } finally { rmTree(f.project); }
});

test('Gemini ignores an active coding project lock in preflight and supervisor, without removing it or guarding coding changes', async () => {
  const f = fixture(), lock = acquireProjectLock({ ...f.config, runId: 'coding-run' });
  const originalLock = fs.readFileSync(lock.lockPath);
  try {
    const prepared = await prepare(f.config, { probeGeminiRuntime: async () => ({ ready: true, busy: false,
      capabilities: ['thinking-level-selection', 'non-activating-window', 'turn-ownership-v2'] }) as any });
    expect(prepared.config.workerKind).toBe('gemini');
    await expect(prepare({ ...f.config, workerKind: 'codex', geminiContextFile: undefined, geminiTimeoutSeconds: undefined, geminiAllowEmails: undefined })).rejects.toThrow('project lock');
    const state = await supervise(f.config, { spawnWorker: ({ config, prompt }) => {
      expect(prompt).toBe(fs.readFileSync(f.promptFile, 'utf8'));
      const child: any = new EventEmitter(); child.pid = null; child.exitCode = null; child.signalCode = null;
      setTimeout(() => {
        fs.writeFileSync(path.join(config.runDir, 'result.json'), JSON.stringify({ sessionId: sid, response: 'Fake answer', ownership: 'exact', url }));
        child.exitCode = 0; child.emit('close', 0);
      }, 10);
      return child;
    }, telemetryFactory: () => ({ read: () => ({ available: false, reason: 'fake' }), close() {} }) });
    expect(state.status).toBe('ready_for_review');
    expect(fs.readFileSync(lock.lockPath)).toEqual(originalLock);
    expect(fs.existsSync(path.join(f.config.runDir, 'discovery.json'))).toBe(false);
  } finally { lock.release(); rmTree(f.project); }
});

test('preflight refuses older bridges and the global active-turn state even though the project lock is bypassed', async () => {
  const f = fixture();
  try {
    await expect(prepare(f.config, { probeGeminiRuntime: async () => ({ ready: true, busy: false, capabilities: ['thinking-level-selection', 'non-activating-window'] }) as any })).rejects.toThrow('reinstall');
    await expect(prepare(f.config, { probeGeminiRuntime: async () => ({ ready: true, busy: true }) as any })).rejects.toThrow('owns a turn');
  } finally { rmTree(f.project); }
});

test('all ownership levels survive projection and an unverified session cannot publish an answer', () => {
  for (const level of ['exact', 'marker', 'prefix']) {
    const f = fixture(), p = createGeminiProjection(f.config, { prompt: 'question' });
    try {
      p.ingest({ event: 'session', sessionId: sid, ...proof });
      expect(() => p.ingest({ event: 'response', sessionId: sid, responseId: 'model-response-message-content1', text: 'unowned' })).toThrow('ownership');
      expect(() => p.ingest({ event: 'cancelled', sessionId: sid })).toThrow('ownership');
      p.ingest({ event: 'ownership', sessionId: sid, userId: 'user-query-content-1', ownership: level });
      expect(() => p.ingest({ event: 'ownership', sessionId: sid, userId: 'user-query-content-foreign', ownership: level })).toThrow('changed');
      p.ingest({ event: 'response', sessionId: sid, responseId: 'model-response-message-content1', text: 'owned', ownership: level });
      p.ingest({ event: 'complete', sessionId: sid, responseId: 'model-response-message-content1', response: 'owned', ownership: level, completionSource: 'owned-response-dom', ...proof });
      expect(p.terminal).toMatchObject({ ownership: level, response: 'owned', url });
    } finally { p.close(); rmTree(f.project); }
  }
});

test('adapter accepts explicit rebinding frames and records the count, including identical prefix evidence', () => {
  for (const level of ['exact', 'marker', 'prefix']) {
    const f = fixture(), p = createGeminiProjection(f.config, { prompt: 'synthetic question' });
    const first = 'user-query-content-pending', next = 'user-query-content-server';
    try {
      p.ingest({ event: 'session', sessionId: sid, ...proof });
      p.ingest({ event: 'ownership', sessionId: sid, userId: first, ownership: level, rebindCount: 0 });
      const frame = { event: 'ownership', sessionId: sid, previousUserId: first, userId: next, ownership: level, sameVisibleText: true, rebindCount: 1 };
      expect(() => p.ingest({ ...frame, previousUserId: 'user-query-content-foreign' })).toThrow('rebinding');
      expect(() => p.ingest({ ...frame, rebindCount: 2 })).toThrow('rebinding');
      expect(() => p.ingest({ ...frame, ownership: 'prefix', sameVisibleText: false })).toThrow('rebinding');
      p.ingest(frame);
      expect(() => p.ingest(frame)).toThrow('sequence');
      p.ingest({ event: 'response', sessionId: sid, responseId: 'model-response-message-content1', ownership: level, text: 'owned reply' });
      p.ingest({ event: 'complete', sessionId: sid, responseId: 'model-response-message-content1', ownership: level, rebindCount: 1,
        response: 'owned reply', completionSource: 'owned-response-dom', ...proof });
      expect(p.terminal).toMatchObject({ sessionId: sid, ownership: level, rebindCount: 1, response: 'owned reply' });
    } finally { p.close(); rmTree(f.project); }
  }
});

test('adapter retains only IDs and evidence levels from ownership-failure diagnostics', () => {
  const f = fixture(), p = createGeminiProjection(f.config, { prompt: 'synthetic question' });
  try {
    p.ingest({ event: 'session', sessionId: sid, ...proof });
    p.ingest({ event: 'ownership', sessionId: sid, userId: 'user-query-content-pending', ownership: 'marker', rebindCount: 0 });
    p.ingest({ event: 'ownership', sessionId: sid, userId: 'user-query-content-server', previousUserId: 'user-query-content-pending', ownership: 'marker', rebindCount: 1 });
    p.ingest({ event: 'error', sessionId: sid, ownership: 'unverified', rebindCount: 1, message: 'Ownership check failed.', ownershipObservations: [
      [{ userId: 'user-query-content-pending', level: 'marker', text: 'DO NOT RETAIN THIS TEXT' }],
      [{ userId: 'user-query-content-server', level: 'exact' }, { userId: 'invalid diagnostic text', level: 'unverified' }],
    ] });
    expect(p.terminal).toMatchObject({ isError: true, rebindCount: 1, ownershipObservations: [
      [{ userId: 'user-query-content-pending', level: 'marker' }],
      [{ userId: 'user-query-content-server', level: 'exact' }, { userId: '[invalid-id]', level: 'unverified' }],
    ] });
    expect(JSON.stringify(p.terminal)).not.toContain('DO NOT RETAIN');
    expect(JSON.stringify(p.terminal)).not.toContain('invalid diagnostic text');
  } finally { p.close(); rmTree(f.project); }
});

test('ambiguous stream retains session URL in result/report and resume reaches it with per-turn context/email defaults', async () => {
  const f = fixture(); let delivered: any;
  const frames = [{ event: 'submitting', ...proof }, { event: 'error', message: 'Ownership failed.', sessionId: sid, url, submitted: true, ownership: 'unverified' }];
  const run = startGeminiBridge(f.config, { prompt: 'question' }, { client: async (_route, request) => {
    delivered = request;
    return new Response(frames.map(frame => JSON.stringify(frame) + '\n').join(''), { headers: { 'content-type': 'application/x-ndjson' } });
  } });
  try {
    await new Promise(resolve => run.child.once('close', resolve)); run.finalize();
    expect(delivered.timeoutSeconds).toBe(300);
    const result = JSON.parse(fs.readFileSync(path.join(f.config.runDir, 'result.json'), 'utf8'));
    expect(result).toMatchObject({ sessionId: sid, url, ownership: 'unverified', isError: true });
    expect(result.response).toBeUndefined();
    fs.writeFileSync(path.join(f.config.runDir, 'config.json'), JSON.stringify({ ...f.config, geminiContextFile: f.context, geminiTimeoutSeconds: 900, geminiAllowEmails: ['first@example.invalid'] }));
    fs.writeFileSync(path.join(f.config.runDir, 'status.json'), JSON.stringify({ workerKind: 'gemini', workerExited: true, runnerPid: null, status: 'worker_failed', sessionId: sid, runId: f.config.runId }));
    const report = cli(['report', f.config.runDir]);
    expect(report.status).toBe(0); expect(report.stdout).toContain('no verified answer'); expect(report.stdout).toContain(url);
    let captured: any; const launchRun = async (raw: any) => { captured = raw; return {}; };
    await resume(f.config.runDir, f.promptFile, {}, launchRun);
    expect(captured).toMatchObject({ resumeSessionId: sid, geminiContextFile: null, geminiTimeoutSeconds: 900, geminiAllowEmails: [] });
    await resume(f.config.runDir, f.promptFile, { geminiContextFile: f.context, geminiTimeoutSeconds: 1200, geminiAllowEmails: ['second@example.invalid'] }, launchRun);
    expect(captured).toMatchObject({ resumeSessionId: sid, geminiContextFile: f.context, geminiTimeoutSeconds: 1200, geminiAllowEmails: ['second@example.invalid'] });
  } finally { run.finalize(); rmTree(f.project); }
});

test('CLI advertises consult and Gemini flags; invalid/non-Gemini values fail before runtime access', () => {
  const f = fixture();
  try {
    for (const command of ['launch', 'resume']) for (const flag of ['--context FILE', '--timeout SECONDS', '--allow-email ADDRESS'])
      expect(cli([command, '--help']).stdout).toContain(flag);
    expect(cli(['template', '--help']).stdout).toContain('consult');
    const template = cli(['template', 'consult']); expect(template.status).toBe(0);
    for (const section of ['Who we are', 'Measured facts', 'What was tried', 'Constraints', 'Numbered questions', '[source]', '[common practice]', '[guess]', 'confidence', 'what I would need to know']) expect(template.stdout).toContain(section);
    for (const timeout of ['9', '3601', '1.5']) expect(cli(['launch', '--worker', 'gemini', '--stage', 'discovery', '--brief', f.promptFile, '--notify', 'none', '--timeout', timeout]).envelope.error.code).toBe('USAGE');
    expect(cli(['launch', '--worker', 'codex', '--stage', 'discovery', '--brief', f.promptFile, '--notify', 'none', '--context', f.context]).envelope.error.message).toContain('Gemini-only');
    const bad = cli(['launch', '--worker', 'gemini', '--stage', 'discovery', '--brief', f.promptFile, '--notify', 'none', '--allow-email', '*']);
    expect(bad.envelope.error.message).toContain('explicit list');
  } finally { rmTree(f.project); }
});

test('transport failure on resume retains the known conversation without a second delivery', async () => {
  const f = fixture(), routes: string[] = [];
  const run = startGeminiBridge({ ...f.config, resumeSessionId: sid }, { prompt: 'question' }, { client: async (route: string) => { routes.push(route); throw Error('offline fake transport'); } });
  try {
    await new Promise(resolve => run.child.once('close', resolve)); run.finalize();
    const result = JSON.parse(fs.readFileSync(path.join(f.config.runDir, 'result.json'), 'utf8'));
    expect(result).toMatchObject({ sessionId: sid, url, isError: true, ownership: 'unverified' });
    expect(routes).toEqual(['/run', '/stop']); // No second delivery.
  } finally { run.finalize(); rmTree(f.project); }
});
