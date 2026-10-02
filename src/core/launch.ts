import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { readJson, saveJson, sleep } from './fsutil.ts';
import { CLI_ENTRY, CLI_NAME } from './paths.ts';
import { validateConfig, driftOf, shortRef, configuredEffort } from './config.ts';
import { lockPathFor, readLock, lockHeld } from './lock.ts';
import { capChanged, compactStatus, qualified } from './status.ts';
import { worktreeFingerprint, compareFingerprints } from './worktree.ts';
import { readAssignment, MAX_ASSIGNMENT_CHARACTERS } from './preflight.ts';
import { clean } from '../monitor/monitor-core.ts';
import { registerRun, ensureDashboard } from '../monitor/hub.ts';
import { verifyNative } from '../workers/zcode/native.ts';
import { readAgySelection } from '../workers/agy/adapter.ts';
import { readCodexSelection } from '../workers/codex/adapter.ts';
import { readClaudeRuntime } from '../workers/claude/adapter.ts';
import { probeMcode, resolveMcodeSelection, verifyMcodeSession, MCODE_API } from '../workers/mcode/desktop.ts';
import { CliError, labelled, labelledAsync } from '../protocol/errors.ts';

// Pins the default Codex selection once so resume and the model/provider check use the same values.
export function resolveCodexSelection(config: any) {
  if (!config.codexModel || !config.codexProvider || !config.codexEffort) {
    const selection = readCodexSelection(config.codexHome);
    config.codexModel ??= selection.model; config.codexProvider ??= selection.provider; config.codexEffort ??= selection.effort;
  }
  if (!config.codexModel) throw new CliError('MODEL_UNAVAILABLE', 'No Codex model is selected.', 'Pass --model or set model in the Codex config.toml.');
  if (!config.codexProvider) throw new CliError('MODEL_UNAVAILABLE', 'The Codex model provider could not be resolved.', 'Pass --provider.');
  config.expectedModel = config.codexModel; config.expectedProvider = config.codexProvider;
}

const discoveryError = (message: string, hint?: string) => new CliError('DISCOVERY_INVALID', message, hint);

// An execution stage started from discovery records whether project files changed since that packet was written.
export function linkDiscovery(config: any) {
  if (!config.discoveryRunDir) return null;
  let dir: string, dconfig: any, dstate: any;
  try { dir = fs.realpathSync(config.discoveryRunDir); dconfig = readJson(path.join(dir, 'config.json')); dstate = readJson(path.join(dir, 'status.json')); }
  catch { throw discoveryError('The discovery run directory has no readable run record.'); }
  if (dconfig.stage !== 'discovery') throw discoveryError('--from must name a discovery-stage run.', 'Pass the ref of the discovery run whose report you planned from.');
  if (path.relative(fs.realpathSync(dconfig.project), config.project) !== '') throw discoveryError('The discovery run belongs to a different project.');
  if (!dstate.workerExited) throw discoveryError('The discovery worker has not exited yet.', `Wait for it: ${CLI_NAME} wait ${shortRef(dconfig.runId)}`);
  const reportPath = path.join(dir, 'worker-report.md');
  if (!fs.existsSync(reportPath)) throw discoveryError('The discovery run has no report to plan from.', 'Resume or rerun discovery before planning.');
  config.discoveryRunDir = dir;
  if (!config.resumeSessionId) {
    let recorded: any; try { recorded = readJson(path.join(dir, 'discovery.json')); } catch {}
    config.discoveryDrift = driftOf(recorded?.after ? compareFingerprints(recorded.after, worktreeFingerprint(config.project))
      : { available: false, clean: null, changed: [], reason: 'The discovery run has no recorded fingerprint.' });
  }
  return { runDir: dir, reportPath, status: dstate.status, drift: config.discoveryDrift };
}

const assignmentOf = (file: string, stage: string) => labelled('ASSIGNMENT_INVALID', () => readAssignment(file), `Start from: ${CLI_NAME} template ${stage === 'discovery' ? 'discovery' : 'assignment'}`);

