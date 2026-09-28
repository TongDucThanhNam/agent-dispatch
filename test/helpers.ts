import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { CLI_ENTRY } from '../src/core/paths.ts';

/**
 * Removes a fixture directory. Bun's node:sqlite keeps a database file open until
 * its prepared statements are collected, and Windows refuses to delete open files,
 * so collect first; a directory that is still busy is left in the temp folder.
 */
export function rmTree(dir: string) {
  Bun.gc(true);
  try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); }
  catch (error: any) { if (error?.code !== 'EBUSY' && error?.code !== 'EPERM') throw error; }
}

export interface CliResult { status: number | null; stdout: string; stderr: string; envelope: any }

/** Runs the CLI in a child Bun process with orchestrator detection neutralised, and parses the JSON envelope. */
export function cli(args: string[], { env = {}, cwd }: { env?: Record<string, string>; cwd?: string } = {}): CliResult {
  const result = spawnSync(process.execPath, [CLI_ENTRY, ...args], {
    encoding: 'utf8', windowsHide: true, cwd, timeout: 120_000,
    env: { ...process.env, CLAUDECODE: '', CODEX_THREAD_ID: '', ...env },
  });
  let envelope: any = null;
  try { envelope = JSON.parse(result.stdout); } catch {}
  return { status: result.status, stdout: result.stdout, stderr: result.stderr, envelope };
}
