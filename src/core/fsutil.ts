import fs from 'node:fs';
import path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';

export const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

export const readJson = (file: string): any => JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, ''));

export function readJsonOr<T>(file: string, fallback: T): any {
  try { return readJson(file); } catch { return fallback; }
}

/** Reads a small UTF-8 text file, or null when it is missing or larger than maxBytes. */
export function readBounded(file: string, maxBytes = 65_536): string | null {
  try { if (fs.statSync(file).size > maxBytes) return null; return fs.readFileSync(file, 'utf8').replace(/^﻿/, ''); } catch { return null; }
}

/**
 * Write via temp file in the same directory + rename, so readers never see a
 * partial file. Retries on EPERM/EACCES (Windows antivirus/indexer locks).
 */
export function writeFileAtomic(filePath: string, data: string | Uint8Array, retries = 3) {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  for (let attempt = 1; attempt <= retries; attempt++) {
    const tmp = path.join(dir, `.${path.basename(filePath)}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}.tmp`);
    try {
      fs.writeFileSync(tmp, data);
      fs.renameSync(tmp, filePath);
      return;
    } catch (err) {
      try { fs.unlinkSync(tmp); } catch { /* best effort */ }
      if (attempt === retries || !['EPERM', 'EACCES'].includes(err.code)) throw err;
    }
  }
}

export const saveJson = (file: string, data: unknown) => writeFileAtomic(file, JSON.stringify(data, null, 2) + '\n');

export const isAlive = (pid: unknown): boolean => {
  if (!Number.isInteger(pid) || (pid as number) < 1) return false;
  try { process.kill(pid as number, 0); return true; } catch (e) { return e.code === 'EPERM'; }
};

export const contained = (root: string, child: string) => {
  const rel = path.relative(root, child);
  return rel === '' || (!rel.startsWith('..' + path.sep) && rel !== '..' && !path.isAbsolute(rel));
};

export interface Captured { ok: boolean; exitCode: number | null; stdout: string; stderr: string; error?: string; timedOut?: boolean }

const MAX_CAPTURE_BYTES = 1_000_000;

/**
 * Run a command to completion and capture output. Never throws; kills the
 * child after timeoutMs. Arguments are passed as an array without a shell.
 */
export function spawnCaptured(command: string, args: string[], { timeoutMs, cwd, env }: { timeoutMs: number; cwd?: string; env?: NodeJS.ProcessEnv }): Promise<Captured> {
  return new Promise(resolve => {
    let stdout = '', stderr = '', settled = false, timedOut = false;
    let child: ChildProcess;
    try {
      child = spawn(command, args, { shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], cwd, env });
    } catch (err) {
      resolve({ ok: false, exitCode: null, stdout: '', stderr: '', error: `spawn failed: ${err.message}` });
      return;
    }
    const timer = setTimeout(() => { timedOut = true; try { child.kill(); } catch { /* best effort */ } }, timeoutMs);
    const finish = (result: Captured) => { if (settled) return; settled = true; clearTimeout(timer); resolve(result); };
    child.stdout?.on('data', chunk => { if (stdout.length < MAX_CAPTURE_BYTES) stdout += chunk; });
    child.stderr?.on('data', chunk => { if (stderr.length < MAX_CAPTURE_BYTES) stderr += chunk; });
    child.on('error', err => finish({ ok: false, exitCode: null, stdout, stderr, error: `spawn error: ${err.message}` }));
    child.on('close', code => finish({ ok: !timedOut && code === 0, exitCode: code, stdout, stderr, timedOut,
      error: timedOut ? `timed out after ${timeoutMs}ms` : undefined }));
  });
}