/**
 * Everything a launch validates before any process starts: config, lock,
 * brief, discovery link, callback executable and worker/model availability.
 */
export async function prepare(raw: any, { checkLock = true } = {}) {
  const config = validateConfig(raw);
  if (checkLock && fs.existsSync(lockPathFor(config.project)))
    throw lockHeld(readLock(config.project), 'A managed run already holds this project lock. Inspect it before launching another.');
  const assignment = assignmentOf(config.promptFile, config.stage);
  const discovery = linkDiscovery(config);
  if (config.notify && !fs.existsSync(config.codexExe))
    throw new CliError('WORKER_UNAVAILABLE', 'Codex callback executable is missing.', 'Use --notify none, or pass --config with codexExe.');
  if (config.workerKind === 'zcode') {
    labelled('WORKER_UNAVAILABLE', () => { for (const file of [config.nativeCli, config.builtinConfig, config.cliConfig]) if (!fs.existsSync(file)) throw new Error(`ZCode runtime file is missing: ${file}`); });
    labelled('MODEL_UNAVAILABLE', () => verifyNative(config), `List qualified IDs with: ${CLI_NAME} models --worker zcode`);
  } else if (config.workerKind === 'agy') {
    if (!fs.existsSync(config.agyExe)) throw new CliError('WORKER_UNAVAILABLE', 'AGY executable is missing.');
  } else if (config.workerKind === 'codex') {
    if (!fs.existsSync(config.codexExe)) throw new CliError('WORKER_UNAVAILABLE', 'Codex executable is missing.');
    resolveCodexSelection(config);
  } else if (config.workerKind === 'claude') {
    if (!fs.existsSync(config.claudeExe)) throw new CliError('WORKER_UNAVAILABLE', 'Claude executable is missing.', 'Install Claude Code or set claudeExe in --config.');
    const runtime = await readClaudeRuntime(config.claudeExe);
    if (!runtime.ok) throw new CliError('WORKER_UNAVAILABLE', runtime.error!, 'Claude Code 2.1.259 or later is required; update the CLI.');
  } else if (config.workerKind === 'mcode') {
    const runtime = await labelledAsync('WORKER_UNAVAILABLE', () => probeMcode(config), 'Run agent-dispatch mcode setup. No standalone CLI fallback is used.');
    labelled('MODEL_UNAVAILABLE', () => resolveMcodeSelection(config, runtime));
    if (config.resumeSessionId) {
      const value = await labelledAsync('WORKER_UNAVAILABLE', () => runtime.client.request(`${MCODE_API}/session/${config.resumeSessionId}`));
      labelled('INVALID_CONFIG', () => verifyMcodeSession(config, value.session, config.resumeSessionId));
      if (value.session.status?.status_type === 1) throw new CliError('RUN_ACTIVE', 'The MiniMax desktop session is already running.');
    }
  }
  return { config, assignment, discovery };
}

export const selectionOf = (config: any) => ({ model: qualified(config.expectedProvider, config.expectedModel), effort: configuredEffort(config) });
const notifyOf = (config: any) => config.notify ? 'codex' : 'none';

/** Dry run of launch: validates everything and starts nothing. */
export async function check(raw: any) {
  const { config, assignment, discovery } = await prepare(raw, { checkLock: false });
  const lock = readLock(config.project);
  return { valid: true, worker: config.workerKind, stage: config.stage, ...selectionOf(config), mode: config.mode, notify: notifyOf(config),
    ...(discovery ? { fromDiscovery: shortRef(path.basename(discovery.runDir)), discoveryDrift: capChanged(discovery.drift) } : {}),
    assignmentCharacters: assignment.length, maxAssignmentCharacters: MAX_ASSIGNMENT_CHARACTERS,
    ...(lock ? { lockHeldBy: lock.runId ?? 'unknown' } : {}), startsWorker: false };
}

