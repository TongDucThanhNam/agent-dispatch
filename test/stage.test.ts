// @ts-nocheck: ported from the JavaScript suite; it drives loosely typed internals with partial fixtures. Runtime-checked by bun test.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { validateConfig, supervise, linkDiscovery, compactStatus, publicState, shortRef } from '../src/index.ts';
import { worktreeFingerprint, compareFingerprints, describeChanges } from '../src/index.ts';
import { readRun } from '../src/index.ts';
import { nodeExecutable } from '../src/index.ts';
import { rmTree } from './helpers.ts';
const NODE = nodeExecutable();

const git = (cwd, ...args) => { const r = spawnSync('git', ['-c', 'user.email=fixture@example.invalid', '-c', 'user.name=fixture', ...args], { cwd, encoding: 'utf8', windowsHide: true }); assert.equal(r.status, 0, r.stderr); return r.stdout; };
function repo(t, name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `zcode-stage-${name}-`));
  t.after(() => rmTree(dir));
  git(dir, 'init', '-q'); fs.writeFileSync(path.join(dir, 'app.js'), 'export const unit = "beat";\n'); fs.writeFileSync(path.join(dir, 'dirty.js'), 'a\n');
  git(dir, 'add', '.'); git(dir, 'commit', '-q', '-m', 'base');
  fs.writeFileSync(path.join(dir, 'dirty.js'), 'user edit in progress\n'); // A pre-existing user edit must not count as a discovery change.
  fs.writeFileSync(path.join(dir, 'brief.md'), 'Question 1: which unit does app.js use? No model requests.');
  return fs.realpathSync(dir);
}
const configFor = (project, runId, extra = {}) => validateConfig({ project, promptFile: path.join(project, 'brief.md'), runId, notify: false,
  pollMs: 100, quietMs: 1000, stallMs: 2000, keepOpenMs: 0, ...extra });
const worker = (code, capture) => ({ prompt, out, err }) => { capture.prompt = prompt;
  return spawn(NODE, ['--input-type=module', '-e', code], { windowsHide: true, shell: false, stdio: ['ignore', out, err] }); };
const deps = (code, capture, extra = {}) => ({ spawnWorker: worker(code, capture), async runCallback(thread, message) { capture.messages.push(message); return { ok: true, exitCode: 0 }; },
  telemetryFactory() { return { read: () => ({ available: false, reason: 'fixture' }), close() {} }; }, ...extra });
const respond = text => `process.stdout.write(JSON.stringify({sessionId:'sess_fixture',response:${JSON.stringify(text)}}));`;

test('worktree fingerprints detect edits, new files and commits but ignore run records, .tmp and existing user edits', t => {
  const project = repo(t, 'fp'), before = worktreeFingerprint(project);
  assert.equal(before.git, true); assert.ok(before.entries['dirty.js']);
  fs.mkdirSync(path.join(project, '.tmp'), { recursive: true }); fs.writeFileSync(path.join(project, '.tmp', 'probe.mjs'), 'probe');
  fs.mkdirSync(path.join(project, '.zcode-dispatch', 'run-x'), { recursive: true }); fs.writeFileSync(path.join(project, '.zcode-dispatch', 'run-x', 'status.json'), '{}');
  assert.deepEqual(compareFingerprints(before, worktreeFingerprint(project)).changed, []);
  assert.equal(compareFingerprints(before, worktreeFingerprint(project)).clean, true);
  fs.writeFileSync(path.join(project, 'app.js'), 'export const unit = "second";\n'); fs.writeFileSync(path.join(project, 'new.js'), 'x');
  const edited = compareFingerprints(before, worktreeFingerprint(project));
  assert.equal(edited.clean, false); assert.deepEqual(edited.changed, ['app.js', 'new.js']);
  assert.equal(describeChanges(edited), 'app.js, new.js');
  git(project, 'add', 'app.js'); git(project, 'commit', '-q', '-m', 'worker commit');
  const committed = compareFingerprints(before, worktreeFingerprint(project));
  assert.equal(committed.headChanged, true); assert.match(describeChanges(committed), /^HEAD moved; /);
  const plain = fs.mkdtempSync(path.join(os.tmpdir(), 'zcode-stage-plain-')); t.after(() => rmTree(plain));
  const unavailable = compareFingerprints(worktreeFingerprint(plain), worktreeFingerprint(plain));
  assert.equal(unavailable.available, false); assert.equal(unavailable.clean, null); assert.equal(describeChanges(unavailable), '');
});

test('stage configuration is validated and a discovery link must stay inside the project', t => {
  const project = repo(t, 'cfg');
  assert.equal(configFor(project, 'plain').stage, 'execution');
  assert.throws(() => configFor(project, 'bad', { stage: 'review' }), /discovery or execution/);
  assert.throws(() => configFor(project, 'bad2', { stage: 'discovery', discoveryRunDir: path.join(project, '.zcode-dispatch', 'd') }), /execution stage/);
  assert.throws(() => configFor(project, 'bad3', { discoveryRunDir: os.tmpdir() }), /same project/);
});

