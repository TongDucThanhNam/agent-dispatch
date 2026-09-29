import { describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseArgs, int, oneOf, type CommandSpec } from '../src/cli/args.ts';
import { asset } from '../src/core/paths.ts';
import {
  CliError, EXIT_CODES, prune, okEnvelope, errorEnvelope, capChanged, isSettled,
  guideText, templateText, detectOrchestrator, TOPICS, TEMPLATES, installSkills, skillState, SKILL_NAMES,
} from '../src/index.ts';
import { rmTree } from './helpers.ts';

describe('envelopes', () => {
  test('prune drops null and undefined keys recursively but keeps falsy values and array slots', () => {
    expect(prune({ a: null, b: undefined, c: 0, d: false, e: '', f: { g: null, h: [null, { i: null, j: 1 }] } }))
      .toEqual({ c: 0, d: false, e: '', f: { h: [null, { j: 1 }] } } as any);
  });

  test('success envelope carries v, ok, cmd, data and only a nonempty next', () => {
    expect(okEnvelope('status', { a: 1 })).toEqual({ v: 1, ok: true, cmd: 'status', data: { a: 1 } } as any);
    expect(okEnvelope('status', {}, [])).not.toHaveProperty('next');
    expect(okEnvelope('status', {}, ['agent-dispatch wait x']).next).toEqual(['agent-dispatch wait x']);
  });

  test('error envelope omits absent cmd, hint and details', () => {
    expect(errorEnvelope(null, new CliError('INTERNAL', 'boom'))).toEqual({ v: 1, ok: false, error: { code: 'INTERNAL', message: 'boom' } } as any);
    const full = errorEnvelope('launch', new CliError('LOCK_HELD', 'held', 'wait', { ref: 'abcd1234' }));
    expect(full).toEqual({ v: 1, ok: false, cmd: 'launch', error: { code: 'LOCK_HELD', message: 'held', hint: 'wait', details: { ref: 'abcd1234' } } } as any);
    expect(new CliError('WAIT_TIMEOUT', 'x').exitCode).toBe(7);
  });

  test('every error code is documented in the errors guide with its exit code', () => {
    const table = fs.readFileSync(asset('guide', 'errors.md'), 'utf8');
    const documented = new Map<string, number>();
    for (const line of table.split('\n')) {
      const match = line.match(/^\| ([A-Z_, ]+) \| (\d) \|/);
      if (match) for (const code of match[1].split(',')) documented.set(code.trim(), Number(match[2]));
    }
    expect(Object.fromEntries(documented)).toEqual({ ...EXIT_CODES });
  });
});

describe('argument parser', () => {
  const spec: CommandSpec = { usage: 'demo <ref> [--limit N] [--full]', summary: 'demo', values: ['limit', 'brief'], flags: ['full'], aliases: { 'prompt-file': 'brief' }, args: [1, 1] };
  const usage = (argv: string[], message: RegExp) => {
    try { parseArgs(argv, spec); } catch (error: any) {
      expect(error.code).toBe('USAGE'); expect(error.message).toMatch(message); expect(error.hint).toBe('Usage: agent-dispatch demo <ref> [--limit N] [--full]'); return;
    }
    throw new Error('expected a usage error');
  };

  test('accepts spaced and = values, flags, aliases and the global flags', () => {
    expect(parseArgs(['r1', '--limit=5', '--full', '--prompt-file', 'b.md', '--pretty'], spec))
      .toEqual({ args: ['r1'], opts: { limit: '5', full: true, brief: 'b.md', pretty: true } });
    expect(parseArgs(['-h'], spec).opts.help).toBe(true);
  });

  test('rejects unknown, repeated, valueless and value-carrying flags and wrong arity', () => {
    usage(['r1', '--bogus'], /Unknown option --bogus/);
    usage(['r1', '--limit', '1', '--limit', '2'], /more than once/);
    usage(['r1', '--brief', 'a', '--prompt-file', 'b'], /more than once/);
    usage(['r1', '--limit'], /needs a value/);
    usage(['r1', '--full=yes'], /takes no value/);
    usage([], /Missing argument/);
    usage(['r1', 'r2'], /Unexpected argument: r2/);
  });

  test('int and oneOf validate ranges and choices', () => {
    expect(int({ n: '3' }, 'n', { min: 1, max: 5 })).toBe(3);
    expect(int({}, 'n')).toBeUndefined();
    expect(() => int({ n: '9' }, 'n', { min: 1, max: 5 })).toThrow(/from 1 to 5/);
    expect(() => int({ n: '1.5' }, 'n')).toThrow(/integer/);
    expect(oneOf({ w: 'agy' }, 'w', ['zcode', 'agy'] as const)).toBe('agy');
    expect(() => oneOf({ w: 'x' }, 'w', ['zcode', 'agy'] as const)).toThrow(/one of: zcode, agy/);
  });
});

