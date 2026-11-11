import { expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { guideText } from '../src/guide/guide.ts';
import { WORKERS } from '../src/core/config.ts';
import { installSkills, SKILL_NAMES, skillState, THIN_MARKER } from '../src/skills/install.ts';
import { cli, rmTree } from './helpers.ts';

test('Gemini guide uses the autonomous chat worker without coding briefs', () => {
  const guide = guideText('gemini');
  expect(guide).toContain('ask-gemini-app');
  expect(guide).toContain('internal\nElectron bridge');
  expect(guide).toContain('never automatically resend');
  expect(guide).toMatch(/completion\s+is unconfirmed/);
  expect(guide).not.toContain('{{');
  expect(guide).toContain('agent-dispatch launch --worker gemini');
  expect(guide).toContain('4 Argon + High');
  expect(guide).toContain('gemini select');
  expect(guide).toContain('gemini start');
  expect(guide).toContain('hidden and non-focusable');
  expect(WORKERS as string[]).toContain('gemini');
});

test('CLI exposes the Gemini guide, scoped install and runtime status command', () => {
  const guide = cli(['guide', 'gemini']);
  expect(guide.status).toBe(0);
  expect(guide.stdout).toBe(guideText('gemini'));
  const install = cli(['skills', 'install', '--target', 'codex', '--worker', 'gemini', '--include-missing', '--dry-run']);
  expect(install.status).toBe(0);
  expect(install.envelope.data.dryRun).toBe(true);
  expect(install.envelope.data.actions).toHaveLength(1);
  expect(install.envelope.data.actions[0]).toMatchObject({ target: 'codex', skill: 'ask-gemini-app' });
  const launch = cli(['launch', '--worker', 'gemini']);
  expect(launch.status).toBe(2);
  expect(launch.envelope.error.code).toBe('USAGE');
  expect(cli(['gemini', '--help']).stdout).toContain('gemini setup|status');
  expect(cli(['gemini','setup','--uia','--dry-run']).envelope.error.code).toBe('USAGE');
  expect(cli(['gemini','restore','--uia']).envelope.error.code).toBe('USAGE');
  expect(cli(['gemini','select','--dry-run']).envelope.error.code).toBe('USAGE');
  expect(cli(['gemini','start','--dry-run']).envelope.error.code).toBe('USAGE');
});

test('Gemini installation is scoped and idempotent, without changing other skills', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'ad-gemini-skill-'));
  const roots = { codex: path.join(base, '.codex', 'skills'), claude: path.join(base, '.claude', 'skills') };
  const unrelated = path.join(roots.codex, SKILL_NAMES.grok, 'SKILL.md');
  fs.mkdirSync(path.dirname(unrelated), { recursive: true });
  fs.writeFileSync(unrelated, 'Keep this existing skill exactly.\n');
  const options = { roots, target: 'codex' as const, worker: 'gemini' as const, includeMissing: true, force: true };
  const dir = path.join(roots.codex, SKILL_NAMES.gemini);
  try {
    expect(installSkills({ ...options, dryRun: true }).actions).toMatchObject([{ action: 'created' }]);
    expect(fs.existsSync(dir)).toBe(false);
    expect(installSkills(options).actions).toMatchObject([{ target: 'codex', skill: 'ask-gemini-app', action: 'created' }]);
    expect(skillState(dir)).toBe('thin');
    const skill = fs.readFileSync(path.join(dir, 'SKILL.md'), 'utf8');
    expect(skill).toContain('agent-dispatch guide gemini');
    expect(skill).toContain('internal bridge');
    expect(skill).toContain('4 Argon + High');
    expect(skill).toContain('Never launch Gemini.exe');
    expect(skill).not.toContain('template discovery');
    expect(skill).toContain('--worker gemini');
    const yaml = fs.readFileSync(path.join(dir, 'agents', 'openai.yaml'), 'utf8');
    expect(yaml).toContain('$ask-gemini-app');
    expect(yaml).toContain('allow_implicit_invocation: false');
    expect(yaml).not.toContain('investigate first');
    expect(installSkills(options).actions).toMatchObject([{ action: 'unchanged' }]);
    expect(fs.readFileSync(unrelated, 'utf8')).toBe('Keep this existing skill exactly.\n');
    expect(fs.existsSync(roots.claude)).toBe(false);
  } finally { rmTree(base); }
});

test('managed computer-use Gemini skill migrates its description and prompt with a backup', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'ad-gemini-migrate-'));
  const roots = { codex: path.join(base, 'codex/skills'), claude: path.join(base, 'claude/skills') };
  const dir = path.join(roots.codex, SKILL_NAMES.gemini);
  fs.mkdirSync(path.join(dir, 'agents'), { recursive: true });
  const old = `---\nname: ask-gemini-app\ndescription: Uses Windows computer-use.\n---\n${THIN_MARKER}\nUse \`@oai/sky\`.\n`;
  fs.writeFileSync(path.join(dir, 'SKILL.md'), old);
  fs.writeFileSync(path.join(dir, 'agents/openai.yaml'), 'default_prompt: "Old interactive prompt"');
  try {
    const result = installSkills({ roots, target: 'codex', worker: 'gemini', force: true });
    const action = result.actions[0];
    expect(action.action).toBe('replaced');
    expect(fs.readFileSync(path.join(action.backup, 'SKILL.md'), 'utf8')).toBe(old);
    const current = fs.readFileSync(path.join(dir, 'SKILL.md'), 'utf8');
    expect(current).toContain('autonomous agent-dispatch Gemini worker');
    expect(current).not.toContain('@oai/sky');
    expect(fs.readFileSync(path.join(dir, 'agents/openai.yaml'), 'utf8')).toContain('agent-dispatch Gemini worker');
  } finally { rmTree(base); }
});
