import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnCaptured, writeFileAtomic } from './dispatcher.mjs';

const read = file => JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
const save = (file, value) => writeFileAtomic(file, JSON.stringify(value, null, 2) + '\n');
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const within = (root, file) => { const rel = path.relative(root, file); return rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel); };
export const objectiveFile = config => path.join(config.project, '.zcode-dispatch', 'objectives', config.objectiveId, 'state.json');
export function objectiveConfig(raw, project, runId) {
  const workflowVersion = raw.workflowVersion ?? (raw.schemaVersion ? 1 : 2);
  if (![1, 2].includes(workflowVersion)) throw new Error('Invalid workflowVersion.');
  const objectiveId = raw.objectiveId ?? hash(project.toLowerCase() + '\n' + (raw.threadId ?? 'local')).slice(0, 24);
  const stageId = raw.stageId ?? runId;
  for (const id of [objectiveId, stageId]) if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,100}$/.test(id)) throw new Error('Invalid objective/stage ID.');
  const integer = (name, fallback, min, max) => { const n = raw[name] ?? fallback; if (!Number.isInteger(n) || n < min || n > max) throw new Error(`Invalid ${name}.`); return n; };
  for (const field of ['strategyChange', 'blockerResolved']) if (raw[field] != null && (typeof raw[field] !== 'string' || !raw[field].trim() || raw[field].length > 2000)) throw new Error(`Invalid ${field}.`);
  if (raw.activeFindingIds != null && (!Array.isArray(raw.activeFindingIds) || raw.activeFindingIds.length > 30 || raw.activeFindingIds.some(id => !/^F\d{4,}$/.test(id)))) throw new Error('Invalid activeFindingIds.');
  if (raw.freshWorker != null && typeof raw.freshWorker !== 'boolean') throw new Error('freshWorker must be boolean.');
  const callbackPolicy = raw.callbackPolicy ?? (workflowVersion === 2 ? 'actionable' : 'legacy');
  if (!['actionable', 'legacy'].includes(callbackPolicy)) throw new Error('Invalid callbackPolicy.');
  return { workflowVersion, objectiveId, stageId, callbackPolicy, activeFindingIds: raw.activeFindingIds ?? null,
    strategyChange: raw.strategyChange ?? null, blockerResolved: raw.blockerResolved ?? null, freshWorker: raw.freshWorker === true,
    maxObjectiveCorrections: integer('maxObjectiveCorrections', 6, 0, 100),
    maxObjectiveUncachedReviewTokens: integer('maxObjectiveUncachedReviewTokens', 500000, 1, 100000000),
    maxWorkerContextTokens: integer('maxWorkerContextTokens', 240000, 1000, 2000000),
    toolErrorReconcileMs: integer('toolErrorReconcileMs', 60000, 1000, 3600000) };
}

