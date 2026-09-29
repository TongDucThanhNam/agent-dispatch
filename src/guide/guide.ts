import fs from 'node:fs';
import { asset, CLI_NAME } from '../core/paths.ts';
import { UUID, WORKERS, type WorkerKind } from '../core/config.ts';
import { CliError } from '../protocol/errors.ts';

export const ORCHESTRATORS = ['claude', 'codex', 'generic'] as const;
export type Orchestrator = typeof ORCHESTRATORS[number];
export const TOPICS = ['zcode', 'agy', 'codex', 'claude', 'idle', 'monitor', 'desktop', 'errors'] as const;
export const TEMPLATES = ['discovery', 'assignment', 'review'] as const;

/** Which agent is running the CLI; decides how waiting for a run is described. */
export function detectOrchestrator(env: NodeJS.ProcessEnv = process.env): Orchestrator {
  if (env.CLAUDECODE) return 'claude';
  if (UUID.test(env.CODEX_THREAD_ID ?? '')) return 'codex';
  return 'generic';
}

const read = (...parts: string[]) => fs.readFileSync(asset(...parts), 'utf8').replace(/^﻿/, '');

function waiting(orchestrator: Orchestrator) {
  if (orchestrator !== 'generic') return read('guide', `wait-${orchestrator}.md`).trim();
  return `If you run as Codex with a task UUID:\n${read('guide', 'wait-codex.md').trim()}\n\nOtherwise (Claude Code or any agent that can run a background shell):\n${read('guide', 'wait-claude.md').trim()}`;
}

/**
 * `guide` prints the core protocol; `guide <worker>` appends that worker's
 * notes with the worker name filled in; other topics print only themselves.
 */
export function guideText(topic?: string, orchestrator: Orchestrator = detectOrchestrator()) {
  if (topic && !(TOPICS as readonly string[]).includes(topic))
    throw new CliError('USAGE', `Unknown guide topic "${topic}".`, `Topics: ${TOPICS.join(', ')}`);
  if (topic && !WORKERS.includes(topic as WorkerKind)) return read('guide', `${topic}.md`).replaceAll('{{CLI}}', CLI_NAME);
  const worker = topic ?? '<worker>';
  const core = read('guide', 'core.md').replace('{{WAITING}}', waiting(orchestrator));
  return (topic ? `${core.trimEnd()}\n\n${read('guide', `${topic}.md`)}` : core)
    .replaceAll('{{WORKER}}', worker).replaceAll('{{CLI}}', CLI_NAME);
}

export function templateText(name: string) {
  if (!(TEMPLATES as readonly string[]).includes(name))
    throw new CliError('USAGE', `Unknown template "${name}".`, `Templates: ${TEMPLATES.join(', ')}`);
  return read('templates', `${name}.md`);
}
