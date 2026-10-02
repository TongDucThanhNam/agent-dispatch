import fs from 'node:fs';
import path from 'node:path';
import { home, CLI_NAME, CLI_ENTRY } from '../core/paths.ts';
import { LABELS, type WorkerKind } from '../core/config.ts';
import { activeRuns } from '../core/runs.ts';
import { CliError, labelled } from '../protocol/errors.ts';

export const SKILL_NAMES: Record<WorkerKind, string> = { zcode: 'delegate-to-zcode', agy: 'delegate-to-agy', codex: 'delegate-to-codex', claude: 'delegate-to-claude', mcode: 'delegate-to-mcode' };
export const SKILL_ROOTS = (): Record<'claude' | 'codex', string> => ({ claude: home('.claude', 'skills'), codex: home('.codex', 'skills') });
export const THIN_MARKER = '<!-- agent-dispatch:thin-skill v1 -->';

const DEFAULT_DESCRIPTIONS: Record<WorkerKind, string> = {
  zcode: 'Use when explicitly invoked for ZCode to investigate, the orchestrator to plan from that evidence, and ZCode to implement, test, self-review, and report results, either through the native CLI or an explicitly requested IDLE queue task.',
  agy: 'Use when explicitly invoked for AGY to investigate, the orchestrator to plan from that evidence, and AGY to implement, test, self-review, and return a final verified report with a local progress panel.',
  codex: 'Use when explicitly invoked for a separate Codex CLI worker to investigate, the orchestrator to plan from that evidence, and the worker to implement, test, self-review, and return a final verified report with a local progress panel.',
  claude: 'Use when the user requests delegation to a separate Claude Code CLI worker for discovery, implementation, testing, self-review, and a final verified report through agent-dispatch.',
  mcode: 'Use when the user requests delegation to MiniMax Code Desktop (mcode) for discovery, implementation, testing, self-review, and a verified report through its desktop account and sessions, not the standalone CLI.',
};

/** `thin` (points at the CLI), `legacy` (bundled scripts), `other`, or `missing`. */
export function skillState(dir: string) {
  let text: string; try { text = fs.readFileSync(path.join(dir, 'SKILL.md'), 'utf8'); } catch { return 'missing'; }
  if (text.includes(THIN_MARKER)) return 'thin';
  return fs.existsSync(path.join(dir, 'scripts')) ? 'legacy' : 'other';
}

function frontmatterDescription(text: string | null) {
  const match = text?.match(/^﻿?---\r?\n([\s\S]*?)\r?\n---/);
  const line = match?.[1].split(/\r?\n/).find(l => l.startsWith('description:'));
  return line ? line.slice('description:'.length).trim() : null;
}

/** The whole installed skill: a pointer to the CLI. Behavior changes belong in the CLI, not here. */
export function thinSkill(worker: WorkerKind, description: string) {
  const label = LABELS[worker];
  return `---
name: ${SKILL_NAMES[worker]}
description: ${description}
---

# Delegate to ${label}

${THIN_MARKER}
All behavior lives in the \`${CLI_NAME}\` CLI. Update the tool, never this file.

1. Run \`${CLI_NAME} guide ${worker}\` once per task and follow it exactly: roles, the discovery → planning → execution flow, waiting, errors.
2. Brief templates: \`${CLI_NAME} template discovery\` and \`${CLI_NAME} template assignment\`.
3. Every run command takes \`--worker ${worker}\`.
${worker === 'zcode' ? `4. Only when the user explicitly asks for IDLE: \`${CLI_NAME} guide idle\`.\n` : ''}
If \`${CLI_NAME}\` is not on PATH, use \`bun ${CLI_ENTRY.replaceAll('\\', '/')}\` in its place.
`;
}

const openaiYaml = (worker: WorkerKind) => `interface:
  display_name: "Delegate to ${LABELS[worker]}"
  short_description: "Direct ${LABELS[worker]} work through the ${CLI_NAME} CLI"
  default_prompt: "Use $${SKILL_NAMES[worker]} to have the worker investigate first, plan from its evidence with acceptance tests, then delegate implementation, testing, self-review and fixes to the worker for one final verified report."
policy:
  allow_implicit_invocation: ${worker === 'claude' ? 'true' : 'false'}
`;

export interface InstallOptions { target?: 'claude' | 'codex' | 'all'; worker?: WorkerKind; dryRun?: boolean; includeMissing?: boolean; force?: boolean; now?: Date; roots?: Record<'claude' | 'codex', string> }

/**
 * Replaces installed delegate skills with thin pointers to the CLI. The old
 * directory is moved (never deleted) to `<root>/../skill-backups/<date>-agent-dispatch-cli/`.
 * By default only skills that already exist are replaced.
 */
export function installSkills({ target = 'all', worker: selectedWorker, dryRun = false, includeMissing = false, force = false, now = new Date(), roots: rootMap = SKILL_ROOTS() }: InstallOptions = {}) {
  if (!dryRun && !force) {
    const active = activeRuns();
    if (active.length) throw new CliError('RUN_ACTIVE', 'Runs are active; installed skills are not replaced while an orchestrator may be following them.',
      'Retry after they finish, or pass --force.', { runs: active.map(run => run.ref) });
  }
  const roots = Object.entries(rootMap).filter(([name]) => target === 'all' || target === name);
  const stamp = now.toISOString().slice(0, 10);
  const actions: any[] = [];
  for (const [targetName, root] of roots) {
    for (const worker of Object.keys(SKILL_NAMES) as WorkerKind[]) {
      if (selectedWorker && selectedWorker !== worker) continue;
      const dir = path.join(root, SKILL_NAMES[worker]), state = skillState(dir);
      const entry: any = { target: targetName, skill: SKILL_NAMES[worker], was: state };
      if (state === 'missing' && !includeMissing) { actions.push({ ...entry, action: 'skipped' }); continue; }
      let current: string | null = null; try { current = fs.readFileSync(path.join(dir, 'SKILL.md'), 'utf8'); } catch {}
      const content = thinSkill(worker, frontmatterDescription(current) ?? DEFAULT_DESCRIPTIONS[worker]);
      if (state === 'thin' && current === content) { actions.push({ ...entry, action: 'unchanged' }); continue; }
      let yaml: string | null = null; try { yaml = fs.readFileSync(path.join(dir, 'agents', 'openai.yaml'), 'utf8'); } catch {}
      let backup: string | null = null;
      if (state !== 'missing') {
        const base = path.join(path.dirname(root), 'skill-backups', `${stamp}-agent-dispatch-cli`);
        backup = path.join(base, SKILL_NAMES[worker]);
        for (let n = 2; fs.existsSync(backup); n++) backup = path.join(base, `${SKILL_NAMES[worker]}-${n}`);
      }
      if (!dryRun) labelled('IO_ERROR', () => {
        if (backup) { fs.mkdirSync(path.dirname(backup), { recursive: true }); fs.renameSync(dir, backup); }
        fs.mkdirSync(path.join(dir, 'agents'), { recursive: true });
        fs.writeFileSync(path.join(dir, 'SKILL.md'), content);
        fs.writeFileSync(path.join(dir, 'agents', 'openai.yaml'), yaml && !yaml.includes('scripts/') ? yaml : openaiYaml(worker));
      }, 'Nothing was deleted; check the skill and backup directories.');
      actions.push({ ...entry, action: state === 'missing' ? 'created' : 'replaced', ...(backup ? { backup } : {}), bytes: Buffer.byteLength(content) });
    }
  }
  return { dryRun, actions };
}
