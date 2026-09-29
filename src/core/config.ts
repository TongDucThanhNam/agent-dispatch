import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { contained } from './fsutil.ts';
import { RECORD_DIR, home } from './paths.ts';
import { CliError } from '../protocol/errors.ts';
import { clean } from '../monitor/monitor-core.ts';
import { nativePaths, nativeSelection } from '../workers/zcode/native.ts';
import { CLAUDE_EFFORTS } from '../workers/claude/adapter.ts';

export type WorkerKind = 'zcode' | 'agy' | 'codex' | 'claude';
export const WORKERS: WorkerKind[] = ['zcode', 'agy', 'codex', 'claude'];
export const LABELS: Record<WorkerKind, string> = { zcode: 'ZCode', agy: 'AGY', codex: 'Codex', claude: 'Claude Code' };
export const workerLabel = (config: { workerKind?: string }) => LABELS[config.workerKind as WorkerKind] ?? 'ZCode';

export const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
export const validSession = (config: { workerKind?: string }, id: unknown) =>
  config.workerKind === 'agy' || config.workerKind === 'codex' || config.workerKind === 'claude' ? UUID.test(String(id ?? '')) : /^sess_[A-Za-z0-9_-]+$/.test(String(id ?? ''));

/** Short, stable handle for a run: the random suffix of generated run IDs, otherwise the run ID itself. */
export const shortRef = (runId: string) => /^run-\d+-([0-9a-f]{8})$/.exec(runId)?.[1] ?? runId;

export function driftOf(raw: any) {
  if (!raw || typeof raw !== 'object') return null;
  return { available: raw.available === true, clean: typeof raw.clean === 'boolean' ? raw.clean : null,
    headChanged: raw.headChanged === true, changedCount: Number.isInteger(raw.changedCount) ? raw.changedCount : 0,
    changed: Array.isArray(raw.changed) ? raw.changed.filter(x => typeof x === 'string').slice(0, 50).map(x => x.slice(0, 300)) : [],
    ...(raw.reason ? { reason: clean(String(raw.reason), 200) } : {}) };
}

/** Default install locations of the worker executables and shared ZCode state. */
export const defaultPaths = () => ({
  adapter: home('AppData/Local/Programs/ZCodeCLI/zc.mjs'),
  codexExe: home('AppData/Local/Programs/OpenAI/Codex/bin/codex.exe'),
  agyExe: home('AppData/Local/agy/bin/agy.exe'),
  claudeExe: (typeof Bun !== 'undefined' ? Bun.which('claude') : null) ?? home('.local', 'bin', process.platform === 'win32' ? 'claude.exe' : 'claude'),
  claudeHome: process.env.CLAUDE_CONFIG_DIR ?? home('.claude'),
  codexHome: process.env.CODEX_HOME ?? home('.codex'),
  cliConfig: home('.zcode/cli/config.json'),
  dbPath: home('.zcode/cli/db/db.sqlite'),
});

const invalid = (message: string, hint?: string) => new CliError('INVALID_CONFIG', message, hint);

/**
 * Validates a raw run configuration and fills every default. The saved
 * config.json keeps the historical field names so older monitors can read it.
 */
