import { afterAll, describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { cli as run, rmTree } from './helpers.ts';

// Every command runs in a child process against fixture run records; the hub
// registry points at an empty directory so the user's real runs are never seen.
const base = fs.mkdtempSync(path.join(os.tmpdir(), 'ad-cli-'));
const hubRoot = path.join(base, 'hub');
const project = path.join(base, 'project');
fs.mkdirSync(hubRoot); fs.mkdirSync(project);
afterAll(() => rmTree(base));

const cli = (...args: string[]) => run(args, { env: { ZCODE_DASHBOARD_ROOT: hubRoot }, cwd: project });

function fixtureRun(runId: string, { stage = 'discovery', status = 'ready_for_review', report = '# Report\n\nAll questions answered.\n', active = false, startedAt = Date.now() - 60_000 } = {}) {
  const runDir = path.join(project, '.zcode-dispatch', runId);
  fs.mkdirSync(runDir, { recursive: true });
  fs.writeFileSync(path.join(runDir, 'config.json'), JSON.stringify({ runId, project, runDir, workerKind: 'zcode', stage, notify: false,
    expectedProvider: 'fixture-provider', expectedModel: 'fixture-model', zcodeEffort: 'max' }));
  fs.writeFileSync(path.join(runDir, 'status.json'), JSON.stringify({ runId, workerKind: 'zcode', status, phase: active ? 'working' : 'finished',
    workerExited: !active, exitCode: active ? null : 0, runnerPid: active ? process.pid : 999_999, sessionId: 'sess_fixture',
    startedAt, endedAt: active ? null : startedAt + 30_000, updatedAt: Date.now() }));
  if (report) fs.writeFileSync(path.join(runDir, 'worker-report.md'), report);
  return runDir;
}

fixtureRun('run-1000-aaaa1111', { startedAt: Date.now() - 120_000 });
fixtureRun('run-2000-bbbb2222', { stage: 'execution', status: 'blocked', report: '', startedAt: Date.now() - 90_000 });
fixtureRun('run-3000-cccc3333', { stage: 'execution', status: 'running', active: true, report: '', startedAt: Date.now() - 30_000 });
fixtureRun('run-4000-dddd4444', { startedAt: 1 });
fixtureRun('run-5000-dddd4444', { startedAt: 2 });

describe('protocol surface', () => {
  test('version reports the protocol', () => {
    const r = cli('version');
    expect(r.status).toBe(0);
    expect(r.envelope).toMatchObject({ v: 1, ok: true, cmd: 'version', data: { protocol: 1 } });
  });

  test('--help is plain text listing commands; command help shows usage', () => {
    const r = cli('--help');
    expect(r.status).toBe(0); expect(r.envelope).toBeNull();
    for (const name of ['guide', 'launch', 'status', 'wait', 'report', 'runs']) expect(r.stdout).toContain(name);
    expect(cli('status', '--help').stdout).toContain('status <ref>');
  });

  test('unknown commands and options are usage errors with exit 2', () => {
    const unknown = cli('frob');
    expect(unknown.status).toBe(2);
    expect(unknown.envelope).toMatchObject({ v: 1, ok: false, error: { code: 'UNKNOWN_COMMAND' } });
    expect(unknown.envelope).not.toHaveProperty('cmd');
    const option = cli('status', 'aaaa1111', '--bogus');
    expect(option.status).toBe(2);
    expect(option.envelope.error).toMatchObject({ code: 'USAGE', hint: expect.stringContaining('Usage: agent-dispatch status') });
  });

  test('--pretty indents the same envelope', () => {
    const r = cli('version', '--pretty');
    expect(r.stdout).toContain('\n  "ok": true');
    expect(JSON.parse(r.stdout).cmd).toBe('version');
  });

  test('guide and template print raw text', () => {
    const guide = cli('guide', 'zcode', '--orchestrator', 'claude');
    expect(guide.status).toBe(0); expect(guide.envelope).toBeNull();
    expect(guide.stdout).toContain('agent-dispatch launch --worker zcode');
    expect(cli('template', 'discovery').stdout).toStartWith('# Discovery brief');
    expect(cli('template', 'nope').status).toBe(2);
  });
});

describe('run commands', () => {
  test('status of a settled discovery run is compact, null-free and suggests the planning step', () => {
    const r = cli('status', 'aaaa1111');
    expect(r.status).toBe(0);
    expect(r.stdout).not.toContain('null');
    expect(r.envelope.data).toMatchObject({ ref: 'aaaa1111', worker: 'zcode', stage: 'discovery', status: 'ready_for_review', settled: true,
      model: 'fixture-provider/fixture-model', effort: 'max', notify: 'none' });
    expect(r.envelope.next).toEqual([
      'agent-dispatch report aaaa1111',
      'agent-dispatch template assignment',
      'agent-dispatch launch --worker zcode --from aaaa1111 --brief <plan.md>',
    ]);
    expect(cli('status', 'aaaa1111', '--full').envelope.data).toHaveProperty('selection');
  });

  test('a blocked execution run without a report suggests resuming its session', () => {
    const r = cli('status', 'bbbb2222');
    expect(r.envelope.next).toEqual(['agent-dispatch resume bbbb2222 --brief <follow-up.md>']);
    const report = cli('report', 'bbbb2222');
    expect(report.status).toBe(3);
    expect(report.envelope.error).toMatchObject({ code: 'REPORT_MISSING', details: { status: 'blocked' } });
  });

  test('an active run suggests waiting and cannot be resumed or reported yet', () => {
    const r = cli('status', 'cccc3333');
    expect(r.envelope.data.settled).toBe(false);
    expect(r.envelope.next).toEqual(['agent-dispatch wait cccc3333']);
    expect(cli('resume', 'cccc3333', '--brief', 'x.md').envelope.error.code).toBe('RUN_ACTIVE');
    expect(cli('report', 'cccc3333').envelope.error.hint).toContain('agent-dispatch wait cccc3333');
  });

  test('refs resolve by suffix, full ID, last and path; ambiguity and misses are distinct errors', () => {
    expect(cli('status', 'run-1000-aaaa1111').envelope.data.ref).toBe('aaaa1111');
    expect(cli('status', path.join(project, '.zcode-dispatch', 'run-1000-aaaa1111')).envelope.data.ref).toBe('aaaa1111');
    expect(cli('status', 'last').envelope.data.ref).toBe('cccc3333');
    const ambiguous = cli('status', 'dddd4444');
    expect(ambiguous.status).toBe(2);
    expect(ambiguous.envelope.error.code).toBe('RUN_AMBIGUOUS');
    expect(ambiguous.envelope.error.details.candidates).toHaveLength(2);
    const missing = cli('status', 'eeee5555');
    expect(missing.status).toBe(3);
    expect(missing.envelope.error.code).toBe('RUN_NOT_FOUND');
  });

  test('report prints the raw report and truncates on request', () => {
    expect(cli('report', 'aaaa1111').stdout).toBe('# Report\n\nAll questions answered.\n');
    const cut = cli('report', 'aaaa1111', '--max-chars', '8').stdout;
    expect(cut).toStartWith('# Report\n\n[truncated at 8 of');
  });

  test('wait returns at once for a settled run', () => {
    const r = cli('wait', 'aaaa1111', '--timeout-minutes', '1');
    expect(r.status).toBe(0);
    expect(r.envelope).toMatchObject({ cmd: 'wait', data: { ref: 'aaaa1111', settled: true } });
  });

  test('stop refuses an exited worker', () => {
    const r = cli('stop', 'aaaa1111');
    expect(r.status).toBe(4);
    expect(r.envelope.error.code).toBe('RUN_NOT_ACTIVE');
  });

  test('runs lists this project newest first and filters active runs', () => {
    const all = cli('runs');
    expect(all.envelope.data.runs.map((x: any) => x.ref)).toEqual(['cccc3333', 'bbbb2222', 'aaaa1111', 'dddd4444', 'dddd4444']);
    expect(cli('runs', '--active').envelope.data.runs.map((x: any) => x.ref)).toEqual(['cccc3333']);
  });

  test('launch without a stage or brief is a usage error and starts nothing', () => {
    const brief = path.join(base, 'brief.md');
    fs.writeFileSync(brief, 'Fixture only.');
    expect(cli('launch', '--worker', 'zcode', '--brief', brief).envelope.error).toMatchObject({ code: 'USAGE', message: expect.stringContaining('--stage discovery') });
    expect(cli('launch', '--worker', 'zcode', '--stage', 'discovery').envelope.error).toMatchObject({ code: 'USAGE', hint: expect.stringContaining('template discovery') });
    expect(cli('check', '--worker', 'zcode', '--stage', 'execution', '--from', 'bbbb2222', '--brief', brief).envelope.error.code).toBe('DISCOVERY_INVALID');
    expect(fs.readdirSync(path.join(project, '.zcode-dispatch'))).toHaveLength(5);
  });
});
