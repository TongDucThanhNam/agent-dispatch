#!/usr/bin/env bun
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { readJson, sleep } from '../core/fsutil.ts';
import { CLI_NAME, nodeExecutable } from '../core/paths.ts';
import { validateConfig, defaultPaths, shortRef, UUID, WORKERS, type WorkerKind } from '../core/config.ts';
import { resolveRun, listRuns } from '../core/runs.ts';
import { compactStatus, statusSummary, markReview } from '../core/status.ts';
import { check, launch, resume } from '../core/launch.ts';
import { supervise } from '../core/supervisor.ts';
import { inspectProject } from '../core/preflight.ts';
import { registerRun, ensureDashboard, readRun, publicRun, serveHub, defaultRoot } from '../monitor/hub.ts';
import { exportRunToFile } from '../monitor/session-export.ts';
import { desktopHandoff } from '../workers/zcode/desktop.ts';
import { setupMcode, probeMcode, mcodePaths, verifyMcodeSession, MCODE_API } from '../workers/mcode/desktop.ts';
import { runWatch, recordNight, installSignalCleanup, validateId, validateIsoDeadline, validateNight, HarnessError } from '../idle/watch.ts';
import { guideText, templateText, detectOrchestrator, ORCHESTRATORS, TOPICS, TEMPLATES } from '../guide/guide.ts';
import { installSkills } from '../skills/install.ts';
import { doctor, models, hubStatus, hubRestart } from './maintenance.ts';
import { parseArgs, usageError, str, int, oneOf, type CommandSpec, type Opts } from './args.ts';
import { CliError, toCliError, labelled, labelledAsync } from '../protocol/errors.ts';
import { prune, writeOk, writeError, writeText, PROTOCOL_VERSION } from '../protocol/output.ts';

const VERSION: string = JSON.parse(fs.readFileSync(new URL('../../package.json', import.meta.url), 'utf8')).version;

/** What a command produced: an envelope payload, raw text, or nothing (it wrote its own output). */
type Result = { data: unknown; next?: string[] } | { text: string } | void;
interface Command extends CommandSpec { run(opts: Opts, args: string[]): Promise<Result> | Result }

const C = CLI_NAME;
const LAUNCH_VALUES = ['worker', 'stage', 'brief', 'project', 'from', 'model', 'effort', 'provider', 'mode', 'notify', 'thread', 'callback-model', 'config'];
const LAUNCH_ALIASES = { 'prompt-file': 'brief', 'from-discovery': 'from' };
const REF_ALIASES = { 'run-dir': 'ref' };
const LAUNCH_USAGE = '--worker zcode|agy|codex|claude|mcode --stage discovery|execution --brief FILE [--from REF] [--project DIR] [--model ID] [--effort LEVEL] [--provider ID] [--mode yolo|plan] [--notify auto|codex|none] [--thread UUID]';

// Run commands accept the ref positionally or through the historical --run-dir option.
function refOf(opts: Opts, args: string[]) {
  const ref = args[0] ?? str(opts, 'ref');
  return resolveRun(ref, { project: str(opts, 'project') });
}

function notifyOf(opts: Opts) {
  const legacy: Record<string, string> = { true: 'codex', false: 'none' };
  const raw = str(opts, 'notify'), mode = raw ? legacy[raw] ?? raw : 'auto';
  if (!['auto', 'codex', 'none'].includes(mode)) throw new CliError('USAGE', '--notify must be auto, codex or none.');
  const thread = str(opts, 'thread') ?? process.env.CODEX_THREAD_ID;
  if (mode === 'none') return { notify: false, threadId: null };
  if (mode === 'codex') return { notify: true, threadId: thread ?? null };
  return UUID.test(thread ?? '') ? { notify: true, threadId: thread } : { notify: false, threadId: null };
}