export function validateConfig(raw: any): any {
  if (!raw || typeof raw !== 'object') throw invalid('A run configuration object is required.');
  const workerKind = raw.workerKind ?? 'zcode';
  if (!WORKERS.includes(workerKind)) throw invalid('Invalid worker kind.', 'Use --worker zcode, agy, codex or claude.');
  let project: string;
  try { project = fs.realpathSync(path.resolve(raw.project ?? '.')); }
  catch { throw invalid('The project directory does not exist.', 'Pass an existing directory with --project.'); }
  const runId = raw.runId ?? `run-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,100}$/.test(runId)) throw invalid('Invalid run ID.');
  const runDir = path.resolve(raw.runDir ?? path.join(project, RECORD_DIR, runId));
  if (!contained(project, runDir) || runDir === project) throw invalid('Run directory must be inside the project, in its own directory.');
  if (raw.notify !== false && !UUID.test(raw.threadId ?? ''))
    throw invalid('Use the originating Codex task UUID for threadId.', 'Pass --notify none when no Codex task should be called back (for example under Claude Code), or --thread <Codex task UUID>.');
  if (raw.resumeSessionId && !validSession({ workerKind }, raw.resumeSessionId))
    throw invalid(`Invalid ${{ agy: 'AGY conversation', codex: 'Codex thread', claude: 'Claude session' }[workerKind] ?? 'ZCode session'} ID.`);
  const bounded = (name: string, fallback: number, min: number, max: number) => {
    const value = raw[name] ?? fallback;
    if (!Number.isInteger(value) || value < min || value > max) throw invalid(`Invalid ${name}.`);
    return value;
  };
  let selection: any = {};
  if (workerKind === 'zcode') {
    try { selection = { ...nativePaths(raw), ...nativeSelection(raw) }; }
    catch (error) { throw invalid(error.message, 'List qualified IDs with: agent-dispatch models --worker zcode'); }
  }
  const defaults = defaultPaths();
  const config: any = { schemaVersion: 1, workerKind, project, runId, runDir,
    promptFile: path.resolve(raw.promptFile ?? path.join(runDir, 'assignment.md')),
    threadId: raw.threadId ?? null, notify: raw.notify !== false, callbackModel: raw.callbackModel ?? null,
    expectedModel: workerKind === 'agy' ? raw.agyModel ?? raw.model ?? raw.expectedModel ?? 'pending-selection'
      : workerKind === 'codex' ? raw.codexModel ?? raw.model ?? raw.expectedModel ?? 'pending-selection'
      : workerKind === 'claude' ? raw.claudeResolvedModel ?? raw.claudeModel ?? raw.model ?? raw.expectedModel ?? 'pending-selection' : raw.expectedModel ?? 'GLM-5.3-Flash',
    expectedProvider: workerKind === 'agy' ? 'agy' : workerKind === 'codex' ? raw.codexProvider ?? raw.provider ?? raw.expectedProvider ?? 'pending-selection'
      : workerKind === 'claude' ? 'claude' : raw.expectedProvider ?? 'account:zai-individual-coding-plan',
    ...selection,
    adapter: path.resolve(raw.adapter ?? defaults.adapter),
    codexExe: path.resolve(raw.codexExe ?? defaults.codexExe),
    cliConfig: path.resolve(raw.cliConfig ?? defaults.cliConfig),
    dbPath: workerKind === 'agy' ? path.join(runDir, 'agy-events.sqlite') : workerKind === 'codex' ? path.join(runDir, 'codex-events.sqlite')
      : workerKind === 'claude' ? path.join(runDir, 'claude-events.sqlite')
      : path.resolve(raw.dbPath ?? defaults.dbPath),
    ...(raw.nodeExe ? { nodeExe: path.resolve(raw.nodeExe) } : {}),
    ...(workerKind === 'agy' ? { agyExe: path.resolve(raw.agyExe ?? defaults.agyExe),
      agyModel: raw.agyModel ?? raw.model ?? (raw.expectedModel !== 'pending-selection' ? raw.expectedModel : null) ?? null,
      agyEffort: raw.agyEffort ?? raw.effort ?? null, agyAgent: raw.agyAgent ?? raw.agent ?? null, agyPrintTimeout: raw.agyPrintTimeout ?? raw.printTimeout ?? '0' } : {}),
    ...(workerKind === 'codex' ? { codexHome: path.resolve(raw.codexHome ?? defaults.codexHome),
      codexModel: raw.codexModel ?? raw.model ?? (raw.expectedModel !== 'pending-selection' ? raw.expectedModel : null) ?? null,
      codexEffort: raw.codexEffort ?? raw.effort ?? null,
      codexProvider: raw.codexProvider ?? raw.provider ?? (raw.expectedProvider !== 'pending-selection' ? raw.expectedProvider : null) ?? null } : {}),
    ...(workerKind === 'claude' ? { claudeExe: path.resolve(raw.claudeExe ?? defaults.claudeExe), claudeHome: path.resolve(raw.claudeHome ?? defaults.claudeHome),
      claudeModel: raw.claudeModel ?? raw.model ?? null, claudeResolvedModel: raw.claudeResolvedModel ?? null,
      claudeEffort: raw.claudeEffort ?? raw.effort ?? null } : {}),
    resumeSessionId: raw.resumeSessionId ?? null, mode: raw.mode ?? 'yolo',
    stage: raw.stage ?? 'execution', discoveryRunDir: raw.discoveryRunDir ? path.resolve(raw.discoveryRunDir) : null, discoveryDrift: driftOf(raw.discoveryDrift),
    pollMs: bounded('pollMs', 5000, 100, 60_000), quietMs: bounded('quietMs', 180_000, 100, 86_400_000),
    stallMs: bounded('stallMs', 600_000, 200, 86_400_000), maxRetries: bounded('maxRetries', 3, 1, 20),
    keepOpenMs: bounded('keepOpenMs', 0, 0, 86_400_000), demo: raw.demo === true };
  if (config.stallMs <= config.quietMs) throw invalid('stallMs must exceed quietMs.');
  if (!['yolo', 'build', 'edit', 'plan'].includes(config.mode)) throw invalid('Invalid ZCode permission mode.', 'Use --mode yolo or plan.');
  if (!['discovery', 'execution'].includes(config.stage)) throw invalid('Stage must be discovery or execution.');
  if (config.discoveryRunDir) {
    if (config.stage !== 'execution') throw invalid('--from starts an execution stage.');
    const records = path.join(project, RECORD_DIR);
    if (!contained(records, config.discoveryRunDir) || config.discoveryRunDir === records) throw new CliError('DISCOVERY_INVALID', 'The discovery run must belong to the same project.');
  }
  if (workerKind === 'agy') {
    if (!['yolo', 'plan'].includes(config.mode)) throw invalid('AGY supports yolo or plan in this launcher.');
    if (config.agyEffort && !['low', 'medium', 'high'].includes(config.agyEffort)) throw invalid('Invalid AGY effort.', 'Use low, medium or high.');
    if (config.agyAgent != null && (typeof config.agyAgent !== 'string' || !config.agyAgent.trim() || config.agyAgent.length > 100)) throw invalid('Invalid AGY agent.');
    if (typeof config.agyPrintTimeout !== 'string' || !/^(?:0|[1-9][0-9]{0,5}(?:s|m|h))$/.test(config.agyPrintTimeout))
      throw invalid('Use 0 to wait until completion, or an AGY print timeout such as 1h.');
  }
  if (workerKind === 'codex') {
    if (!['yolo', 'plan'].includes(config.mode)) throw invalid('Codex supports yolo or plan in this launcher.');
    if (config.codexEffort && !['none', 'minimal', 'low', 'medium', 'high', 'xhigh'].includes(config.codexEffort))
      throw invalid('Invalid Codex effort.', 'Use none, minimal, low, medium, high or xhigh.');
    if (config.codexModel != null && !/^[A-Za-z0-9][A-Za-z0-9._/-]{0,100}$/.test(config.codexModel)) throw invalid('Invalid Codex model.');
    if (config.codexProvider != null && !/^[A-Za-z0-9][A-Za-z0-9._-]{0,60}$/.test(config.codexProvider)) throw invalid('Invalid Codex provider.');
  }
  if (workerKind === 'claude') {
    if (!['yolo', 'plan'].includes(config.mode)) throw invalid('Claude supports yolo or plan in this launcher.');
    if (config.claudeEffort && !CLAUDE_EFFORTS.includes(config.claudeEffort)) throw invalid('Invalid Claude effort.', 'Use low, medium, high, xhigh or max (model-dependent).');
    for (const field of ['claudeModel', 'claudeResolvedModel', 'expectedModel'])
      if (config[field] != null && !/^[A-Za-z0-9][A-Za-z0-9:._/-]{0,199}(?:\[1m\])?$/.test(config[field])) throw invalid('Invalid Claude model.');
    if (config.claudeModel?.replace(/\[1m\]$/, '') === 'opusplan') throw invalid('Claude opusplan switches models; use a single model for a pinned dispatch run.');
    if (raw.provider != null && raw.provider !== 'claude') throw invalid('Claude provider routing comes from its own settings and environment.', 'Configure Claude Code normally; do not pass --provider.');
    if (process.platform === 'win32' && /\.(?:cmd|bat|ps1)$/i.test(config.claudeExe)) throw invalid('Use the native claude.exe, not a shell wrapper.');
  }
  for (const field of ['callbackModel', 'expectedModel', 'expectedProvider']) {
    if (workerKind === 'claude' && field === 'expectedModel') continue;
    if (config[field] !== null && !/^[A-Za-z0-9][A-Za-z0-9:._/-]{0,100}$/.test(config[field])) throw invalid(`Invalid ${field}.`);
  }
  return config;
}

export const configuredEffort = (config: any) => config?.zcodeEffort ?? config?.agyEffort ?? config?.codexEffort ?? config?.claudeEffort ?? null;
