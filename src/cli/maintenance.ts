import fs from 'node:fs';
import path from 'node:path';
import { readJson, isAlive, sleep, spawnCaptured } from '../core/fsutil.ts';
import { nodeExecutable, CLI_NAME, PACKAGE_ROOT } from '../core/paths.ts';
import { defaultPaths, shortRef, WORKERS, type WorkerKind } from '../core/config.ts';
import { readLock } from '../core/lock.ts';
import { activeRuns } from '../core/runs.ts';
import { dashboardBuilt, defaultRoot, ensureDashboard, healthy } from '../monitor/hub.ts';
import { nativePaths, nativeSelection, modelCatalog } from '../workers/zcode/native.ts';
import { readAgySelection } from '../workers/agy/adapter.ts';
import { readCodexSelection, EFFORTS as CODEX_EFFORTS } from '../workers/codex/adapter.ts';
import { readClaudeSelection, readClaudeRuntime, CLAUDE_EFFORTS, CLAUDE_ALIASES } from '../workers/claude/adapter.ts';
import { CliError, labelled, labelledAsync } from '../protocol/errors.ts';
import { SKILL_NAMES, SKILL_ROOTS, skillState } from '../skills/install.ts';

export const ZCODE_DEFAULT = (() => { const s = nativeSelection({}); return `${s.expectedProvider}/${s.expectedModel}`; })();

export async function models(worker: WorkerKind) {
  if (worker === 'zcode') {
    const ids = labelled('WORKER_UNAVAILABLE', () => modelCatalog(nativePaths()).map(m => m.id), 'Check the ZCode install with: agent-dispatch doctor');
    return { worker, default: ZCODE_DEFAULT, efforts: ['low', 'high', 'max'], models: ids };
  }
  if (worker === 'agy') {
    const exe = defaultPaths().agyExe;
    if (!fs.existsSync(exe)) throw new CliError('WORKER_UNAVAILABLE', 'AGY executable is missing.', exe);
    const selected = await labelledAsync('MODEL_UNAVAILABLE', () => readAgySelection(exe));
    return { worker, selected: selected.model, selectedEffort: selected.effort, efforts: ['low', 'medium', 'high'],
      note: 'Launch pins this selection unless --model is given.' };
  }
  if (worker === 'claude') {
    const paths = defaultPaths();
    if (!fs.existsSync(paths.claudeExe)) throw new CliError('WORKER_UNAVAILABLE', 'Claude executable is missing.', 'Install the native Claude Code CLI.');
    const selection = readClaudeSelection(paths.claudeHome);
    return { worker, selected: selection.model ? `claude/${selection.model}` : null, selectedEffort: selection.effort,
      efforts: CLAUDE_EFFORTS, models: CLAUDE_ALIASES,
      note: 'Advisory user/project/local settings; managed/account defaults are resolved by Claude. Launch pins the actual model from system/init for resumes. Effort support is model-dependent.' };
  }
  const selection = readCodexSelection(defaultPaths().codexHome);
  return { worker, selected: selection.model ? `${selection.provider}/${selection.model}` : null, selectedEffort: selection.effort, efforts: CODEX_EFFORTS,
    note: 'From CODEX_HOME/config.toml (active profile first). Pass --model and --provider separately to override.' };
}

type Check = { ok: boolean; [key: string]: unknown };