// All mutations run under the dispatcher's existing exclusive project lock.
export function openObjective(config) {
  const file = objectiveFile(config);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  let state = fs.existsSync(file) ? read(file) : { version: 2, id: config.objectiveId, project: config.project,
    objective: config.objective, remainingScope: config.remainingScope, accepted: [], findings: [], nextFinding: 1,
    attempts: 0, corrections: 0, reviews: 0, uncachedReviewTokens: 0, unknownUsageReviews: 0,
    limits: { corrections: config.maxObjectiveCorrections, uncachedReviewTokens: config.maxObjectiveUncachedReviewTokens } };
  if (state.project !== config.project) throw new Error('Objective project mismatch.');
  const persist = (kind, detail = {}) => {
    state.updatedAt = Date.now(); save(file, state);
    fs.appendFileSync(path.join(path.dirname(file), 'history.jsonl'), JSON.stringify({ at: state.updatedAt, runId: config.runId, stageId: config.stageId, kind, ...detail }) + '\n');
  };
  const nextLimits = { corrections: config.maxObjectiveCorrections, uncachedReviewTokens: config.maxObjectiveUncachedReviewTokens };
  if (Object.keys(nextLimits).some(key => nextLimits[key] > state.limits[key]) && !config.strategyChange) throw new Error('Increasing objective limits requires a recorded strategyChange; a new run ID cannot reset them.');
  state.limits = nextLimits;
  if (config.objective && state.objective && config.objective !== state.objective && !config.strategyChange) throw new Error('Changing the overall objective requires a recorded strategyChange; use stageAcceptance for a smaller stage.');
  if (config.objective) state.objective = config.objective;
  if (config.remainingScope != null) state.remainingScope = config.remainingScope;
  const open = () => state.findings.filter(f => !f.resolvedAt);
  const active = () => open().filter(f => config.activeFindingIds == null || config.activeFindingIds.includes(f.id));
  if (config.activeFindingIds?.some(id => !open().some(f => f.id === id))) throw new Error('activeFindingIds must reference existing open findings.');
  // A different stage name cannot hide unfinished findings without a strategy decision.
  if (open().some(f => !active().includes(f)) && (!config.strategyChange || !config.remainingScope?.trim())) throw new Error('Deferring open findings requires strategyChange and an explicit remaining scope.');
  state.currentStage = { id: config.stageId, runId: config.runId, acceptance: config.stageAcceptance, preservedContracts: config.preservedContracts };
  persist('stage_opened', { strategyChange: config.strategyChange });
  if (state.blocker && config.blockerResolved) { persist('blocker_reconciled', {blocker: state.blocker, reason: config.blockerResolved}); state.blocker = null; }
  const gate = () => {
    if (state.blocker) return `Resolve the recorded ${state.blocker} blocker explicitly before another worker/review.`;
    if (state.uncachedReviewTokens >= state.limits.uncachedReviewTokens) return 'Objective review input budget reached; make a strategy decision before further spending.';
    return null;
  };
  return {
    file, state, active, persist, gate,
    beginWorker() {
      const blocked = gate(); if (blocked) return blocked;
      const correction = state.attempts > 0 && (state.lastOutcome !== 'accepted' || active().length > 0);
      if (correction && state.corrections >= state.limits.corrections) return 'Objective correction budget reached across all runs; replan without resetting the objective ID.';
      if (correction) state.corrections++;
      state.attempts++; state.lastOutcome = 'running'; state.blocker = null;
      persist('worker_reserved', { correction }); return null;
    },
    worker(record) { state.lastWorker = record; persist('worker_exited', { record }); },
    rotateReason({freshWorker = config.freshWorker} = {}) {
      if (freshWorker) return 'explicit fresh worker';
      if (state.lastWorker?.status === 'ready_for_review' && state.lastWorker?.usage?.lastInputTokens >= config.maxWorkerContextTokens) return 'observed worker context threshold';
      if (state.staleAttempts >= 2 && state.lastWorker?.status === 'ready_for_review') return 'repeated stale evidence';
      return null;
    },
    chargeReview(usage) {
      state.reviews++;
      if (Number.isFinite(usage?.inputTokens) && Number.isFinite(usage?.cachedInputTokens)) state.uncachedReviewTokens += Math.max(0, usage.inputTokens - usage.cachedInputTokens);
      else { state.unknownUsageReviews++; state.blocker = 'unknown_review_usage'; }
      persist('review_usage', { usage });
    },
    validateVerdict(verdict) {
      const ids = verdict.resolvedFindingIds ?? [];
      if (new Set(ids).size !== ids.length || ids.some(id => !active().some(f => f.id === id))) throw new Error('Resolved IDs must reference active open findings exactly once.');
      if (verdict.verdict === 'accepted' && active().some(f => !ids.includes(f.id))) throw new Error('Accepted must explicitly resolve every active finding.');
      const seen = new Set();
      for (const f of verdict.findings) {
        if (f.id && (!active().some(old => old.id === f.id) || ids.includes(f.id) || seen.has(f.id))) throw new Error('Invalid or contradictory finding ID.');
        if (f.id) seen.add(f.id);
        if (f.regression) {
          safeArtifact(config.project, f.regression.artifact);
          if (f.regression.check && !config.verificationCommands.some(c => c.name === f.regression.check)) throw new Error('Regression check must name a caller-assigned command.');
        }
      }
    },
    verdict(verdict, evidence) {
      this.validateVerdict(verdict);
      for (const id of verdict.resolvedFindingIds ?? []) { const f = state.findings.find(f => f.id === id); f.resolvedAt = Date.now(); f.resolvedEvidence = evidence; }
      for (const finding of verdict.findings) {
        const old = finding.id ? state.findings.find(f => f.id === finding.id) : open().find(f => f.path === finding.path && f.issue === finding.issue);
        const id = old?.id ?? `F${String(state.nextFinding++).padStart(4, '0')}`;
        const item = { ...finding, regression: finding.regression ?? old?.regression ?? null, id, stageId: config.stageId, evidencePath: evidence, resolvedAt: null };
        if (old) Object.assign(old, item); else state.findings.push(item);
        finding.id = id;
      }
      state.lastVerdict = { verdict: verdict.verdict, summary: verdict.summary, evidence };
      if (verdict.verdict === 'accepted') state.accepted.push({ stageId: config.stageId, acceptance: config.stageAcceptance, preservedContracts: config.preservedContracts, evidence, at: Date.now() });
      persist('verdict', { evidence });
    },
    finish(outcome) {
      state.lastOutcome = outcome.kind;
      if (['blocked', 'cancelled', 'worker_failed', 'runner_error'].includes(outcome.kind)) state.blocker = outcome.reason ?? outcome.error?.kind ?? outcome.kind;
      persist('stage_finished', { outcome });
    }
  };
}

