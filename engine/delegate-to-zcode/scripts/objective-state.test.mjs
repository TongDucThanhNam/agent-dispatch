import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { validateConfig, supervise, main } from './run.mjs';
import { openObjective, objectiveFile, preflightEvidence, compactObjective, applyStageFile, safeArtifact } from './objective-state.mjs';
import { parseReviewVerdict, verdictJsonSchema } from './review-loop.mjs';
import { nextRunConfig } from './model-selection.mjs';
import { assess } from './monitor-core.mjs';

const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const write = (file, value) => fs.writeFileSync(file, JSON.stringify(value));
function fixture(t, extra = {}) {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'delegate-v2-'));
  t.after(() => fs.rmSync(project, {recursive: true, force: true}));
  fs.mkdirSync(path.join(project, 'src')); fs.writeFileSync(path.join(project, 'src/app.js'), 'export const version = 1;\n');
  fs.writeFileSync(path.join(project, 'assignment.md'), 'Make version 2 and test the preserved contract.');
  return validateConfig({project, notify: false, runId: 'first', stageId: 'implement', promptFile: path.join(project, 'assignment.md'),
    reviewPaths: ['src'], objective: 'Ship the full product goal.', stageAcceptance: ['Version 2 is correct.'], remainingScope: 'Documentation and integration checks.',
    keepOpenMs: 0, pollMs: 100, quietMs: 500, stallMs: 2000, ...extra});
}
const accepted = (ids = []) => ({verdict: 'accepted', summary: 'Verified required behavior.', findings: [], checks: [{name: 'version', result: 'pass', evidence: 'src/app.js'}], resolvedFindingIds: ids});
const rejected = (id = null, regression = null) => ({verdict: 'changes_required', summary: 'Required behavior is missing.',
  findings: [{id, regression, severity: 'high', path: 'src/app.js', issue: 'The preserved contract lacks coverage.', expected: 'Add regression coverage.', evidence: 'src/app.js'}], checks: [] , resolvedFindingIds: []});

test('objective correction and usage limits survive new run IDs and session resets', t => {
  const config = fixture(t, {maxObjectiveCorrections: 1, maxObjectiveUncachedReviewTokens: 100});
  let ledger = openObjective(config);
  assert.equal(ledger.beginWorker(), null); ledger.finish({kind: 'needs_replan'});
  const next = {...config, runId: 'second', stageId: 'renamed', freshWorker: true};
  ledger = openObjective(next); assert.equal(ledger.beginWorker(), null); ledger.finish({kind: 'needs_replan'});
  ledger = openObjective({...next, runId: 'third'}); assert.match(ledger.beginWorker(), /correction budget/);
  assert.equal(ledger.state.attempts, 2); assert.equal(ledger.state.corrections, 1);
  assert.throws(() => openObjective({...next, maxObjectiveCorrections: 2}), /strategyChange/);
  ledger = openObjective({...next, maxObjectiveCorrections: 2, strategyChange: 'Change test oracle strategy; one additional correction.'});
  assert.equal(ledger.beginWorker(), null);
  ledger.chargeReview({inputTokens: 120, cachedInputTokens: 20});
  assert.match(openObjective({...next, maxObjectiveCorrections: 2}).gate(), /review input budget/);
});

test('quota and unknown usage require reconciliation and never disappear on a fresh session', t => {
  const config = fixture(t); let ledger = openObjective(config);
  ledger.finish({kind: 'blocked', reason: 'quota'});
  assert.match(openObjective({...config, freshWorker: true}).beginWorker(), /quota/);
  ledger = openObjective({...config, blockerResolved: 'User confirmed quota restored; old process exited.'});
  assert.equal(ledger.beginWorker(), null); ledger.chargeReview(null);
  assert.match(ledger.gate(), /unknown_review_usage/);
  assert.equal(ledger.state.unknownUsageReviews, 1);
});