/** Maps launch/check options to the raw run configuration. `--config FILE` is the advanced, exclusive form. */
function launchInput(opts: Opts) {
  const configFile = str(opts, 'config');
  if (configFile) {
    const extra = Object.keys(opts).filter(key => !['config', 'pretty'].includes(key));
    if (extra.length) throw new CliError('USAGE', '--config cannot be combined with other launch options.', `Remove --${extra[0]}.`);
    return labelled('INVALID_CONFIG', () => readJson(path.resolve(configFile)));
  }
  const brief = str(opts, 'brief');
  if (!brief) throw new CliError('USAGE', '--brief FILE is required.', `Write it from: ${C} template discovery (stage 1) or ${C} template assignment (stage 2).`);
  const project = path.resolve(str(opts, 'project') ?? process.cwd());
  const from = str(opts, 'from') ? resolveRun(str(opts, 'from'), { project }) : null;
  const stage = oneOf(opts, 'stage', ['discovery', 'execution'] as const) ?? (from ? 'execution' : undefined);
  if (!stage) throw new CliError('USAGE', 'Pass --stage discovery (stage 1), or --stage execution --from <discovery ref> (stage 2).');
  const worker = oneOf(opts, 'worker', WORKERS) ?? 'zcode';
  return { project, promptFile: path.resolve(brief), workerKind: worker, stage, ...(from ? { discoveryRunDir: from } : {}),
    ...(str(opts, 'model') ? { model: str(opts, 'model') } : {}), ...(str(opts, 'effort') ? { effort: str(opts, 'effort') } : {}),
    ...(str(opts, 'provider') ? { provider: str(opts, 'provider') } : {}), mode: str(opts, 'mode') ?? 'yolo',
    ...(str(opts, 'callback-model') ? { callbackModel: str(opts, 'callback-model') } : {}), ...notifyOf(opts) };
}

/** Suggested follow-up commands for a run summary; kept short so agents can act without re-reading the guide. */
function nextFor(s: any): string[] | undefined {
  const r = s.ref;
  if (!s.settled) return s.notify === 'codex' && detectOrchestrator() === 'codex' ? undefined : [`${C} wait ${r}`];
  const next: string[] = [];
  if (s.report) next.push(`${C} report ${r}`);
  if (s.stage === 'discovery' && s.status === 'ready_for_review')
    next.push(`${C} template assignment`, `${C} launch --worker ${s.worker} --from ${r} --brief <plan.md>`);
  else if (s.sessionId && s.workerExited && !['ready_for_review', 'complete'].includes(s.status)) next.push(`${C} resume ${r} --brief <follow-up.md>`);
  return next.length ? next : undefined;
}

const launchNext = (receipt: any) => receipt.notify === 'codex' && detectOrchestrator() === 'codex' ? undefined : [`${C} wait ${receipt.ref}`];

async function waitFor(runDir: string, opts: Opts) {
  const interval = (int(opts, 'interval-seconds', { min: 1, max: 3600 }) ?? 15) * 1000;
  const minutes = int(opts, 'timeout-minutes', { min: 1, max: 10_080 });
  const deadline = minutes ? Date.now() + minutes * 60_000 : Infinity;
  for (;;) {
    const summary = statusSummary(runDir);
    if (summary.settled) return summary;
    if (Date.now() >= deadline) throw new CliError('WAIT_TIMEOUT', 'The run is still active.', `Wait again with: ${C} wait ${summary.ref}`, prune(summary));
    await sleep(Math.min(interval, deadline - Date.now()));
  }
}

async function stopRun(runDir: string) {
  const status = compactStatus(runDir), ref = shortRef(status.runId);
  if (status.workerExited) throw new CliError('RUN_NOT_ACTIVE', 'The worker has already exited.');
  if (!status.runnerAlive) throw new CliError('CONTROL_UNAVAILABLE', 'The runner is gone, so the worker cannot be stopped through it; its state is unconfirmed.', 'Inspect the worker process directly; do not launch a duplicate.');
  let url: URL;
  try { url = new URL(status.url); } catch { throw new CliError('CONTROL_UNAVAILABLE', 'The run has no saved control URL.'); }
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !/^\/[a-f0-9]{48}\/$/.test(url.pathname)) throw new CliError('CONTROL_UNAVAILABLE', 'Invalid saved control URL.');
  const result: any = await labelledAsync('CONTROL_UNAVAILABLE', async () => {
    const response = await fetch(new URL('stop', url), { method: 'POST', signal: AbortSignal.timeout(20_000) });
    const body: any = await response.json();
    if (!response.ok) throw new Error(body.error ?? 'Stop request failed.');
    return body;
  });
  return { ref, message: result.message };
}

async function report(runDir: string, opts: Opts) {
  const file = path.join(runDir, 'worker-report.md');
  let text: string;
  try { text = fs.readFileSync(file, 'utf8').replace(/^﻿/, ''); }
  catch {
    const s = statusSummary(runDir);
    throw new CliError('REPORT_MISSING', s.settled ? 'The run ended without a worker report.' : 'The run has no report yet.',
      s.settled ? `Inspect it with: ${C} status ${s.ref}` : `Wait for it: ${C} wait ${s.ref}`, { status: s.status });
  }
  const max = int(opts, 'max-chars') ?? 0;
  return max && text.length > max ? `${text.slice(0, max)}\n\n[truncated at ${max} of ${text.length} characters; --max-chars 0 prints all]` : text;
}

