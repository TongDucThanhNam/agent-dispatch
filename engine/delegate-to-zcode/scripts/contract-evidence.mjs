import fs from 'node:fs';
import path from 'node:path';
import { computeSourceState, diffSourceStates } from './review-loop.mjs';
import { writeFileAtomic } from './dispatcher.mjs';
import { digest, projectPath, covers, readJson } from './contract-plan.mjs';

export const save = (file, value) => writeFileAtomic(file, JSON.stringify(value, null, 2) + '\n');
export async function capture(plan, scope = plan.auditPaths) {
  const state = await computeSourceState({project: plan.project, reviewPaths: scope, reviewExcludePaths: plan.artifactPaths ?? []});
  if (!state.fingerprint) throw Object.assign(new Error('Source audit is incomplete: ' + (state.notes?.join('; ') ?? state.reason).slice(0, 1600)), {kind: 'source_audit'});
  return state;
}
export const changedFiles = (before, after) => {const diff = diffSourceStates(before, after); if (!diff.comparable) throw new Error('Source evidence cannot be compared.'); return [...diff.changed, ...diff.added, ...diff.removed];};
export function pins(plan, scopes) {
  const result = {}; let bytes = 0;
  const visit = rel => {
    const file = projectPath(plan.project, rel), stat = fs.lstatSync(file);
    if (stat.isSymbolicLink()) throw new Error('Pinned inputs cannot be filesystem links.');
    if (stat.isDirectory()) {for (const item of fs.readdirSync(file).sort()) visit(path.posix.join(rel, item)); return;}
    if (!stat.isFile() || stat.size > 32000000) throw new Error('Pinned inputs must be files under 32 MB.');
    bytes += stat.size;
    if (bytes > 128000000 || Object.keys(result).length >= 5000) throw new Error('Pinned input scope exceeds its file/byte bound; narrow it.');
    result[rel] = digest(fs.readFileSync(file));
  };
  for (const rel of scopes) visit(rel);
  return result;
}
export function verifyPins(plan, expected, scopes) {
  try {return JSON.stringify(pins(plan, scopes)) === JSON.stringify(expected);} catch {return false;}
}
export function writeCheckpoint(plan, before, directory) {
  if (plan.storageRoot) {
    const root = path.resolve(plan.storageRoot, 'objects');
    for (const [rel, value] of Object.entries(before.files)) {
      const data = fs.readFileSync(projectPath(plan.project, rel));
      if (digest(data) !== value.hash) throw new Error('Source changed while creating its checkpoint.');
      const target = path.join(root, value.hash.slice(0, 2), value.hash);
      fs.mkdirSync(path.dirname(target), {recursive: true});
      try {fs.writeFileSync(target, data, {flag: 'wx'});} catch (e) {if (e.code !== 'EEXIST') throw e; if (digest(fs.readFileSync(target)) !== value.hash) throw new Error('Stored rollback object is corrupt.');}
    }
    save(path.join(directory, 'storage.json'), {kind: 'content-addressed', root});
    save(path.join(directory, 'before.json'), before);
    return;
  }
  fs.mkdirSync(path.join(directory, 'files'), {recursive: true});
  for (const [rel, value] of Object.entries(before.files)) {
    const data = fs.readFileSync(projectPath(plan.project, rel));
    if (digest(data) !== value.hash) throw new Error('Source changed while creating its checkpoint.');
    const target = path.join(directory, 'files', rel); fs.mkdirSync(path.dirname(target), {recursive: true}); fs.writeFileSync(target, data);
  }
  save(path.join(directory, 'before.json'), before);
}
export async function restoreCheckpoint(plan, wave) {
  const before = readJson(path.join(wave.directory, 'before.json')), after = readJson(path.join(wave.directory, 'after.json'));
  const current = await capture(plan);
  if (current.fingerprint !== after.fingerprint) throw new Error('Workspace changed after this wave; rollback requires reconciliation and will not overwrite later edits.');
  const changes = changedFiles(before, after);
  if (changes.some(file => !wave.writePaths.some(scope => covers(scope, file)))) throw new Error('Wave contains unowned changes; automatic scoped rollback cannot attribute them safely.');
  // Validate every target and backup before performing any mutation. No Git reset,
  // recursive delete or cross-shell file operation is used.
  const operations = changes.map(rel => {
    const file = projectPath(plan.project, rel), original = before.files[rel];
    if (fs.existsSync(file) && !fs.lstatSync(file).isFile()) throw new Error('Rollback encountered a changed file type; reconcile it before restoring any content.');
    const storage = fs.existsSync(path.join(wave.directory, 'storage.json')) ? readJson(path.join(wave.directory, 'storage.json')) : null;
    if (original && !/^[a-f0-9]{64}$/.test(original.hash)) throw new Error('Invalid checkpoint object identity.');
    const data = original ? fs.readFileSync(storage?.kind === 'content-addressed' ? path.join(storage.root, original.hash.slice(0, 2), original.hash) : path.join(wave.directory, 'files', rel)) : null;
    if (original && digest(data) !== original.hash) throw new Error('Checkpoint content does not match its recorded identity.');
    return {file, data};
  });
  for (const {file, data} of operations) {
    if (data === null) fs.unlinkSync(file);
    else {fs.mkdirSync(path.dirname(file), {recursive: true}); fs.writeFileSync(file, data);}
  }
  const restored = await capture(plan);
  if (restored.fingerprint !== before.fingerprint) throw new Error('Rollback verification failed; inspect the checkpoint and current source.');
  return {filesRestored: changes, fingerprint: restored.fingerprint};
}

