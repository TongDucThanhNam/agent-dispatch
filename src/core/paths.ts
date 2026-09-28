import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Repository root of the installed tool; assets and the CLI entry are resolved from here, never from cwd. */
export const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const CLI_ENTRY = path.join(PACKAGE_ROOT, 'src', 'cli', 'main.ts');
export const asset = (...parts: string[]) => path.join(PACKAGE_ROOT, 'assets', ...parts);

/** Records stay under the historical names so older monitors and runs keep working. */
export const RECORD_DIR = '.zcode-dispatch';
export const LOCK_FILE = 'active-run.lock';
export const home = (...parts: string[]) => path.join(os.homedir(), ...parts);

/**
 * The ZCode native CLI is a Node program started with a Node `--import` loader,
 * so it needs Node even though this tool runs on Bun.
 */
export function nodeExecutable(): string {
  const configured = process.env.AGENT_DISPATCH_NODE;
  if (configured) return configured;
  if (!process.versions.bun) return process.execPath;
  return Bun.which('node') ?? 'node';
}

/** Command shown to agents in callbacks, receipts and hints. */
export const CLI_NAME = 'agent-dispatch';