describe('status helpers', () => {
  test('a run settles when finished, failed or unsupervised', () => {
    expect(isSettled({ phase: 'finished', runnerAlive: true })).toBe(true);
    expect(isSettled({ phase: 'working', status: 'worker_failed', runnerAlive: true })).toBe(true);
    expect(isSettled({ phase: 'working', status: 'running', runnerAlive: false })).toBe(true);
    expect(isSettled({ phase: 'working', status: 'running', runnerAlive: true })).toBe(false);
  });

  test('compact views cap changed-file lists and keep the total', () => {
    const changed = Array.from({ length: 25 }, (_, i) => `f${i}.ts`);
    const capped = capChanged({ available: true, clean: false, changedCount: 25, changed });
    expect(capped.changed).toHaveLength(10); expect(capped.changedCount).toBe(25);
    expect(capChanged(null)).toBeNull();
    const small = { changedCount: 1, changed: ['a'] };
    expect(capChanged(small)).toBe(small);
  });
});

describe('guide', () => {
  test('orchestrator detection prefers Claude Code, then a Codex task UUID', () => {
    expect(detectOrchestrator({ CLAUDECODE: '1', CODEX_THREAD_ID: '11111111-1111-4111-8111-111111111111' })).toBe('claude');
    expect(detectOrchestrator({ CODEX_THREAD_ID: '11111111-1111-4111-8111-111111111111' })).toBe('codex');
    expect(detectOrchestrator({ CODEX_THREAD_ID: 'not-a-uuid' })).toBe('generic');
  });

  test('every topic and template renders with no unresolved placeholders', () => {
    for (const orchestrator of ['claude', 'codex', 'generic'] as const) {
      for (const topic of [undefined, ...TOPICS]) expect(guideText(topic, orchestrator)).not.toContain('{{');
    }
    for (const name of TEMPLATES) expect(templateText(name).length).toBeGreaterThan(100);
    expect(() => guideText('bogus')).toThrow(/Unknown guide topic/);
    expect(() => templateText('bogus')).toThrow(/Unknown template/);
  });

  test('worker guides fill in the worker, describe only the caller\'s waiting mechanism and stay small', () => {
    const claude = guideText('codex', 'claude'), codex = guideText('codex', 'codex');
    expect(claude).toContain('agent-dispatch launch --worker codex');
    expect(claude).not.toContain('<worker>');
    expect(claude).not.toBe(codex);
    for (const worker of ['zcode', 'agy', 'codex'])
      for (const orchestrator of ['claude', 'codex'] as const)
        expect(Buffer.byteLength(guideText(worker, orchestrator))).toBeLessThan(8_000);
  });
});

