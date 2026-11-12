import { afterEach, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { installAgyWorker } from '../scripts/setup-agy.ts';
import { asset } from '../src/core/paths.ts';
import { rmTree } from './helpers.ts';

const homes: string[] = [];
const home = () => { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-setup-')); homes.push(dir); return dir; };
const target = (dir: string) => path.join(dir, '.gemini', 'config', 'agents', 'lean', 'agent.md');
afterEach(() => { for (const dir of homes.splice(0)) rmTree(dir); });

test('AGY setup installs the versioned minimal worker and is idempotent', () => {
  const homeDir = home(), installed = installAgyWorker({ homeDir });
  expect(installed.action).toBe('installed');
  expect(fs.readFileSync(installed.target, 'utf8')).toBe(fs.readFileSync(asset('agents', 'agy-lean', 'agent.md'), 'utf8'));
  expect(installAgyWorker({ homeDir }).action).toBe('unchanged');
  expect(fs.readdirSync(path.dirname(installed.target))).toEqual(['agent.md']);
});

test('AGY setup dry run creates no home configuration', () => {
  const homeDir = home();
  expect(installAgyWorker({ homeDir, dryRun: true }).action).toBe('installed');
  expect(fs.existsSync(path.join(homeDir, '.gemini'))).toBe(false);
});

test('AGY setup refuses a different profile and force creates an exact backup', () => {
  const homeDir = home(), file = target(homeDir), previous = '# Custom worker\n';
  fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, previous);
  expect(() => installAgyWorker({ homeDir })).toThrow('--force');
  expect(fs.readFileSync(file, 'utf8')).toBe(previous);
  const preview = installAgyWorker({ homeDir, force: true, dryRun: true });
  expect(preview.action).toBe('updated'); expect(fs.existsSync(preview.backup!)).toBe(false);
  expect(fs.readFileSync(file, 'utf8')).toBe(previous);
  const updated = installAgyWorker({ homeDir, force: true });
  expect(updated.action).toBe('updated'); expect(fs.readFileSync(updated.backup!, 'utf8')).toBe(previous);
  expect(fs.readFileSync(file, 'utf8')).toContain('excludeDefaultComponents: true');
});
