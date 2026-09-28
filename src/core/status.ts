import fs from 'node:fs';
import path from 'node:path';
import { readJson, saveJson, isAlive } from './fsutil.ts';
import { shortRef, configuredEffort } from './config.ts';
import { isStale } from './supervisor.ts';
import { CliError } from '../protocol/errors.ts';

const readState = (runDir: string) => {
  try { return readJson(path.join(runDir, 'status.json')); }
  catch { throw new CliError('RUN_NOT_FOUND', 'The run has no readable status yet.', 'If it was just launched, check again shortly; do not launch a duplicate.', { runDir }); }
};

/** Full status record (the historical `status --run-dir` shape). */
export function compactStatus(runDir: string) {
  const state = readState(runDir);
  let config: any; try { config = readJson(path.join(runDir, 'config.json')); } catch {}
  let review: any; try { review = readJson(path.join(runDir, 'review.json')); } catch {}
  return { runId: state.runId, workerKind: state.workerKind ?? 'zcode', stage: config?.stage ?? 'execution',
    status: review ? review.verdict === 'accepted' ? 'complete' : 'changes_required' : state.status,
    phase: state.phase, updatedAt: state.updatedAt, runnerAlive: isAlive(state.runnerPid), workerPid: state.workerPid,
    workerExited: state.workerExited, exitCode: state.exitCode, sessionId: state.sessionId, lastActivityAt: state.lastActivityAt,
    selection: { provider: config?.expectedProvider ?? null, model: config?.expectedModel ?? state.expectedModel ?? null, effort: configuredEffort(config) },
    observed: { provider: state.provider ?? null, model: state.model ?? null },
    error: state.error, alert: state.alert, usage: state.usage, notifications: state.notifications,
    ...(config?.stage === 'discovery' ? { worktreeGuard: state.worktreeGuard ?? null } : {}),
    ...(config?.discoveryRunDir ? { fromDiscovery: config.discoveryRunDir, discoveryDrift: config.discoveryDrift ?? null } : {}),
    reportPath: state.reportPath ?? null, url: state.url ?? null };
}

/**
 * The run is over from the orchestrator's point of view: finished, failed, or
 * no longer supervised. A dead runner never updates the record again, so a run
 * whose runner is gone is settled even if the worker's own fate is unconfirmed.
 */
export const isSettled = (s: { phase?: string; status?: string; runnerAlive?: boolean }) =>
  s.phase === 'finished' || s.status === 'worker_failed' || !s.runnerAlive;

const iso = (ms: unknown) => typeof ms === 'number' && Number.isFinite(ms) ? new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z') : null;
/** `provider/model` as accepted by --model; AGY models are unqualified. */
export const qualified = (provider: string | null, model: string | null) => model ? provider && provider !== 'agy' ? `${provider}/${model}` : model : null;

/**
 * Protocol v1 status summary: small, flat and stable. Null fields are pruned
 * by the output layer. `settled` tells a waiting agent to stop waiting.
 */
export function statusSummary(runDir: string) {
  const full = compactStatus(runDir);
  let config: any = {}; try { config = readJson(path.join(runDir, 'config.json')); } catch {}
  const state = readState(runDir);
  const stale = isStale(config, state);
  const selected = qualified(full.selection.provider, full.selection.model);
  const observed = qualified(full.observed.provider, full.observed.model);
  const report = full.reportPath ?? (fs.existsSync(path.join(runDir, 'worker-report.md')) ? path.join(runDir, 'worker-report.md') : null);
  return {
    ref: shortRef(full.runId), runId: full.runId, worker: full.workerKind, stage: full.stage,
    status: stale ? 'unconfirmed' : full.status, phase: stale ? 'monitor_offline' : full.phase, settled: isSettled(full),
    runnerAlive: full.runnerAlive, workerExited: full.workerExited, exitCode: full.exitCode,
    model: selected, effort: full.selection.effort, observedModel: observed && observed !== selected ? observed : null,
    sessionId: full.sessionId, startedAt: iso(state.startedAt), endedAt: iso(state.endedAt), lastActivityAt: iso(full.lastActivityAt),
    error: full.error ? { kind: full.error.kind ?? null, message: full.error.message ?? null } : null,
    alert: stale ? { kind: 'monitor_unavailable', message: 'The runner is gone or stale; worker state is unconfirmed. Inspect before launching anything.' }
      : full.alert ? { kind: full.alert.kind ?? null, message: full.alert.message ?? null } : null,
    worktreeGuard: full.stage === 'discovery' ? capChanged((full as any).worktreeGuard) : null,
    fromDiscovery: (full as any).fromDiscovery ? shortRef(path.basename((full as any).fromDiscovery)) : null,
    discoveryDrift: capChanged((full as any).discoveryDrift),
    notify: config.notify === false ? 'none' : config.notify ? 'codex' : null, notified: summarizeNotifications(full.notifications),
    report, runDir: path.resolve(runDir), url: full.url,
  };
}

/** Compact views list at most 10 changed paths; `changedCount` keeps the total and --full keeps the list. */
export function capChanged(diff: any, limit = 10) {
  if (!diff || !Array.isArray(diff.changed) || diff.changed.length <= limit) return diff ?? null;
  return { ...diff, changed: diff.changed.slice(0, limit) };
}

function summarizeNotifications(notifications: any) {
  const records = Object.values(notifications ?? {}) as any[];
  if (!records.length) return null;
  const last = records.sort((a, b) => (b.attemptedAt ?? 0) - (a.attemptedAt ?? 0))[0];
  return `${last.kind}:${last.state}`;
}

export function markReview(runDir: string, verdict: string, reportFile: string) {
  if (!['accepted', 'changes_required'].includes(verdict)) throw new CliError('USAGE', 'Review verdict must be accepted or changes_required.');
  const state = readState(runDir);
  if (!state.workerExited) throw new CliError('RUN_ACTIVE', 'Review cannot mark an active or uncertain worker complete.');
  if (verdict === 'accepted' && state.status !== 'ready_for_review') throw new CliError('INVALID_CONFIG', 'A failed, blocked, or missing-report run cannot be marked accepted.');
  const report = fs.readFileSync(reportFile, 'utf8');
  if (!report.trim() || report.length > 32_000) throw new CliError('INVALID_CONFIG', 'Provide a concise, nonempty review report.');
  fs.writeFileSync(path.join(runDir, 'review.md'), report);
  saveJson(path.join(runDir, 'review.json'), { verdict, reviewedAt: Date.now(), runId: state.runId });
  return compactStatus(runDir);
}