export function safeArtifact(project, relative) {
  if (typeof relative !== 'string' || !relative || path.isAbsolute(relative) || !within(project, path.resolve(project, relative))) throw new Error('Regression artifact must be project-relative.');
  const file = path.resolve(project, relative);
  let ancestor = file;
  while (!fs.existsSync(ancestor)) ancestor = path.dirname(ancestor);
  if (!within(fs.realpathSync(project), fs.realpathSync(ancestor))) throw new Error('Regression artifact escapes through a link.');
  return file;
}

export function preflightEvidence(config, objective, { report, todos = [], checks = [], fingerprint }) {
  const issues = [];
  if (!report.split(/\r?\n/).some(line => line.trim() === `Stage: ${config.stageId}`)) issues.push('Worker report must identify exactly Stage: ' + config.stageId);
  const activeTodos = todos.filter(t => !['completed', 'cancelled'].includes(t.status));
  if (activeTodos.some(t => !t.content.startsWith(`[${config.stageId}] `))) issues.push(`Native checklist has unscoped or stale active items; replace obsolete todos and prefix current items with [${config.stageId}] .`);
  const artifacts = new Set(config.testEvidence ?? []);
  for (const f of objective.active()) if (f.regression) artifacts.add(f.regression.artifact);
  const hashes = {};
  for (const relative of artifacts) {
    const file = safeArtifact(config.project, relative);
    if (!fs.existsSync(file) || !fs.statSync(file).isFile()) { issues.push('Missing required evidence file: ' + relative); hashes[relative] = null; continue; }
    if (fs.statSync(file).size > 32000000) { issues.push('Evidence exceeds the 32 MB file bound; provide a focused receipt: ' + relative); hashes[relative] = null; continue; }
    const data = fs.readFileSync(file); hashes[relative] = hash(data);
    for (const f of objective.active().filter(f => f.regression?.artifact === relative)) {
      const r = f.regression;
      if (r.marker && !data.toString('utf8').includes(r.marker)) issues.push(`${f.id}: missing regression marker ${r.marker} in ${relative}`);
      if (r.check && !checks.some(c => c.name === r.check && c.passed)) issues.push(`${f.id}: required check ${r.check} has no passing dispatcher receipt`);
    }
  }
  const evidenceHash = hash(JSON.stringify({ fingerprint, hashes, commands: config.verificationCommands, checks: checks.map(c => [c.name, c.passed]) }));
  if (objective.state.lastRejectedEvidence === evidenceHash) issues.push('Source and required evidence are unchanged since the rejected review; no additional Astra request is warranted.');
  objective.state.staleAttempts = issues.length ? (objective.state.staleAttempts ?? 0) + 1 : 0;
  objective.persist('preflight', { issues, evidenceHash, nativeChecklistObserved: todos.length > 0 });
  return { issues, evidenceHash };
}

