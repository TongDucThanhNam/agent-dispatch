import fs from 'node:fs';
import path from 'node:path';
import { readJson, saveJson } from './fsutil.ts';
import { RECORD_DIR, LOCK_FILE, CLI_NAME } from './paths.ts';
import { shortRef } from './config.ts';
import { CliError } from '../protocol/errors.ts';

export const lockPathFor = (project: string) => path.join(project, RECORD_DIR, LOCK_FILE);

export function readLock(project: string): any {
  try { return readJson(lockPathFor(project)); } catch { return fs.existsSync(lockPathFor(project)) ? {} : null; }
}

export function lockHeld(previous: any, message: string) {
  const ref = previous?.runId ? shortRef(previous.runId) : null;
  return new CliError('LOCK_HELD', message,
    ref ? `Inspect it with: ${CLI_NAME} status ${ref}. A stale lock is never removed automatically.` : 'Inspect the lock file before starting another run.',
    previous?.runId ? { runId: previous.runId, runDir: previous.runDir ?? null } : undefined);
}

/**
 * One managed run per checkout, shared by every worker kind. The lock is
 * created exclusively and only released by the runner that created it.
 */
export function acquireProjectLock(config: { project: string; runId: string; runDir: string }) {
  const lockPath = lockPathFor(config.project);
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  const lock = { runnerPid: process.pid, workerPid: null as number | null, createdAt: Date.now(), runId: config.runId, runDir: config.runDir };
  try { fs.writeFileSync(lockPath, JSON.stringify(lock), { flag: 'wx' }); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const previous = readLock(config.project) ?? {};
    throw lockHeld(previous, `A project run lock already exists (${previous.runId ?? 'unknown run'}). Inspect that run before starting another. A stale lock is not automatically removed.`);
  }
  return {
    lockPath, data: lock,
    setWorker(pid: number) { lock.workerPid = pid; saveJson(lockPath, lock); },
    release() {
      try { const current = readJson(lockPath); if (current.runnerPid === lock.runnerPid && current.createdAt === lock.createdAt) fs.unlinkSync(lockPath); } catch {}
    },
  };
}