// IDLE commands other than watch/record-night belong to the installed zc.mjs adapter and are passed through untouched.
function idlePassthrough(sub: string, rest: string[]) {
  const adapter = defaultPaths().adapter;
  if (!fs.existsSync(adapter)) throw new CliError('WORKER_UNAVAILABLE', 'The ZCode IDLE adapter (zc.mjs) is missing.', adapter);
  const args = sub === 'doctor' ? [adapter, 'doctor', ...rest] : [adapter, 'idle', sub, ...rest];
  const result = spawnSync(nodeExecutable(), args, { stdio: 'inherit', windowsHide: true });
  if (result.error) throw new CliError('WORKER_UNAVAILABLE', result.error.message);
  process.exitCode = result.status ?? 1;
}

const harness = (error: any) => error instanceof HarnessError
  ? new CliError(({ USAGE: 'USAGE', INVALID_ARG: 'USAGE', LOCK_HELD: 'LOCK_HELD', NIGHT_TAKEN: 'LOCK_HELD' } as const)[error.code as string] ?? 'INTERNAL', error.message)
  : error;

const IDLE_SUBS = 'watch|record-night|doctor|models|list|availability|submit|status|ticket';

export const COMMANDS: Record<string, Command> = {
  guide: { usage: 'guide [zcode|agy|codex|claude|mcode|idle|monitor|desktop|errors] [--orchestrator claude|codex|generic]', summary: 'Print the operating guide (read once per task).',
    values: ['orchestrator'], args: [0, 1],
    run: (o, a) => ({ text: guideText(a[0], oneOf(o, 'orchestrator', ORCHESTRATORS)) }) },
  template: { usage: `template ${TEMPLATES.join('|')}`, summary: 'Print a brief template.', args: [1, 1],
    run: (_o, a) => ({ text: templateText(a[0]) }) },
  check: { usage: `check ${LAUNCH_USAGE}`, summary: 'Validate a launch; starts nothing.', values: LAUNCH_VALUES, aliases: LAUNCH_ALIASES,
    run: async o => ({ data: await check(launchInput(o)) }) },
  launch: { usage: `launch ${LAUNCH_USAGE}`, summary: 'Start one worker run and return its receipt.', values: LAUNCH_VALUES, aliases: LAUNCH_ALIASES,
    run: async o => { const receipt = await launch(launchInput(o)); return { data: receipt, next: launchNext(receipt) }; } },
  status: { usage: 'status <ref> [--full] [--project DIR]', summary: 'Compact run status (--full: complete record).', flags: ['full'], values: ['project', 'ref'], aliases: REF_ALIASES, args: [0, 1],
    run: (o, a) => {
      const runDir = refOf(o, a), summary = statusSummary(runDir);
      return { data: o.full ? { ref: summary.ref, ...compactStatus(runDir) } : summary, next: nextFor(summary) };
    } },
  wait: { usage: 'wait <ref> [--interval-seconds N] [--timeout-minutes N]', summary: 'Block until the run settles; no model calls.',
    values: ['project', 'ref', 'interval-seconds', 'timeout-minutes'], aliases: REF_ALIASES, args: [0, 1],
    run: async (o, a) => { const summary = await waitFor(refOf(o, a), o); return { data: summary, next: nextFor(summary) }; } },
  report: { usage: 'report <ref> [--max-chars N]', summary: 'Print the worker report (raw text).', values: ['project', 'ref', 'max-chars'], aliases: REF_ALIASES, args: [0, 1],
    run: async (o, a) => ({ text: await report(refOf(o, a), o) }) },
  runs: { usage: 'runs [--project DIR] [--active] [--limit N] [--all]', summary: 'List recent runs (this project, or --all known runs).', values: ['project', 'limit'], flags: ['active', 'all'],
    run: o => {
      const listed = listRuns({ project: str(o, 'project'), active: !!o.active, all: !!o.all, limit: int(o, 'limit', { min: 1, max: 1000 }) ?? 10 });
      const iso = (ms: number | null) => ms ? new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z') : null;
      return { data: { scope: listed.scope, total: listed.total, runs: listed.runs.map(r => ({ ref: r.ref, worker: r.worker, stage: r.stage, status: r.status,
        active: r.active, startedAt: iso(r.startedAt), ...(listed.scope === 'all' ? { project: r.project } : {}) })) } };
    } },
  stop: { usage: 'stop <ref>', summary: "Stop the run's worker through its runner.", values: ['project', 'ref'], aliases: REF_ALIASES, args: [0, 1],
    run: async (o, a) => ({ data: await stopRun(refOf(o, a)) }) },
  resume: { usage: 'resume <ref> --brief FILE', summary: 'Continue the exact worker session in a new run.', values: ['project', 'ref', 'brief'], aliases: { ...REF_ALIASES, 'prompt-file': 'brief' }, args: [0, 1],
    run: async (o, a) => {
      const brief = str(o, 'brief');
      if (!brief) throw new CliError('USAGE', '--brief FILE is required.');
      const receipt = await resume(refOf(o, a), brief);
      return { data: receipt, next: launchNext(receipt) };
    } },
  inspect: { usage: 'inspect [--project DIR] [--task-index FILE]', summary: 'Read-only ownership snapshot (locks, desktop/IDLE tasks).', values: ['project', 'task-index'],
    run: o => ({ data: labelled('IO_ERROR', () => inspectProject(str(o, 'project') ?? process.cwd(), str(o, 'task-index') ? { taskIndex: str(o, 'task-index') } : {})) }) },
  export: { usage: 'export <ref> [--out FILE.zip]', summary: 'Write the session log ZIP.', values: ['project', 'ref', 'out'], aliases: REF_ALIASES, args: [0, 1],
    run: async (o, a) => {
      const runDir = refOf(o, a);
      let trajectory = null; try { trajectory = publicRun(readRun({ key: null, runDir }, { observeInactive: true })); } catch {}
      return { data: await labelledAsync('IO_ERROR', () => exportRunToFile(runDir, str(o, 'out') ? path.resolve(str(o, 'out')!) : null, { trajectory })) };
    } },
  desktop: { usage: 'desktop <ref>', summary: 'ZCode or MiniMax desktop handoff for a finished run.', values: ['project', 'ref'], aliases: REF_ALIASES, args: [0, 1],
    run: async (o, a) => {
      const runDir = refOf(o, a), status = compactStatus(runDir);
      if (status.workerKind === 'mcode') {
        if (!status.workerExited) throw new CliError('RUN_ACTIVE', 'Wait for the MiniMax desktop turn to finish.', `${C} wait ${shortRef(status.runId)}`);
        const config = readJson(path.join(runDir, 'config.json'));
        const runtime = await labelledAsync('WORKER_UNAVAILABLE', () => probeMcode(config));
        const value = await runtime.client.request(`${MCODE_API}/session/${status.sessionId}`);
        labelled('INVALID_CONFIG', () => verifyMcodeSession(config, value.session, status.sessionId));
        return { data: { sessionId: status.sessionId, workspace: config.project, title: value.session.title,
          executable: config.mcodeExe, instructions: 'This is already a visible MiniMax Code desktop session. Open the app and select this title/session. Continue from only one client at a time.' } };
      }
      if (status.workerKind !== 'zcode') throw new CliError('USAGE', 'Desktop handoff is available for ZCode runs only.');
      if (!status.workerExited) throw new CliError('RUN_ACTIVE', 'Wait for the worker to exit before continuing in ZCode.', `${C} wait ${shortRef(status.runId)}`);
      return { data: labelled('INVALID_CONFIG', () => desktopHandoff(readJson(path.join(runDir, 'config.json')), status)) };
    } },
  dashboard: { usage: 'dashboard [ref]', summary: 'Open (start if needed) the shared dashboard; prints its URL.', values: ['project', 'ref'], aliases: REF_ALIASES, args: [0, 1],
    run: async (o, a) => {
      const runDir = a[0] || str(o, 'ref') ? refOf(o, a) : null;
      const key = runDir ? registerRun(runDir) : null;
      const hub = await labelledAsync('HUB_UNAVAILABLE', () => ensureDashboard());
      return { data: { url: hub.url + (key ? '#run=' + key : ''), ...(runDir ? { ref: shortRef(path.basename(runDir)) } : {}) } };
    } },
  models: { usage: 'models [--worker zcode|agy|codex|claude|mcode]', summary: 'Available or selected models for a worker.', values: ['worker'],
    run: async o => ({ data: await models(oneOf(o, 'worker', WORKERS) ?? 'zcode') }) },
  doctor: { usage: 'doctor', summary: 'Check runtimes, workers, hub, installed skills and the current lock.',
    run: async () => ({ data: await doctor() }) },
  mcode: { usage: 'mcode setup|status [--exe FILE] [--manifest FILE]', summary: 'Connect the installed MiniMax Code desktop bridge; never installs the standalone CLI.', values: ['exe', 'manifest'], args: [1, 1],
    run: async (o, a) => {
      const paths = mcodePaths({ ...(str(o, 'exe') ? { mcodeExe: str(o, 'exe') } : {}), ...(str(o, 'manifest') ? { mcodeManifest: str(o, 'manifest') } : {}) });
      if (a[0] === 'setup') return { data: await labelledAsync('WORKER_UNAVAILABLE', () => setupMcode(paths)) };
      if (a[0] === 'status') {
        const runtime = await labelledAsync('WORKER_UNAVAILABLE', () => probeMcode(paths));
        return { data: { worker: 'mcode', backend: 'desktop', version: runtime.bridge.version, pid: runtime.bridge.pid, connected: true, modelSource: runtime.source, manifest: paths.mcodeManifest } };
      }
      throw usageError(`Unknown mcode action "${a[0]}".`, COMMANDS.mcode);
    } },
  idle: { usage: `idle ${IDLE_SUBS} ...`, summary: 'Explicit IDLE queue tasks (see guide idle).', args: [0, Infinity],
    run: () => {} },
  hub: { usage: 'hub status|restart', summary: 'Shared dashboard process (restart refuses while runs are active).', args: [1, 1],
    run: async (_o, a) => {
      if (a[0] === 'status') return { data: await hubStatus() };
      if (a[0] === 'restart') return { data: await hubRestart() };
      throw usageError(`Unknown hub action "${a[0]}".`, COMMANDS.hub);
    } },
  skills: { usage: 'skills install [--target claude|codex|all] [--worker zcode|agy|codex|claude|mcode] [--dry-run] [--include-missing] [--force]', summary: 'Replace installed delegate skills with thin CLI pointers (old copies are moved to skill-backups).',
    values: ['target', 'worker'], flags: ['dry-run', 'include-missing', 'force'], args: [1, 1],
    run: (o, a) => {
      if (a[0] !== 'install') throw usageError(`Unknown skills action "${a[0]}".`, COMMANDS.skills);
      return { data: installSkills({ target: oneOf(o, 'target', ['claude', 'codex', 'all'] as const) ?? 'all', worker: oneOf(o, 'worker', WORKERS), dryRun: !!o['dry-run'], includeMissing: !!o['include-missing'], force: !!o.force }) };
    } },
  version: { usage: 'version', summary: 'CLI and protocol version.', run: () => ({ data: { version: VERSION, protocol: PROTOCOL_VERSION } }) },
  review: { usage: 'review <ref> --verdict accepted|changes_required --report-file FILE', summary: 'Legacy optional review note.', hidden: true,
    values: ['project', 'ref', 'verdict', 'report-file'], aliases: REF_ALIASES, args: [0, 1],
    run: (o, a) => ({ data: markReview(refOf(o, a), str(o, 'verdict') ?? '', path.resolve(str(o, 'report-file') ?? '')) }) },
  supervise: { usage: 'supervise --config FILE', summary: 'Internal: own one worker process.', hidden: true, values: ['config'],
    run: async o => {
      const state = await supervise(validateConfig(readJson(path.resolve(str(o, 'config') ?? ''))));
      process.exitCode = ['ready_for_review', 'complete'].includes(state.status) ? 0 : 1;
    } },
};