test('a clean discovery run gets the discovery preamble and a planning callback; execution from it gets the packet and drift', async t => {
  const project = repo(t, 'flow'), d = { messages: [] };
  const discovery = configFor(project, 'disc', { stage: 'discovery', notify: true, threadId: '11111111-1111-4111-8111-111111111111' });
  const state = await supervise(discovery, deps(respond('1. OBSERVED: app.js exports unit "beat".'), d));
  assert.equal(state.status, 'ready_for_review');
  assert.match(d.prompt, /^Dispatch run: disc\n\nDiscovery stage: /); assert.doesNotMatch(d.prompt, /Execution ownership/);
  assert.deepEqual(state.worktreeGuard, { available: true, clean: true, headChanged: false, changedCount: 0, changed: [] });
  assert.equal(state.alert, null);
  assert.equal(d.messages.length, 1);
  assert.match(d.messages[0], /^\[ZCode discovery ready_for_review\]/);
  assert.ok(d.messages[0].includes(`agent-dispatch launch --worker zcode --stage execution --from ${shortRef(discovery.runId)} --brief <plan.md>`));
  const saved = JSON.parse(fs.readFileSync(path.join(discovery.runDir, 'discovery.json'), 'utf8'));
  assert.equal(saved.diff.clean, true); assert.ok(saved.before.entries['dirty.js']);
  assert.equal(compactStatus(discovery.runDir).stage, 'discovery'); assert.equal(compactStatus(discovery.runDir).worktreeGuard.clean, true);
  assert.equal(publicState(discovery, state, true).stage, 'discovery');

  // The user edits a file between discovery and execution.
  fs.writeFileSync(path.join(project, 'app.js'), 'export const unit = "beat"; // reviewed\n');
  const execution = configFor(project, 'exec', { discoveryRunDir: discovery.runDir });
  const link = linkDiscovery(execution);
  assert.equal(link.reportPath, path.join(discovery.runDir, 'worker-report.md'));
  assert.deepEqual(execution.discoveryDrift.changed, ['app.js']);
  const e = { messages: [] };
  const done = await supervise(validateConfig(execution), deps(respond('Implemented; tests passed.'), e));
  assert.equal(done.status, 'ready_for_review');
  assert.match(e.prompt, /Execution ownership: .*BLOCKED \(REPLAN\)/);
  assert.ok(e.prompt.includes(`Discovery packet: ${path.join(discovery.runDir, 'worker-report.md')}`));
  assert.match(e.prompt, /Project files changed since discovery: app\.js\. Re-read them/);
  const status = compactStatus(execution.runDir);
  assert.equal(status.stage, 'execution'); assert.equal(status.fromDiscovery, discovery.runDir); assert.deepEqual(status.discoveryDrift.changed, ['app.js']);
  assert.equal(readRun({ key: 'k', runDir: discovery.runDir }, { telemetry: false }).stage, 'discovery');
});

test('a discovery worker that edits project files is flagged, not silently accepted', async t => {
  const project = repo(t, 'dirty'), d = { messages: [] };
  const discovery = configFor(project, 'disc-dirty', { stage: 'discovery', notify: true, threadId: '11111111-1111-4111-8111-111111111111' });
  const edit = `import fs from 'node:fs'; fs.writeFileSync(${JSON.stringify(path.join(project, 'app.js'))}, 'changed'); ${respond('Report.')}`;
  const state = await supervise(discovery, deps(edit, d));
  assert.equal(state.status, 'ready_for_review');
  assert.equal(state.worktreeGuard.clean, false); assert.deepEqual(state.worktreeGuard.changed, ['app.js']);
  assert.equal(state.alert.kind, 'discovery_changed_files'); assert.match(state.alert.message, /app\.js/);
  assert.match(d.messages[0], /detected project changes during discovery \(app\.js\).*do not discard them/);
  assert.ok(state.events.some(x => /changed project files: app\.js/.test(x.message)));
});

test('execution cannot link a non-discovery, unfinished or foreign run', async t => {
  const project = repo(t, 'link'), c = { messages: [] };
  const plain = configFor(project, 'plain-run');
  await supervise(plain, deps(respond('Done.'), c));
  assert.throws(() => linkDiscovery(configFor(project, 'x1', { discoveryRunDir: plain.runDir })), /discovery-stage run/);
  const running = configFor(project, 'running-disc', { stage: 'discovery' });
  fs.mkdirSync(running.runDir, { recursive: true });
  fs.writeFileSync(path.join(running.runDir, 'config.json'), JSON.stringify(running));
  fs.writeFileSync(path.join(running.runDir, 'status.json'), JSON.stringify({ runId: running.runId, workerExited: false }));
  assert.throws(() => linkDiscovery(configFor(project, 'x2', { discoveryRunDir: running.runDir })), /not exited/);
  assert.throws(() => linkDiscovery(configFor(project, 'x3', { discoveryRunDir: path.join(project, '.zcode-dispatch', 'missing') })), /no readable run record/);
});