export function workerHandoff(config, objective) {
  return [`Stage: ${config.stageId}`, `First replace obsolete native todo/checklist entries with this assignment; prefix each active item exactly with [${config.stageId}] followed by a space.`,
    'Include the exact Stage line above in your final report. Implement only this stage and provide actual test evidence.',
    `Objective state (current, not history): ${objective.file}`, `Objective: ${objective.state.objective ?? config.objective ?? ''}`,
    `Accepted stages to preserve: ${objective.state.accepted.map(s => s.stageId).join(', ') || 'none'}`,
    `Active findings: ${objective.active().map(f => f.id).join(', ') || 'none'}`,
    `Remaining scope: ${objective.state.remainingScope ?? 'see assignment'}`, 'Read only the relevant records/sections; do not load old transcripts or history.'].join('\n');
}

export async function reviewDelta(config, objective, post, roundDir, initial) {
  const prior = objective.state.lastReviewed;
  const sameScope = prior && JSON.stringify(prior.scope) === JSON.stringify(config.reviewPaths);
  const baseline = sameScope ? read(prior.identityPath) : initial;
  const baselineDir = sameScope ? prior.snapshotDir : path.join(config.runDir, 'source-baseline');
  const snapshotDir = path.join(roundDir, 'source-reviewed'); fs.mkdirSync(snapshotDir, { recursive: true });
  for (const [rel, identity] of Object.entries(post.files)) {
    const data = fs.readFileSync(path.join(config.project, rel));
    if (hash(data) !== identity.hash) throw new Error('Source changed while saving review delta.');
    const target = path.join(snapshotDir, rel); fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, data);
  }
  const identityPath = path.join(roundDir, 'reviewed-identity.json'); save(identityPath, post);
  // No shell interpolation, and no repository-wide diff. Full evidence stays on disk.
  const result = await spawnCaptured('git', ['diff', '--no-index', '--no-ext-diff', '--unified=5', '--', baselineDir, snapshotDir], { timeoutMs: 30000 });
  const diffFile = path.join(roundDir, 'delta.patch');
  fs.writeFileSync(diffFile, (result.exitCode === 0 || result.exitCode === 1) ? result.stdout + (result.stdout.length >= 1000000 ? '\nDIFF CAPTURE LIMIT REACHED; compare the full scoped snapshots for remaining hunks.\n' : '') : 'Unified diff unavailable; compare the scoped snapshots directly.\n');
  return { baseline, baselineDir, diffFile, next: { scope: config.reviewPaths, identityPath, snapshotDir } };
}

export function compactObjective(config) {
  const file = objectiveFile(config); if (!fs.existsSync(file)) return null;
  const s = read(file), open = s.findings.filter(f => !f.resolvedAt);
  return { objectiveId: s.id, objective: s.objective, currentStage: s.currentStage, remainingScope: s.remainingScope,
    acceptedCount: s.accepted.length, latestAccepted: s.accepted.at(-1) ?? null,
    openFindings: open.slice(0, 20).map(f => ({ id: f.id, path: f.path, issue: f.issue.slice(0, 240) })), totalOpenFindings: open.length,
    attempts: s.attempts, corrections: s.corrections, reviews: s.reviews, uncachedReviewTokens: s.uncachedReviewTokens,
    unknownUsageReviews: s.unknownUsageReviews, limits: s.limits, blocker: s.blocker ?? null, lastVerdict: s.lastVerdict, statePath: file };
}

export function applyStageFile(next, file) {
  const patch = read(file);
  const fields = ['promptFile', 'stageId', 'objective', 'stageAcceptance', 'preservedContracts', 'remainingScope', 'reviewPaths', 'verificationCommands', 'testEvidence', 'activeFindingIds', 'freshWorker', 'strategyChange', 'blockerResolved', 'maxObjectiveCorrections', 'maxObjectiveUncachedReviewTokens', 'maxWorkerContextTokens'];
  if (!patch || typeof patch !== 'object' || Array.isArray(patch) || Object.keys(patch).some(k => !fields.includes(k))) throw new Error('Stage file contains unsupported fields; project, objective ID, provider and worker identity cannot be replaced here.');
  if (typeof patch.promptFile !== 'string' || !patch.promptFile.trim()) throw new Error('Stage file requires promptFile.');
  return { ...next, ...patch, promptFile: path.resolve(path.dirname(file), patch.promptFile) };
}