export async function launch(raw: any, { startupPolls = 100 } = {}) {
  const { config, discovery } = await prepare(raw);
  if (config.workerKind === 'agy' && !config.agyModel) {
    const selection = await labelledAsync('MODEL_UNAVAILABLE', () => readAgySelection(config.agyExe), 'Pass --model explicitly.');
    config.agyModel = selection.model; config.expectedModel = selection.model; config.agyEffort ??= selection.effort;
  }
  fs.mkdirSync(config.runDir, { recursive: true });
  const configPath = path.join(config.runDir, 'config.json');
  if (fs.existsSync(configPath) || fs.existsSync(path.join(config.runDir, 'status.json')))
    throw new CliError('RUN_ACTIVE', 'This run directory already has a run. Inspect or resume it instead of relaunching.', `${CLI_NAME} status ${shortRef(config.runId)}`);
  saveJson(configPath, config);
  const ref = shortRef(config.runId);
  const receipt: any = { ref, runId: config.runId, worker: config.workerKind, stage: config.stage, ...selectionOf(config), mode: config.mode, notify: notifyOf(config),
    ...(discovery ? { fromDiscovery: shortRef(path.basename(discovery.runDir)), discoveryDrift: capChanged(discovery.drift) } : {}), runDir: config.runDir };
  const out = fs.openSync(path.join(config.runDir, 'runner.log'), 'a'), err = fs.openSync(path.join(config.runDir, 'runner-stderr.log'), 'a');
  const child = spawn(process.execPath, [CLI_ENTRY, 'supervise', '--config', configPath],
    { cwd: config.project, detached: true, windowsHide: true, shell: false, stdio: ['ignore', out, err] });
  let spawnError: any = null;
  child.once('error', error => { spawnError = error; });
  fs.closeSync(out); fs.closeSync(err); child.unref();
  for (let i = 0; i < startupPolls; i++) {
    if (spawnError) throw new CliError('LAUNCH_FAILED', clean(spawnError.message, 300), undefined, { runDir: config.runDir });
    const startupFile = path.join(config.runDir, 'startup.json');
    if (fs.existsSync(startupFile)) {
      let startup: any; try { startup = readJson(startupFile); } catch { await sleep(50); continue; }
      if (startup.error) throw new CliError('LAUNCH_FAILED', startup.error, `Details: ${CLI_NAME} status ${ref}`, { ref, runDir: config.runDir });
      receipt.runnerPid = startup.runnerPid; receipt.workerPid = startup.workerPid;
      try { const key = registerRun(config.runDir); try { const hub = await ensureDashboard(); receipt.url = hub.url + '#run=' + key; } catch (error) { receipt.dashboardWarning = clean(error.message, 300); } }
      catch (error) { receipt.dashboardWarning = clean(error.message, 300); }
      receipt.url ??= startup.url;
      return receipt;
    }
    await sleep(100);
  }
  try { registerRun(config.runDir); } catch {}
  throw new CliError('STARTUP_UNCONFIRMED', 'The runner did not confirm startup in time.', `Inspect it with ${CLI_NAME} status ${ref}; do not launch a duplicate.`,
    { ref, runDir: config.runDir, runnerPid: child.pid ?? null });
}

/** Continues the exact saved worker session in a new run with a follow-up brief; stage and mode are kept. */
export async function resume(previousDir: string, briefFile: string) {
  const previous = readJson(path.join(previousDir, 'config.json')), status = compactStatus(previousDir);
  if (!status.workerExited) throw new CliError('RUN_ACTIVE', 'Cannot resume until the old worker has exited.', `${CLI_NAME} wait ${shortRef(previous.runId)}`);
  if (!status.sessionId) throw new CliError('RUN_NOT_ACTIVE', 'The run has no recorded worker session to resume.', 'Launch a fresh run instead.');
  // A discovery session is not turned into execution (launch --from instead).
  return launch({ ...previous, runId: undefined, runDir: undefined, mcodeTurnId: undefined, promptFile: path.resolve(briefFile), resumeSessionId: status.sessionId, discoveryDrift: null });
}
