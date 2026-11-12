import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { asset } from '../src/core/paths.ts';
import { writeFileAtomic } from '../src/core/fsutil.ts';

/** Installs the versioned worker profile; never copies credentials or machine settings. */
export function installAgyWorker({ homeDir = os.homedir(), dryRun = false, force = false } = {}) {
  const source = asset('agents', 'agy-lean', 'agent.md');
  const target = path.join(homeDir, '.gemini', 'config', 'agents', 'lean', 'agent.md');
  const content = fs.readFileSync(source, 'utf8');
  let existing: string | null = null;
  try { existing = fs.readFileSync(target, 'utf8'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (existing === content) return { action: 'unchanged', source, target, dryRun };
  if (existing !== null && !force)
    throw new Error(`AGY lean profile differs at ${target}. Re-run bun run setup:agy --force to back it up and replace it.`);
  const backup = existing === null ? null : `${target}.bak-${crypto.randomUUID()}`;
  if (!dryRun) {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    if (backup) fs.copyFileSync(target, backup, fs.constants.COPYFILE_EXCL);
    writeFileAtomic(target, content);
  }
  return { action: existing === null ? 'installed' : 'updated', source, target, dryRun, ...(backup ? { backup } : {}) };
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  try {
    const unknown = args.find(arg => !['--dry-run', '--force'].includes(arg));
    if (unknown) throw new Error(`Unknown option ${unknown}. Usage: bun run setup:agy [--dry-run] [--force]`);
    console.log(JSON.stringify(installAgyWorker({ dryRun: args.includes('--dry-run'), force: args.includes('--force') })));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
