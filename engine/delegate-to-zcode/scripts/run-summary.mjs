// Shared, telemetry-free state interpretation for Node monitors and the Bun CLI.
import fs from 'node:fs';
import path from 'node:path';
const terminal = new Set(['blocked', 'cancelled', 'worker_failed', 'missing_report', 'ready_for_review', 'complete', 'changes_required', 'needs_replan', 'awaiting_judgment', 'rolled_back']);
export const isAlive = pid => {
  if (!Number.isInteger(pid) || pid < 1) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
};
export function runState(config, state, review, {now = Date.now(), alive = isAlive} = {}) {
  const runnerAlive = alive(state.runnerPid), workerAlive = alive(state.workerPid);
  const scriptAstra = (config.reviewMode ?? state.reviewMode) === 'script-astra';
  const loopActive = state.loopActive === true;
  const finished = loopActive ? terminal.has(state.status) : state.workerExited === true && terminal.has(state.status);
  const fresh = now - state.updatedAt <= Math.max(60_000, (config.pollMs ?? 5000) * 3);
  const active = !finished && (loopActive ? runnerAlive || fresh : !state.workerExited && (workerAlive || runnerAlive) && !terminal.has(state.status));
  const stale = active && (!runnerAlive || !fresh);
  const status = stale ? 'unconfirmed' : scriptAstra || loopActive ? state.status
    : review ? review.verdict === 'accepted' ? 'complete' : 'changes_required'
    : !active && !state.workerExited ? 'monitor_offline' : state.status;
  return {runnerAlive, scriptAstra, loopActive, active, stale, status};
}
export function readSavedRun(directory) {
  const read = name => JSON.parse(fs.readFileSync(path.join(directory, name), 'utf8').replace(/^\uFEFF/, ''));
  const config = read('config.json'), state = read('status.json');
  if (state.runId !== config.runId || path.resolve(config.runDir) !== path.resolve(directory)) throw Error('Run record identity differs.');
  let review = null; try { review = read('review.json'); } catch {}
  return {config, state, review};
}