test('stable findings and regression obligations persist across stages without silent closure', t => {
  const config = fixture(t, {verificationCommands: [{name: 'unit', command: process.execPath, args: ['--version']}]});
  let ledger = openObjective(config);
  ledger.verdict(rejected(null, {artifact: 'src/regression.test.js', marker: 'preserves system role', check: 'unit'}), 'review.json');
  assert.equal(ledger.active()[0].id, 'F0001');
  ledger = openObjective({...config, runId: 'second'});
  assert.throws(() => ledger.validateVerdict(accepted()), /resolve every active/);
  assert.throws(() => ledger.validateVerdict(rejected('F9000')), /finding ID/);
  assert.throws(() => ledger.validateVerdict(rejected(null, {artifact: 'src/test.js', marker: null, check: 'unapproved'})), /caller-assigned/);
  assert.throws(() => openObjective({...config, activeFindingIds: []}), /Deferring/);
  const pending = preflightEvidence(config, ledger, {report: 'Stage: implement', fingerprint: 'fp'});
  assert.match(pending.issues.join('\n'), /Missing required evidence/);
  fs.writeFileSync(path.join(config.project, 'src/regression.test.js'), 'preserves system role');
  assert.match(preflightEvidence(config, ledger, {report: 'Stage: implement', fingerprint: 'fp'}).issues.join('\n'), /no passing dispatcher receipt/);
  const passed = preflightEvidence(config, ledger, {report: 'Stage: implement', fingerprint: 'fp', checks: [{name: 'unit', passed: true}]});
  assert.deepEqual(passed.issues, []);
  ledger.state.lastRejectedEvidence = passed.evidenceHash;
  assert.match(preflightEvidence(config, ledger, {report: 'Stage: implement', fingerprint: 'fp', checks: [{name: 'unit', passed: true}]}).issues.join('\n'), /unchanged/);
  ledger.verdict(accepted(['F0001']), 'accepted.json'); ledger.finish({kind: 'accepted'});
  assert.equal(ledger.active().length, 0); assert.equal(ledger.state.accepted.length, 1);
  assert.equal(openObjective({...config, runId: 'next'}).beginWorker(), null);
  assert.equal(compactObjective(config).acceptedCount, 1);
});

test('stage evidence catches stale native todos and disallows escaping artifact paths', t => {
  const config = fixture(t), ledger = openObjective(config);
  const result = preflightEvidence(config, ledger, {report: 'Stage: old-stage', todos: [{status: 'in_progress', content: 'old sanitizer task'}], fingerprint: 'f'});
  assert.equal(result.issues.length, 2);
  assert.throws(() => safeArtifact(config.project, '../outside'), /project-relative/);
  assert.throws(() => safeArtifact(config.project, config.project), /project-relative/);
});

test('v2 strict schema rejects missing IDs/regressions and preserves the v1 protocol', () => {
  assert.equal(parseReviewVerdict(JSON.stringify(accepted()), 2).verdict, 'accepted');
  const invalid = accepted(); delete invalid.resolvedFindingIds;
  assert.throws(() => parseReviewVerdict(JSON.stringify(invalid), 2), /schema/);
  assert.equal(parseReviewVerdict(JSON.stringify(invalid), 1).verdict, 'accepted');
  const malformed = rejected(); malformed.findings[0].regression = {artifact: 'tests.js', marker: null};
  assert.throws(() => parseReviewVerdict(JSON.stringify(malformed), 2), /schema/);
  assert.ok(verdictJsonSchema(2).properties.findings.items.required.includes('regression'));
});

test('stage file retains project/model/objective identity while replacing only current scope', t => {
  const config = fixture(t), file = path.join(config.project, 'next.json');
  write(file, {promptFile: 'assignment.md', stageId: 'next', stageAcceptance: ['Next criterion'], freshWorker: true});
  const next = applyStageFile(nextRunConfig(config, {workerExited: true, sessionId: 'sess_saved'}), file);
  assert.equal(next.project, config.project); assert.equal(next.objectiveId, config.objectiveId); assert.equal(next.zcodeEffort, 'max');
  assert.equal(next.promptFile, config.promptFile); assert.equal(next.freshWorker, true);
  write(file, {promptFile: 'assignment.md', project: 'elsewhere'}); assert.throws(() => applyStageFile(next, file), /unsupported/);
});