describe('skills install', () => {
  function roots() {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'ad-skills-'));
    const map = { claude: path.join(base, '.claude', 'skills'), codex: path.join(base, '.codex', 'skills') };
    const legacy = path.join(map.claude, SKILL_NAMES.zcode);
    fs.mkdirSync(path.join(legacy, 'scripts'), { recursive: true });
    fs.mkdirSync(path.join(legacy, 'agents'), { recursive: true });
    fs.writeFileSync(path.join(legacy, 'SKILL.md'), '---\nname: delegate-to-zcode\ndescription: Custom trigger text.\n---\n\n# Old skill\n');
    fs.writeFileSync(path.join(legacy, 'scripts', 'run.mjs'), '// old runner');
    fs.writeFileSync(path.join(legacy, 'agents', 'openai.yaml'), 'default_prompt: "node scripts/run.mjs"\n');
    return { base, map, legacy };
  }

  test('a dry run reports the plan and touches nothing', () => {
    const { base, map, legacy } = roots();
    try {
      const result = installSkills({ roots: map, dryRun: true, now: new Date('2026-01-02T00:00:00Z') });
      const zcode = result.actions.find(a => a.target === 'claude' && a.skill === SKILL_NAMES.zcode);
      expect(zcode).toMatchObject({ was: 'legacy', action: 'replaced' });
      expect(zcode.backup).toContain(path.join('skill-backups', '2026-01-02-agent-dispatch-cli'));
      expect(result.actions.filter(a => a.action === 'skipped')).toHaveLength(Object.keys(SKILL_NAMES).length * 2 - 1);
      expect(skillState(legacy)).toBe('legacy');
    } finally { rmTree(base); }
  });

  test('install moves the old skill to a backup, keeps its description and is idempotent', () => {
    const { base, map, legacy } = roots();
    try {
      const now = new Date('2026-01-02T00:00:00Z');
      const first = installSkills({ roots: map, force: true, now });
      const action = first.actions.find(a => a.target === 'claude' && a.skill === SKILL_NAMES.zcode);
      expect(fs.readFileSync(path.join(action.backup, 'scripts', 'run.mjs'), 'utf8')).toBe('// old runner');
      const skill = fs.readFileSync(path.join(legacy, 'SKILL.md'), 'utf8');
      expect(skillState(legacy)).toBe('thin');
      expect(skill).toContain('description: Custom trigger text.');
      expect(skill).toContain('agent-dispatch guide zcode');
      expect(Buffer.byteLength(skill)).toBeLessThan(1_500);
      expect(fs.readFileSync(path.join(legacy, 'agents', 'openai.yaml'), 'utf8')).not.toContain('scripts/');
      expect(fs.existsSync(path.join(legacy, 'scripts'))).toBe(false);

      const again = installSkills({ roots: map, force: true, now });
      expect(again.actions.find(a => a.target === 'claude' && a.skill === SKILL_NAMES.zcode)?.action).toBe('unchanged');

      const created = installSkills({ roots: map, force: true, now, includeMissing: true, target: 'codex' });
      expect(created.actions.map(a => a.action)).toEqual(Object.keys(SKILL_NAMES).map(() => 'created'));
      expect(skillState(path.join(map.codex, SKILL_NAMES.agy))).toBe('thin');
    } finally { rmTree(base); }
  });

  test('worker-scoped installation creates only the requested delegate and preserves unrelated skills', () => {
    const { base, map, legacy } = roots();
    try {
      const result = installSkills({ roots: map, force: true, worker: 'claude', includeMissing: true });
      expect(result.actions.map(a => [a.target, a.skill, a.action])).toEqual([
        ['claude', 'delegate-to-claude', 'created'], ['codex', 'delegate-to-claude', 'created'],
      ]);
      expect(skillState(legacy)).toBe('legacy');
      expect(fs.existsSync(path.join(map.codex, SKILL_NAMES.codex))).toBe(false);
      expect(skillState(path.join(map.codex, SKILL_NAMES.claude))).toBe('thin');
      const again = installSkills({ roots: map, force: true, worker: 'claude', includeMissing: true });
      expect(again.actions.every(a => a.action === 'unchanged')).toBe(true);
    } finally { rmTree(base); }
  });
});
