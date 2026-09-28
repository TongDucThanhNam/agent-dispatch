import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export const MAX_ASSIGNMENT_CHARACTERS = 12_000;

export function readAssignment(file) {
  if (!fs.existsSync(file)) throw new Error('The assignment file does not exist.');
  const text = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
  if (!text.trim()) throw new Error('The assignment is empty. Provide a nonempty task brief.');
  if (text.length > MAX_ASSIGNMENT_CHARACTERS) {
    throw new Error(`Assignment has ${text.length} characters; maximum is ${MAX_ASSIGNMENT_CHARACTERS} (${text.length - MAX_ASSIGNMENT_CHARACTERS} over). Keep requirements and acceptance criteria; reference existing files instead of copying them. Aim for 4,000-8,000 characters. Nothing was started.`);
  }
  return text;
}

function canonical(directory) {
  let resolved = path.resolve(directory);
  try { resolved = fs.realpathSync(resolved); } catch {}
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function overlaps(project, workspace) {
  if (typeof workspace !== 'string' || !path.isAbsolute(workspace)) return false;
  const other = canonical(workspace);
  const contains = (parent, child) => {
    const relative = path.relative(parent, child);
    return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith('..' + path.sep));
  };
  return contains(project, other) || contains(other, project);
}

function alive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; }
}

// Inspection is advisory: never acquire/reclaim locks, start workers, or infer
// that a missing index entry proves no unmanaged process owns the checkout.
export function inspectProject(directory, { taskIndex = path.join(os.homedir(), '.zcode/v2/tasks-index.sqlite') } = {}) {
  const project = fs.realpathSync(path.resolve(directory));
  if (!fs.statSync(project).isDirectory()) throw new Error('Project must be a directory.');
  const locks: any[] = [];
  for (let parent = project; ; parent = path.dirname(parent)) {
    const lockPath = path.join(parent, '.zcode-dispatch/active-run.lock');
    try {
      const record = JSON.parse(fs.readFileSync(lockPath, 'utf8').replace(/^\uFEFF/, ''));
      locks.push({ path: lockPath, runId: record.runId ?? null, runDir: record.runDir ?? null,
        runnerPid: record.runnerPid ?? null, runnerAlive: alive(record.runnerPid),
        workerPid: record.workerPid ?? null, workerAlive: alive(record.workerPid), needsReconciliation: true });
    } catch (error) {
      if (error.code !== 'ENOENT') locks.push({ path: lockPath, unreadable: true, needsReconciliation: true });
    }
    if (path.dirname(parent) === parent) break;
  }

  const desktop: any = { taskIndex: path.resolve(taskIndex), available: false, tasks: null, idle: null };
  let db;
  try {
    db = new DatabaseSync(taskIndex, { readOnly: true });
    desktop.available = true;
    const terminal = new Set(['completed', 'complete', 'failed', 'error', 'cancelled', 'canceled']);
    const read = (sql, statusKey) => {
      try {
        const matching = db.prepare(sql).all().filter(row => overlaps(canonical(project), row.workspace_path));
        return { available: true, matchingCount: matching.length,
          unresolved: matching.filter(row => !terminal.has(String(row[statusKey] ?? '').toLowerCase())) };
      } catch {
        return { available: false, reason: 'Index schema unavailable or incompatible; inspect the installed desktop/IDLE adapter. Do not assume an empty queue.' };
      }
    };
    desktop.tasks = read('SELECT task_id, workspace_path, task_status, updated_at FROM tasks', 'task_status');
    desktop.idle = read('SELECT off_peak_task_id, workspace_path, status, session_id, started_at FROM off_peak_tasks', 'status');
  } catch {
    desktop.reason = 'Task index unavailable; inspect desktop/IDLE ownership separately. No index was created.';
  } finally { db?.close(); }

  return { project, readOnly: true, startsWorker: false, managedLocks: locks, desktop,
    limits: 'Snapshot only: exact-project/ancestor managed locks and overlapping desktop/IDLE records, not every unmanaged process or descendant lock. Unknown/dead-PID locks still need reconciliation. No automatic cleanup or launch authorization.' };
}