async function runIdle(argv: string[], pretty: boolean) {
  const [sub, ...rest] = argv;
  if (!sub || sub === '--help' || sub === '-h') return writeText(`Usage: ${C} ${COMMANDS.idle.usage}\nwatch --job ID [--thread UUID] --state-dir DIR --deadline ISO8601\nrecord-night --state-dir DIR --night YYYY-MM-DD\nOther subcommands pass through to the installed zc.mjs adapter. Read: ${C} guide idle`);
  if (sub === 'watch') {
    const spec: CommandSpec = { usage: 'idle watch --job ID [--thread UUID] --state-dir DIR --deadline ISO8601', summary: '', values: ['job', 'thread', 'state-dir', 'deadline'] };
    const { opts } = parseArgs(rest, spec);
    const thread = str(opts, 'thread') ?? process.env.CODEX_THREAD_ID;
    for (const name of ['job', 'state-dir', 'deadline']) if (!str(opts, name)) throw usageError(`--${name} is required.`, spec);
    if (!thread) throw usageError('--thread is required outside a Codex task.', spec);
    try {
      validateId('job', str(opts, 'job')); validateId('thread', thread); validateIsoDeadline(str(opts, 'deadline'));
      const { outcome, state } = await runWatch({ job: str(opts, 'job'), thread, stateDir: path.resolve(str(opts, 'state-dir')!), deadline: str(opts, 'deadline'),
        deps: { log: (m: string) => console.error(`[watch] ${m}`), onLock: (lock: any) => installSignalCleanup(lock, (m: string) => console.error(`[watch] ${m}`)) } });
      const data = { outcome, status: state.status, probes: state.probeCount, callbackAttempts: state.callback.attempts.length, callbackSucceeded: state.callback.succeeded };
      if (!state.callback.succeeded) throw new CliError('CALLBACK_FAILED', 'The watch ended without a successful callback.', 'Rerun the same watch command to retry the callback.', data);
      return writeOk('idle watch', data, undefined, { pretty });
    } catch (error) { throw harness(error); }
  }
  if (sub === 'record-night') {
    const spec: CommandSpec = { usage: 'idle record-night --state-dir DIR --night YYYY-MM-DD', summary: '', values: ['state-dir', 'night'] };
    const { opts } = parseArgs(rest, spec);
    if (!str(opts, 'state-dir') || !str(opts, 'night')) throw usageError('--state-dir and --night are required.', spec);
    try { return writeOk('idle record-night', recordNight({ stateDir: path.resolve(str(opts, 'state-dir')!), night: validateNight(str(opts, 'night')) }), undefined, { pretty }); }
    catch (error) { throw harness(error); }
  }
  return idlePassthrough(sub, rest.filter(arg => arg !== '--pretty'));
}

