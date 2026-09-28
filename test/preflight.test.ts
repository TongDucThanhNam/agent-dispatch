// @ts-nocheck: ported from the JavaScript suite; it drives loosely typed internals with partial fixtures. Runtime-checked by bun test.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { inspectProject, readAssignment } from '../src/index.ts';
import { compactStatus } from '../src/index.ts';
import { nodeExecutable } from '../src/index.ts';
import { cli, rmTree } from './helpers.ts';
const NODE = nodeExecutable();

function temporary(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zcode-preflight-'));
  t.after(() => {
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
    rmTree(root);
  });
  return root;
}

test('brief boundary accepts 12,000 after BOM removal and reports exact excess without content', t => {
  const root = temporary(t), brief = path.join(root, 'brief.md');
  fs.writeFileSync(brief, '\uFEFF' + 'x'.repeat(12_000));
  assert.equal(readAssignment(brief).length, 12_000);
  fs.writeFileSync(brief, 'private-brief' + 'x'.repeat(12_000));
  assert.throws(() => readAssignment(brief), error => {
    assert.match(error.message, /12013 characters.*12000 \(13 over\)/);
    assert.ok(!error.message.includes('private-brief'));
    return true;
  });
  fs.writeFileSync(brief, '\uFEFF \r\n\t');
  assert.throws(() => readAssignment(brief), /empty/);
  assert.throws(() => readAssignment(path.join(root, 'missing.md')), /does not exist/);
});

test('oversized check starts nothing and requires no provider calls or run state', t => {
  const root = temporary(t), brief = path.join(root, 'brief.md');
  fs.writeFileSync(brief, 'x'.repeat(12_321));
  const result = cli(['check', '--worker', 'zcode', '--stage', 'discovery', '--project', root, '--brief', brief, '--notify', 'none']);
  assert.equal(result.status, 5, result.stdout + result.stderr);
  assert.equal(result.envelope.ok, false); assert.equal(result.envelope.error.code, 'ASSIGNMENT_INVALID');
  assert.match(result.envelope.error.message, /12321 characters.*321 over/);
  assert.match(result.envelope.error.hint, /template discovery/);
  assert.deepEqual(fs.readdirSync(root), ['brief.md']);
});

test('missing index stays unavailable and is not created', t => {
  const root = temporary(t), taskIndex = path.join(root, 'missing.sqlite');
  const snapshot = inspectProject(root, { taskIndex });
  assert.equal(snapshot.desktop.available, false);
  assert.equal(snapshot.desktop.tasks, null);
  assert.equal(snapshot.startsWorker, false);
  assert.equal(fs.existsSync(taskIndex), false);
  assert.equal(fs.existsSync(path.join(root, '.zcode-dispatch')), false);
});

test('ownership snapshot includes parent/child and unknown states, excludes siblings and private content', t => {
  const root = temporary(t), project = path.join(root, 'desktop'), taskIndex = path.join(root, 'index.sqlite');
  fs.mkdirSync(project);
  const db = new DatabaseSync(taskIndex);
  db.exec('CREATE TABLE tasks(task_id TEXT,workspace_path TEXT,task_status TEXT,updated_at INTEGER,prompt TEXT); CREATE TABLE off_peak_tasks(off_peak_task_id TEXT,workspace_path TEXT,status TEXT,session_id TEXT,started_at INTEGER,prompt TEXT)');
  const task = db.prepare('INSERT INTO tasks VALUES(?,?,?,?,?)');
  task.run('parent', root, 'running', 1, 'SECRET PROMPT');
  task.run('complete', project, 'completed', 2, 'SECRET PROMPT');
  task.run('unknown', path.join(project, 'src'), null, 3, 'SECRET PROMPT');
  task.run('sibling', path.join(root, 'desktop-other'), 'running', 4, 'SECRET PROMPT');
  db.prepare('INSERT INTO off_peak_tasks VALUES(?,?,?,?,?,?)').run('queued', project, 'queued', null, null, 'SECRET PROMPT');
  db.close();
  const before = fs.readFileSync(taskIndex);
  const snapshot = inspectProject(project, { taskIndex });
  assert.deepEqual(snapshot.desktop.tasks.unresolved.map(row => row.task_id), ['parent', 'unknown']);
  assert.equal(snapshot.desktop.tasks.matchingCount, 3);
  assert.equal(snapshot.desktop.idle.unresolved[0].off_peak_task_id, 'queued');
  assert.equal(snapshot.desktop.idle.unresolved[0].session_id, null);
  assert.ok(!JSON.stringify(snapshot).includes('SECRET'));
  assert.deepEqual(fs.readFileSync(taskIndex), before);
});