test('actionable callbacks ignore silence and recovered errors while retaining hard blockers', () => {
  const opts = {now: 1000000, startedAt: 0, stallMs: 600000, callbackPolicy: 'actionable', toolErrorReconcileMs: 60000};
  const base = {available: true, lastActivityAt: 0, modelStatus: 'pending', tools: [], errors: []};
  assert.equal(assess(base, opts).alert, null);
  assert.equal(assess({available: false}, opts).alert, null);
  const errors = [0, 1, 2].map(i => ({name: 'Edit', status: 'error', error: 'not found', updatedAt: opts.now - 10000 - i}));
  assert.equal(assess({...base, tools: errors}, opts).alert, null);
  const later = {...opts, now: opts.now + 70000};
  assert.equal(assess({...base, modelStatus: 'completed', tools: errors}, later).alert.kind, 'repeated_tool_error');
  assert.equal(assess({...base, modelStatus: 'completed', tools: [...errors, {name: 'Edit', status: 'completed', updatedAt: opts.now}]}, later).alert, null);
  assert.equal(assess({...base, errors: [{kind: 'quota', stop: true, message: 'quota exhausted'}]}, opts).stop.kind, 'quota');
});

// Real subprocess transports, fake deterministic worker/reviewer executables.
// These fixtures make no external model requests and deliver no real callbacks.
async function integration(t, workerKind, {stale = false, rotate = false, noProgress = false, regression = false} = {}) {
  const config = fixture(t, {workerKind, ...(workerKind === 'agy' ? {model: 'fixture-model', agyEffort: 'high'} : {}), maxAutoCorrections: 2});
  const reviewer = path.join(config.project, 'reviewer.mjs'), countFile = path.join(config.project, 'reviews.json');
  const bad = rejected(null, regression ? {artifact: 'src/regression.test.js', marker: 'required case', check: null} : null);
  fs.writeFileSync(reviewer, `import fs from 'node:fs';
const a=process.argv.slice(2); let packet=''; for await(const chunk of process.stdin) packet+=chunk;
const file=${JSON.stringify(countFile)}, n=fs.existsSync(file)?JSON.parse(fs.readFileSync(file)):0; fs.writeFileSync(file,JSON.stringify(n+1));
fs.writeFileSync(a[a.indexOf('--output-last-message')+1],JSON.stringify(n===0?${JSON.stringify(bad)}:${JSON.stringify(accepted(['F0001']))}));
console.log(JSON.stringify({type:'turn.completed',usage:{input_tokens:100,cached_input_tokens:20,output_tokens:10}}));`);
  config.codexExe = reviewer;
  const worker = path.join(config.project, 'worker.mjs');
  fs.writeFileSync(worker, `import fs from 'node:fs'; const [file,n,session,report,edit]=process.argv.slice(2); if(edit==='yes') fs.appendFileSync(file,'// change '+n+'\\n'); console.log(JSON.stringify({sessionId:session,response:report}));`);
  const captures = []; let currentSession = null;
  const sessionFor = n => workerKind === 'agy' ? `12345678-1234-4234-8234-${String(n + 1).padStart(12,'0')}` : `sess_fixture_${n}`;
  const callbacks = [];
  // Enable notifications only to the injected callback recorder.
  config.notify = true; config.threadId = '12345678-1234-4234-8234-123456789abc';
  const deps = {
    spawnWorker({config: effective, prompt, round, out, err}) {
      currentSession = effective.resumeSessionId ?? sessionFor(round);
      captures.push({round, resume: effective.resumeSessionId, prompt, session: currentSession});
      return spawn(process.execPath, [worker, path.join(config.project, 'src/app.js'), String(round), currentSession, `Stage: ${stale ? 'wrong' : 'implement'}\nDone.`, noProgress && round > 0 ? 'no' : 'yes'], {shell: false, windowsHide: true, stdio: ['ignore', out, err]});
    },
    telemetryFactory: () => ({close() {}, read: () => ({available: true, sessionId: currentSession, lastActivityAt: Date.now(), tools: [], todos: [], errors: [], usage: {lastInputTokens: rotate ? 900000 : 5000}})}),
    runCallback: async (thread, message) => { callbacks.push(message); return {ok: true, exitCode: 0}; }
  };
  const state = await supervise(config, deps);
  return {config, state, deps, captures, callbacks, reviews: fs.existsSync(countFile) ? read(countFile) : 0, ledger: read(objectiveFile(config))};
}