export function evaluateState(plan, state) {
  const attempts = Object.values(state.tasks).flatMap(t => t.attempts ?? []);
  const totals = key => attempts.length && attempts.every(a => Number.isFinite(a.usage?.[key])) ? attempts.reduce((n, a) => n + a.usage[key], 0) : null;
  return {strategy: 'contract-v3', objectiveId: plan.objectiveId, runId: plan.runId, codexTaskId: plan.threadId, status: state.status,
    objectiveComplete: state.status === 'complete', acceptance: state.finalValidation?.passed === true ? 'machine gates passed' : 'not yet established',
    finalJudgment: state.judgment ?? null, elapsedMs: (state.judgment?.at ?? state.endedAt ?? Date.now()) - state.startedAt,
    executionElapsedMs: (state.endedAt ?? Date.now()) - state.startedAt,
    objectiveElapsedMs: (state.judgment?.at ?? state.endedAt ?? Date.now()) - (state.objectiveStartedAt ?? state.startedAt),
    totalTasks: plan.tasks.length, acceptedTasks: Object.values(state.tasks).filter(t => t.status === 'accepted').length,
    workerAttempts: attempts.length, corrections: state.corrections, gateRuns: state.gateRuns, gateFailures: state.gateFailures, evidenceFailures: state.evidenceFailures ?? 0,
    integrationFailures: state.integrationFailures, callbackAttempts: (state.priorNotifications?.length ?? 0) + Object.keys(state.notifications ?? {}).length,
    routineAstraReviews: 0, mainAstraUsage: null, mainAstraUsageReason: 'Planning, exception and final-judgment usage belongs to the originating Codex task; it is not inferred from callbacks.',
    workerUsage: {inputTokens: totals('inputTokens'), cachedInputTokens: totals('cacheReadTokens'), outputTokens: totals('outputTokens'), modelCalls: totals('modelCalls'),
      unknownAttempts: attempts.filter(a => !a.usage || !Number.isFinite(a.usage.inputTokens)).length},
    findings: state.error ? [state.error] : [], measurementLimits: ['No production savings percentage or quota inferred.', 'Elapsed time across resumes includes waiting for decisions.', 'Worker counters retain their provider telemetry semantics.']};
}
