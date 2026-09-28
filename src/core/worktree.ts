import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';

// Read-only working-tree fingerprint used to check that a discovery run left the checkout unchanged
// and whether files changed between discovery and execution. It never stages, resets or cleans anything.
const MAX_ENTRIES = 5000, MAX_HASH_BYTES = 32 * 1024 * 1024, MAX_LISTED = 50;
const IGNORED = ['.zcode-dispatch/', '.tmp/'];

function git(cwd, args) {
  const result = spawnSync('git', ['--no-optional-locks', '-c', 'core.quotepath=off', ...args], { cwd, encoding: 'buffer', windowsHide: true, maxBuffer: 64 * 1024 * 1024, timeout: 60_000 });
  if (result.error || result.status !== 0) return null;
  return result.stdout;
}

function contentHash(file) {
  try {
    const stat = fs.lstatSync(file);
    if (stat.isDirectory()) return 'dir';
    if (stat.size > MAX_HASH_BYTES) return `size:${stat.size}:${Math.trunc(stat.mtimeMs)}`;
    return crypto.createHash('sha1').update(fs.readFileSync(file)).digest('hex');
  } catch { return 'missing'; }
}

export function worktreeFingerprint(project) {
  const top = git(project, ['rev-parse', '--show-toplevel']);
  if (!top) return { git: false, reason: 'Not a git working tree; the edit guard is unavailable.', at: Date.now() };
  const root = path.resolve(top.toString('utf8').trim());
  const head = git(project, ['rev-parse', '--verify', '-q', 'HEAD'])?.toString('utf8').trim() || null;
  const status = git(project, ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--', '.']);
  if (!status) return { git: false, reason: 'git status failed; the edit guard is unavailable.', at: Date.now() };
  const prefix = path.relative(root, project).replaceAll('\\', '/');
  const ignored = IGNORED.map(x => prefix ? `${prefix}/${x}` : x);
  const fields = status.toString('utf8').split('\0'), entries = {};
  let count = 0, truncated = false;
  for (let i = 0; i < fields.length; i++) {
    const field = fields[i];
    if (field.length < 4) continue;
    const code = field.slice(0, 2), file = field.slice(3);
    if (code[0] === 'R' || code[0] === 'C') i++; // The next field is the rename/copy source.
    if (ignored.some(x => file.startsWith(x))) continue;
    if (++count > MAX_ENTRIES) { truncated = true; break; }
    entries[file] = `${code}:${contentHash(path.join(root, file))}`;
  }
  return { git: true, root, head, entries, truncated, at: Date.now() };
}

export function compareFingerprints(before, after) {
  if (!before?.git || !after?.git) return { available: false, clean: null, headChanged: false, changed: [], reason: (before?.git ? after : before)?.reason ?? 'No fingerprint.' };
  const changed: any[] = [];
  for (const file of new Set([...Object.keys(before.entries), ...Object.keys(after.entries)]))
    if (before.entries[file] !== after.entries[file]) changed.push(file);
  changed.sort();
  const headChanged = before.head !== after.head;
  return { available: true, clean: !headChanged && changed.length === 0, headChanged, changedCount: changed.length,
    changed: changed.slice(0, MAX_LISTED), truncated: Boolean(before.truncated || after.truncated) };
}

export function describeChanges(diff) {
  if (!diff?.available || diff.clean) return '';
  const files = diff.changed.join(', ') + (diff.changedCount > diff.changed.length ? ` (+${diff.changedCount - diff.changed.length} more)` : '');
  return [diff.headChanged ? 'HEAD moved' : '', files].filter(Boolean).join('; ');
}