function helpText() {
  const visible = Object.entries(COMMANDS).filter(([, c]) => !c.hidden);
  return [`${C} ${VERSION} (protocol v${PROTOCOL_VERSION}): delegate discovery and execution runs to ZCode, AGY, Codex or Claude Code workers.`,
    `Agents: start with "${C} guide <worker>". Output: one JSON line {v,ok,cmd,data|error,next?}; guide/template/report print raw text.`,
    'Refs: 8-hex run suffix, run ID, "last", or a run directory. --pretty indents JSON.', '',
    ...visible.map(([, c]) => `  ${c.usage.split(' ')[0].padEnd(10)}${c.summary}`), '',
    `"${C} <command> --help" shows its options.`].join('\n');
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  const pretty = argv.includes('--pretty');
  const [name, ...rest] = argv;
  let cmd: string | null = null;
  try {
    if (!name || name === '--help' || name === '-h' || name === 'help') return writeText(helpText());
    if (name === '--version' || name === '-v') return writeOk('version', { version: VERSION, protocol: PROTOCOL_VERSION }, undefined, { pretty });
    const command = Object.hasOwn(COMMANDS, name) ? COMMANDS[name] : undefined;
    if (!command) throw new CliError('UNKNOWN_COMMAND', `Unknown command "${name}".`, `Run ${C} --help`);
    cmd = name;
    if (name === 'idle') { cmd = rest[0] && !rest[0].startsWith('-') ? `idle ${rest[0]}` : 'idle'; return await runIdle(rest, pretty); }
    if (name === 'hub' && rest[0] === 'serve') {
      // Internal: the detached shared dashboard process started by ensureDashboard.
      const { opts } = parseArgs(rest.slice(1), { usage: 'hub serve [--root DIR]', summary: '', values: ['root'] });
      await serveHub(path.resolve(str(opts, 'root') ?? defaultRoot()));
      return;
    }
    const { opts, args } = parseArgs(rest, command);
    if (opts.help) return writeText(`Usage: ${C} ${command.usage}\n${command.summary}`);
    if (name === 'hub' || name === 'skills') cmd = `${name} ${args[0]}`;
    const result = await command.run(opts, args);
    if (!result) return;
    if ('text' in result) return writeText(result.text);
    writeOk(cmd, prune(result.data), result.next, { pretty });
  } catch (error) {
    const failure = toCliError(error);
    writeError(cmd, failure, { pretty });
    process.exitCode = failure.exitCode;
  }
}

if (import.meta.main) await main();