export async function doctor(cwd = process.cwd()) {
  const checks: Record<string, Check> = {};
  const paths = defaultPaths();
  checks.bun = { ok: true, version: process.versions.bun ?? null };
  const nodeExe = nodeExecutable();
  const node = await spawnCaptured(nodeExe, ['--version'], { timeoutMs: 10_000 });
  checks.node = { ok: node.ok, version: node.stdout.trim() || null, path: nodeExe, ...(node.ok ? {} : { error: node.error ?? node.stderr.trim() }) };
  try {
    const native = nativePaths();
    const missing = [native.nativeCli, native.builtinConfig, paths.cliConfig].filter(file => !fs.existsSync(file));
    const catalog = missing.length ? [] : modelCatalog(native);
    const hasDefault = catalog.some(m => m.id === ZCODE_DEFAULT);
    checks.zcode = { ok: !missing.length && hasDefault, defaultModel: ZCODE_DEFAULT, models: catalog.length,
      ...(missing.length ? { missing } : hasDefault ? {} : { error: 'The default model is not in the provider registry.' }) };
  } catch (error) { checks.zcode = { ok: false, error: error.message }; }
  checks.agy = { ok: fs.existsSync(paths.agyExe), exe: paths.agyExe };
  const codexSelection = readCodexSelection(paths.codexHome);
  checks.codex = { ok: fs.existsSync(paths.codexExe) && !!codexSelection.model, exe: paths.codexExe,
    selected: codexSelection.model ? `${codexSelection.provider}/${codexSelection.model}` : null, effort: codexSelection.effort };
  checks.claude = fs.existsSync(paths.claudeExe) ? { ...await readClaudeRuntime(paths.claudeExe), exe: paths.claudeExe }
    : { ok: false, exe: paths.claudeExe, error: 'Claude executable is missing.' };
  checks.idle = { ok: fs.existsSync(paths.adapter), adapter: paths.adapter };
  checks.hub = await hubState();
  const skills: Record<string, string> = {};
  for (const [target, root] of Object.entries(SKILL_ROOTS())) for (const [worker, name] of Object.entries(SKILL_NAMES)) skills[`${target}:${worker}`] = skillState(path.join(root, name));
  checks.skills = { ok: !Object.values(skills).includes('legacy'), ...skills,
    ...(Object.values(skills).includes('legacy') ? { hint: `${CLI_NAME} skills install --dry-run` } : {}) };
  const onPath = typeof Bun !== 'undefined' ? Bun.which(CLI_NAME) : null;
  checks.cli = { ok: !!onPath, package: PACKAGE_ROOT, ...(onPath ? { path: onPath } : { hint: `Run "bun link" in ${PACKAGE_ROOT}, or call bun ${path.join(PACKAGE_ROOT, 'src', 'cli', 'main.ts')}` }) };
  const lock = readLock(cwd);
  if (lock) checks.lock = { ok: false, project: cwd, runId: lock.runId ?? null, runnerAlive: isAlive(lock.runnerPid),
    hint: lock.runId ? `${CLI_NAME} status ${shortRef(lock.runId)}` : 'Inspect the lock file before launching.' };
  const workers = WORKERS.filter(name => checks[name].ok);
  return { ok: checks.node.ok && workers.length > 0, workers, checks };
}

async function hubState() {
  const root = defaultRoot();
  let record: any = null; try { record = readJson(path.join(root, 'hub.json')); } catch {}
  const running = await healthy(record), built = dashboardBuilt();
  return { ok: (running || !record || !isAlive(record?.pid)) && built, running, root, page: built ? 'built' : 'missing',
    ...(built ? {} : { hint: `Build the dashboard page: bun run build:web (in ${PACKAGE_ROOT})` }),
    ...(record?.pid ? { pid: record.pid, pidAlive: isAlive(record.pid) } : {}),
    ...(record?.startedAt ? { startedAt: new Date(record.startedAt).toISOString().replace(/\.\d{3}Z$/, 'Z') } : {}),
    ...(!running && record && isAlive(record.pid) ? { error: 'The hub process is alive but not answering its health check.' } : {}) };
}

export async function hubStatus() {
  const state = await hubState();
  return { ...state, activeRuns: activeRuns().map(run => run.ref) };
}

/** Replaces the shared dashboard process; refuses while runs are active so no live panel loses its hub. */
export async function hubRestart() {
  const active = activeRuns();
  if (active.length) throw new CliError('RUN_ACTIVE', 'Runs are active; the hub is not restarted while they are monitored.',
    'Retry after they finish.', { runs: active.map(run => run.ref) });
  const root = defaultRoot();
  let record: any = null; try { record = readJson(path.join(root, 'hub.json')); } catch {}
  const previousPid = record?.pid ?? null;
  if (await healthy(record)) {
    // Only the PID confirmed by the hub's own health endpoint is signalled.
    try { process.kill(record.pid); } catch (error) { throw new CliError('HUB_UNAVAILABLE', `Could not stop the hub: ${error.message}`); }
    for (let i = 0; i < 50 && isAlive(record.pid); i++) await sleep(100);
    if (isAlive(record.pid)) throw new CliError('HUB_UNAVAILABLE', 'The previous hub did not exit.', `Inspect process ${record.pid}.`);
  } else if (record && isAlive(record.pid)) {
    throw new CliError('HUB_UNAVAILABLE', 'The recorded hub process is alive but not answering; it is not stopped automatically.', `Inspect process ${record.pid} before replacing it.`);
  }
  const hub = await labelledAsync('HUB_UNAVAILABLE', () => ensureDashboard(root));
  return { restarted: true, previousPid, pid: hub.pid, root };
}