for (const kind of ['zcode', 'agy']) test(`${kind}: independent rejection/correction/acceptance, persisted findings and one callback`, async t => {
  const r = await integration(t, kind);
  assert.equal(r.state.status, 'complete', JSON.stringify(r.state.error)); assert.equal(r.reviews, 2); assert.equal(r.captures.length, 2);
  assert.equal(r.captures[1].resume, r.captures[0].session); assert.equal(r.callbacks.length, 1);
  assert.equal(r.ledger.uncachedReviewTokens, 160); assert.equal(r.ledger.corrections, 1); assert.equal(r.ledger.findings[0].id, 'F0001');
  assert.ok(r.ledger.findings[0].resolvedAt);
  const packet = fs.readFileSync(path.join(r.config.runDir, 'review/round-1/attempt-1-packet.md'), 'utf8');
  assert.match(packet, /round-0.*source-reviewed/); assert.match(packet, /F0001/);
  const delta = fs.readFileSync(path.join(r.config.runDir, 'review/round-1/delta.patch'), 'utf8');
  assert.match(delta, /\+\/\/ change 1/); assert.doesNotMatch(delta, /\+\/\/ change 0/);
});

test('missing stage identity never calls Astra and reaches the bounded replan outcome', async t => {
  const r = await integration(t, 'zcode', {stale: true});
  assert.equal(r.state.status, 'needs_replan'); assert.equal(r.reviews, 0); assert.equal(r.captures.length, 3); assert.equal(r.callbacks.length, 1);
});
test('unchanged rejected source never triggers a repeated Astra review', async t => {
  const r = await integration(t, 'zcode', {noProgress: true});
  assert.equal(r.state.status, 'needs_replan'); assert.equal(r.reviews, 1); assert.equal(r.ledger.corrections, 2);
});
test('missing persistent regression evidence is corrected locally without another Astra review', async t => {
  const r = await integration(t, 'zcode', {regression: true});
  assert.equal(r.state.status, 'needs_replan'); assert.equal(r.reviews, 1); assert.equal(r.ledger.findings[0].regression.marker, 'required case');
});
for (const kind of ['zcode', 'agy']) test(`${kind}: high observed worker context rotates only after exit and retains objective`, async t => {
  const r = await integration(t, kind, {rotate: true});
  assert.equal(r.state.status, 'complete'); assert.equal(r.captures[1].resume, null);
  assert.notEqual(r.captures[0].session, r.captures[1].session); assert.match(r.captures[1].prompt, /F0001/);
  assert.equal(r.ledger.corrections, 1); assert.equal(r.ledger.accepted.length, 1);
});

test('a replacement run hits the objective budget before spawning and brief exposes its actionable state', async t => {
  const r = await integration(t, 'zcode', {noProgress: true});
  const next = validateConfig({...r.config, runId: 'replacement', runDir: undefined, maxObjectiveCorrections: 2, freshWorker: true, resumeSessionId: r.state.sessionId});
  const priorCaptures = r.captures.length;
  const stopped = await supervise(next, r.deps);
  assert.equal(stopped.status, 'needs_replan'); assert.equal(stopped.workerExited, true);
  assert.equal(r.captures.length, priorCaptures); assert.match(stopped.error.message, /correction budget/);
  const log = console.log; let output;
  try { console.log = value => {output = value;}; await main(['brief', '--run-dir', next.runDir]); } finally {console.log = log;}
  const brief = JSON.parse(output);
  assert.equal(brief.objective.corrections, 2); assert.equal(brief.objective.totalOpenFindings, 1);
  assert.equal(brief.objective.objectiveId, r.config.objectiveId); assert.ok(output.length < 5000);
});