test('incompatible schema is unknown, never a false empty queue', t => {
  const root = temporary(t), taskIndex = path.join(root, 'index.sqlite');
  const db = new DatabaseSync(taskIndex);
  db.exec('CREATE TABLE tasks(changed_schema TEXT)');
  db.close();
  const snapshot = inspectProject(root, { taskIndex });
  assert.equal(snapshot.desktop.available, true);
  assert.equal(snapshot.desktop.tasks.available, false);
  assert.equal(snapshot.desktop.idle.available, false);
  assert.equal(snapshot.desktop.idle.unresolved, undefined);
});

test('dead-PID and malformed ancestor locks remain untouched and require reconciliation', t => {
  const root = temporary(t), project = path.join(root, 'desktop');
  fs.mkdirSync(path.join(project, '.zcode-dispatch'), { recursive: true });
  fs.mkdirSync(path.join(root, '.zcode-dispatch'));
  const lock = path.join(project, '.zcode-dispatch/active-run.lock');
  const parentLock = path.join(root, '.zcode-dispatch/active-run.lock');
  const content = JSON.stringify({ runnerPid: 0, workerPid: -1, runId: 'old', runDir: path.join(project, '.zcode-dispatch/old') });
  fs.writeFileSync(lock, content);
  fs.writeFileSync(parentLock, '{broken');
  const snapshot = inspectProject(project, { taskIndex: path.join(root, 'missing.sqlite') });
  const own = snapshot.managedLocks.find(row => row.path === lock);
  assert.equal(own.runnerAlive, false);
  assert.equal(own.needsReconciliation, true);
  assert.equal(snapshot.managedLocks.find(row => row.path === parentLock).unreadable, true);
  assert.equal(fs.readFileSync(lock, 'utf8'), content);
  assert.equal(fs.readFileSync(parentLock, 'utf8'), '{broken');
});

test('inspect CLI is read-only and needs neither an assignment nor provider configuration', t => {
  const root = temporary(t);
  const result = cli(['inspect', '--project', root, '--task-index', path.join(root, 'missing.sqlite')]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.envelope.cmd, 'inspect');
  const snapshot = result.envelope.data;
  assert.equal(snapshot.readOnly, true);
  assert.equal(snapshot.startsWorker, false);
  assert.deepEqual(fs.readdirSync(root), []);
});

test('status separates configured selection from absent or different telemetry', t => {
  const root = temporary(t);
  fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify({ expectedProvider: 'selected-provider', expectedModel: 'selected-model', zcodeEffort: 'max' }));
  const statusFile = path.join(root, 'status.json');
  fs.writeFileSync(statusFile, JSON.stringify({ status: 'running', runnerPid: process.pid }));
  assert.deepEqual(compactStatus(root).selection, { provider: 'selected-provider', model: 'selected-model', effort: 'max' });
  assert.deepEqual(compactStatus(root).observed, { provider: null, model: null });
  fs.writeFileSync(statusFile, JSON.stringify({ status: 'running', provider: 'actual-provider', model: 'actual-model' }));
  assert.deepEqual(compactStatus(root).observed, { provider: 'actual-provider', model: 'actual-model' });
});
