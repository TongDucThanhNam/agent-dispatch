import fs from 'node:fs';
import path from 'node:path';
import { readJson, isAlive } from './fsutil.ts';
import { RECORD_DIR, CLI_NAME } from './paths.ts';
import { shortRef } from './config.ts';
import { defaultRoot } from '../monitor/hub.ts';
import { CliError } from '../protocol/errors.ts';

const norm = (p: string) => process.platform === 'win32' ? path.resolve(p).toLowerCase() : path.resolve(p);
const isRunDir = (dir: string) => fs.existsSync(path.join(dir, 'config.json'));

/** Nearest `.zcode-dispatch` records directory at or above `start`, or null. */
export function findRecords(start: string): string | null {
  let dir = path.resolve(start);
  for (;;) {
    const candidate = path.join(dir, RECORD_DIR);
    try { if (fs.statSync(candidate).isDirectory()) return candidate; } catch {}
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

export function projectRunDirs(records: string | null): string[] {
  if (!records) return [];
  let names: string[] = []; try { names = fs.readdirSync(records); } catch {}
  return names.map(name => path.join(records, name)).filter(isRunDir);
}

export function registryRunDirs(root = defaultRoot()): string[] {
  const registry = path.join(root, 'runs');
  let names: string[] = []; try { names = fs.readdirSync(registry).filter(name => name.endsWith('.json')); } catch {}
  const dirs: string[] = [];
  for (const name of names) { try { const entry = readJson(path.join(registry, name)); if (typeof entry.runDir === 'string' && isRunDir(entry.runDir)) dirs.push(entry.runDir); } catch {} }
  return dirs;
}

function unique(dirs: string[]) {
  const seen = new Map<string, string>();
  for (const dir of dirs) if (!seen.has(norm(dir))) seen.set(norm(dir), path.resolve(dir));
  return [...seen.values()];
}

export interface RunRow { runDir: string; runId: string; ref: string; worker: string; stage: string; status: string; startedAt: number | null; active: boolean; project: string }

/** Lightweight listing record; never throws for a malformed run directory (it is skipped). */
export function describeRun(runDir: string): RunRow | null {
  try {
    const config = readJson(path.join(runDir, 'config.json'));
    let state: any = null; try { state = readJson(path.join(runDir, 'status.json')); } catch {}
    const active = !!state && !state.workerExited && isAlive(state.runnerPid);
    return { runDir: path.resolve(runDir), runId: config.runId, ref: shortRef(config.runId), worker: config.workerKind ?? 'zcode', stage: config.stage ?? 'execution',
      status: state ? (!state.workerExited && !active ? 'unconfirmed' : state.status) : 'starting', startedAt: state?.startedAt ?? null, active, project: config.project };
  } catch { return null; }
}

export interface RunScope { cwd?: string; project?: string }

/** Candidate runs: the scoped project's records first, then every run registered with the dashboard hub. */
export function candidateRuns({ cwd = process.cwd(), project }: RunScope = {}) {
  const records = project ? path.join(path.resolve(project), RECORD_DIR) : findRecords(cwd);
  return { records, dirs: unique([...projectRunDirs(records), ...registryRunDirs()]) };
}

const REF = /^[A-Za-z0-9][A-Za-z0-9._-]{0,100}$/;
const looksLikePath = (ref: string) => /[\\/:]/.test(ref) || ref.startsWith('.');

/**
 * Resolves a run reference to its run directory. Accepted forms: a run
 * directory path, a run ID, the 8-hex suffix of a generated run ID, or `last`.
 */
export function resolveRun(ref: string | undefined, scope: RunScope = {}): string {
  if (!ref) throw new CliError('USAGE', 'A run reference is required.', `Pass a run ref (id, 8-hex suffix, "last" or a run directory). List runs with: ${CLI_NAME} runs`);
  if (looksLikePath(ref) || !REF.test(ref)) {
    const dir = path.resolve(scope.cwd ?? process.cwd(), ref);
    if (isRunDir(dir)) return fs.realpathSync(dir);
    throw new CliError('RUN_NOT_FOUND', `No run record at ${dir}.`, `List runs with: ${CLI_NAME} runs`);
  }
  const { records, dirs } = candidateRuns(scope);
  if (ref === 'last') {
    const scoped = records ? projectRunDirs(records) : [];
    const rows = (scoped.length ? scoped : dirs).map(describeRun).filter((x): x is RunRow => !!x);
    rows.sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0));
    if (!rows.length) throw new CliError('RUN_NOT_FOUND', 'No runs were found.', 'Launch a run first, or pass --project.');
    return rows[0].runDir;
  }
  const lower = ref.toLowerCase();
  const suffix = /^[0-9a-f]{4,}$/.test(lower);
  const matches = dirs.filter(dir => { const name = path.basename(dir).toLowerCase(); return name === lower || (suffix && name.endsWith('-' + lower)); });
  const exact = matches.filter(dir => path.basename(dir).toLowerCase() === lower);
  const chosen = exact.length === 1 ? exact : matches;
  if (chosen.length === 1) return chosen[0];
  if (!chosen.length) throw new CliError('RUN_NOT_FOUND', `No run matches "${ref}".`, `List runs with: ${CLI_NAME} runs (or pass --project / a run directory).`);
  throw new CliError('RUN_AMBIGUOUS', `"${ref}" matches ${chosen.length} runs.`, 'Pass the full run ID or run directory.', { candidates: chosen.slice(0, 10) });
}

export function listRuns(scope: RunScope & { active?: boolean; limit?: number; all?: boolean } = {}) {
  const { records, dirs } = candidateRuns(scope);
  const source = !scope.all && records ? projectRunDirs(records) : dirs;
  let rows = source.map(describeRun).filter((x): x is RunRow => !!x);
  if (scope.active) rows = rows.filter(row => row.active);
  rows.sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0));
  return { scope: !scope.all && records ? path.dirname(records) : 'all', total: rows.length, runs: rows.slice(0, scope.limit ?? 10) };
}

/** Runs whose runner is still alive anywhere the hub knows about (used to refuse disruptive maintenance). */
export const activeRuns = () => unique(registryRunDirs()).map(describeRun).filter((x): x is RunRow => !!x && x.active);
