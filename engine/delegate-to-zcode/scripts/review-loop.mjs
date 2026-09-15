#!/usr/bin/env node
/**
 * review-loop.mjs — script-managed focused Astra review/correction loop.
 *
 * New native ZCode and AGY jobs use a fresh `codex exec` review context per
 * stage: the reviewer (gpt-6-astra, xhigh by default) independently reads the
 * relevant source and evidence and returns a strict structured verdict. The
 * script routes a changes_required verdict back to the exact existing worker
 * session; the originating main task is woken only for an accepted stage or an
 * actionable exception. The reviewer never implements; it runs read-only.
 *
 * All external processes use Node spawn with argument arrays, shell:false and
 * stdin prompt transport (Windows-safe argv), never shell string composition.
 * Tests inject fakes via deps; nothing here performs a live model request by
 * itself.
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { spawnCaptured, stopOwnedProcessTree as stopOwnedWorker } from './dispatcher.mjs';
import { classifyError } from './monitor-core.mjs';

export const REVIEW_MODES = Object.freeze(['script-astra', 'main-review']);
export const VERDICTS = Object.freeze(['accepted', 'changes_required', 'needs_replan']);
export const REVIEW_EFFORTS = Object.freeze(['minimal', 'low', 'medium', 'high', 'xhigh']);
export const DEFAULT_REVIEW_MODEL = 'gpt-6-astra';
export const DEFAULT_REVIEW_EFFORT = 'medium';

// Inline packet bounds. Nothing is silently truncated: bounded sections stay on
// disk in full and the packet references their path and size.
export const INLINE_WORKER_REPORT = 4_000;
export const INLINE_DIFF = 20_000;
export const MAX_LISTED_PATHS = 200;
const MAX_WALK_FILES = 5_000;
const MAX_HASH_BYTES = 32 * 1_000_000;
const MAX_GIT_OUTPUT = 200_000;
const MAX_FINDINGS = 30;

const sha256 = value => crypto.createHash('sha256').update(value).digest('hex');

// ---------------------------------------------------------------------------
// Source identity (fingerprints and changed-path evidence)
// ---------------------------------------------------------------------------

/** Scope precedence: explicit reviewPaths, else Git when present, else none. */
export function detectSourceScope(config) {
  if (Array.isArray(config.reviewPaths) && config.reviewPaths.length) {
    return { kind: 'paths', paths: config.reviewPaths };
  }
  for (let dir = path.resolve(config.project); ; dir = path.dirname(dir)) {
    if (fs.existsSync(path.join(dir, '.git'))) return { kind: 'git' };
    if (path.dirname(dir) === dir) break;
  }
  return { kind: 'none', reason: 'No Git repository and no explicit reviewPaths scope; source identity cannot be verified. Provide reviewPaths in the launch JSON for drift detection.' };
}

function walkPaths(project, relativePaths, limits = {}) {
  const maxFiles = limits.maxFiles ?? MAX_WALK_FILES;
  const files = {};
  const notes = [];
  let visited = 0, totalBytes = 0, stopped = false;
  const fail = message => { notes.push(message); stopped = true; };
  const seen = new Set();
  const visit = absolute => {
    if (stopped) return;
    const rel = path.relative(project, absolute).replaceAll('\\', '/');
    if (rel === '..' || rel.startsWith('../') || path.isAbsolute(rel)) { fail('Source path escapes project'); return; }
    if ((limits.excludePaths ?? []).some(p => {const normalized = p.replaceAll('\\', '/').toLowerCase(); return rel.toLowerCase() === normalized || rel.toLowerCase().startsWith(normalized + '/');})) return;
    if (seen.has(absolute)) return;
    seen.add(absolute);
    let stat; try { stat = fs.lstatSync(absolute); } catch (error) { if (error.code !== 'ENOENT') fail(`unreadable path ${rel}: ${error.code}`); return; }
    if (stat.isSymbolicLink()) { fail(`Symbolic link requires a narrower source scope: ${rel}`); return; }
    if (stat.isDirectory()) {
      const base = path.basename(absolute);
      if (['.git', 'node_modules', '.zcode-dispatch', '__pycache__'].includes(base)) return;
      let entries = []; try { entries = fs.readdirSync(absolute); } catch (error) { fail(`unreadable directory ${rel}: ${error.code}`); return; }
      for (const entry of entries.sort()) { visit(path.join(absolute, entry)); if (stopped) break; }
      return;
    }
    if (!stat.isFile()) return;
    if (visited >= maxFiles) { fail(`Source file limit ${maxFiles} exceeded at ${rel}`); return; }
    visited++;
    if (rel.split('/').includes('.zcode-dispatch')) return;
    totalBytes += stat.size;
    if (stat.size > MAX_HASH_BYTES || totalBytes > 128_000_000) {
      fail(`Source byte limit exceeded at ${rel} (file ${stat.size} bytes, scanned ${totalBytes} bytes; limits ${MAX_HASH_BYTES}/file, 128000000 total). Audit explicit source/dependency paths instead of tool distributions or generated trees. Do not exclude required source just to pass.`); return;
    }
    try { files[rel] = { ...(limits.metadataOnly ? {} : { hash: sha256(fs.readFileSync(absolute)) }), size: stat.size }; }
    catch (error) { fail(`unreadable file ${rel}: ${error.code}`); }
  };
  for (const rel of relativePaths) { visit(path.resolve(project, rel)); if (stopped) break; }
  return { files, notes, scannedFiles: visited, scannedBytes: totalBytes };
}

// Metadata-only preflight: no snapshots, source copies, model calls or partial fingerprints.
export function inspectSourceScope(config) {
  const { notes, scannedFiles, scannedBytes } = walkPaths(config.project, config.reviewPaths, {
    excludePaths: config.reviewExcludePaths ?? [], metadataOnly: true,
  });
  return { complete: notes.length === 0, notes, scannedFiles, scannedBytes,
    excludedDirectories: ['.git', 'node_modules', '.zcode-dispatch', '__pycache__'],
    limits: { files: MAX_WALK_FILES, fileBytes: MAX_HASH_BYTES, totalBytes: 128_000_000 } };
}

/**
 * Snapshot the authorized source identity, including actual tracked and
 * untracked contents. Pre-existing changes are part of
 * the baseline, so they are preserved rather than attributed to the worker.
 */
export async function computeSourceState(config, deps = {}) {
  const scope = detectSourceScope(config);
  if (scope.kind === 'none') return { ...scope, fingerprint: null, at: Date.now() };
  if (scope.kind === 'git') {
    const run = deps.runCaptured ?? spawnCaptured;
    const head = await run('git', ['-C', config.project, 'rev-parse', 'HEAD'], { timeoutMs: 20_000 });
    const listed = await run('git', ['-C', config.project, 'ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', '.'], { timeoutMs: 60_000 });
    if (!listed.ok || listed.stdout.length > MAX_GIT_OUTPUT) return { kind: 'none', fingerprint: null, at: Date.now(), reason: 'Git source enumeration failed or exceeded its bound; narrow reviewPaths.' };
    const { files, notes } = walkPaths(config.project, [...new Set(listed.stdout.split('\0').filter(Boolean))], deps);
    const headId = head.ok ? head.stdout.trim() : null;
    return { kind: 'git', head: headId, files, notes, complete: notes.length === 0, at: Date.now(),
      fingerprint: notes.length ? null : sha256(JSON.stringify([headId, Object.keys(files).sort().map(key => [key, files[key].hash])])) };
  }
  const { files, notes } = walkPaths(config.project, scope.paths, {...deps, excludePaths: config.reviewExcludePaths ?? []});
  const fingerprint = sha256(JSON.stringify(Object.keys(files).sort().map(key => [key, files[key].hash, files[key].size])));
  return { kind: 'paths', paths: scope.paths, files, notes, complete: notes.length === 0, at: Date.now(), fingerprint: notes.length ? null : fingerprint };
}

/** Compare two snapshots. Uncomparable identities are explicit, never "same". */
export function diffSourceStates(before, after) {
  if (!before || !after || !before.fingerprint || !after.fingerprint || before.complete === false || after.complete === false || before.kind !== after.kind) {
    return { comparable: false, reason: 'Source identity is unavailable for this scope; drift cannot be verified.', identical: null, changed: [], added: [], removed: [] };
  }
  const names = [...new Set([...Object.keys(before.files ?? {}), ...Object.keys(after.files ?? {})])].sort();
  const changed = [], added = [], removed = [];
  for (const name of names) {
    const was = before.files?.[name], now = after.files?.[name];
    if (was && !now) removed.push(name);
    else if (!was && now) added.push(name);
    else if (was && now && was.hash !== now.hash) changed.push(name);
  }
  return { kind: before.kind, comparable: true, identical: before.fingerprint === after.fingerprint,
    changed, added, removed,
    fingerprintBefore: before.fingerprint, fingerprintAfter: after.fingerprint };
}

// ---------------------------------------------------------------------------
// Review packet
// ---------------------------------------------------------------------------

export function verdictJsonSchema(version = 1) {
  const schema = {
    type: 'object', additionalProperties: false,
    required: ['verdict', 'summary', 'findings', 'checks'],
    properties: {
      verdict: { type: 'string', enum: ['accepted', 'changes_required', 'needs_replan'] },
      summary: { type: 'string', description: 'Concise independent review conclusion.' },
      findings: {
        type: 'array', maxItems: MAX_FINDINGS,
        items: {
          type: 'object', additionalProperties: false,
          required: ['severity', 'path', 'issue', 'expected', 'evidence'],
          properties: {
            severity: { type: 'string', enum: ['high', 'medium', 'low'] },
            path: { type: 'string' },
            issue: { type: 'string' },
            expected: { type: 'string' },
            evidence: { type: 'string', description: 'File/test/log reference supporting this finding.' }
          }
        }
      },
      checks: {
        type: 'array', maxItems: 30,
        items: {
          type: 'object', additionalProperties: false, required: ['name', 'result', 'evidence'],
          properties: { name: { type: 'string' }, result: { type: 'string', enum: ['pass', 'fail', 'not_verified'] }, evidence: { type: 'string' } }
        }
      }
    }
  };
  if (version === 2) {
    schema.required.push('resolvedFindingIds');
    schema.properties.resolvedFindingIds = {type: 'array', maxItems: 30, items: {type: 'string'}};
    const finding = schema.properties.findings.items;
    finding.required.push('id', 'regression');
    finding.properties.id = {type: ['string', 'null']};
    finding.properties.regression = {anyOf: [{type: 'null'}, {type: 'object', additionalProperties: false, required: ['artifact', 'marker', 'check'], properties: {artifact: {type: 'string'}, marker: {type: ['string', 'null']}, check: {type: ['string', 'null']}}}]};
  }
  return schema;
}

const lineList = (items, limit = MAX_LISTED_PATHS) => {
  const shown = (items ?? []).slice(0, limit);
  const rest = (items?.length ?? 0) - shown.length;
  return shown.map(item => `- ${item}`).join('\n') + (rest > 0 ? `\n- ... ${rest} more listed in the evidence files (not truncated away)` : '');
};

export function boundInline(text, limit, label) {
  if (text == null) return { text: '', note: `${label}: not available.` };
  const value = String(text);
  if (value.length <= limit) return { text: value, note: null };
  return { text: value.slice(0, limit), note: `${label}: showing the first ${limit} of ${value.length} characters; the complete content is on disk at the path above.` };
}

const describeCriteria = config => {
  const criteria = config.stageAcceptance;
  if (!criteria || (Array.isArray(criteria) && !criteria.length)) return null;
  const list = Array.isArray(criteria) ? criteria : [criteria];
  return list.map(item => `- ${item}`).join('\n');
};

/**
 * Build the reviewer packet. Acceptance criteria come from the caller's
 * configuration/assignment only; the worker report is inline as bounded
 * claims. Large evidence stays on disk with paths and sizes.
 */
export function buildReviewPacket({ config, stage = 1, round, workerStatus, workerExitCode, assignmentPath, assignmentText,
  workerReportPath, workerReportText, reportExcerptLimit = INLINE_WORKER_REPORT, sourceDiff, changedPathsFile,
  diffFile, objectivePath, baselineDir, previousFindings = [], previousVerdictPath, testEvidence = [], reviewDir, verificationPath }) {
  const criteria = describeCriteria(config);
  const report = boundInline(workerReportText, reportExcerptLimit, 'Worker report inline excerpt');
  const sizeOf = file => { try { return fs.statSync(file).size; } catch { return null; } };
  const rel = file => file == null ? null : (path.relative(config.project, file).replaceAll('\\', '/') || file);
  const identity = sourceDiff ?? { comparable: false, reason: 'Source identity unavailable.', fingerprintAfter: null };
  return [
    'You are an independent reviewer. You never implement, edit files, or run state-changing commands; you read source and evidence and verify it yourself. Your final message must be exactly one JSON object matching the provided output schema: verdict "accepted", "changes_required", or "needs_replan", with concrete findings and evidence references.',
    '',
    `Run: ${config.runId} · stage ${stage} · review round ${round} · worker ${config.workerKind === 'agy' ? 'AGY' : 'ZCode'} (model ${config.expectedModel}${config.agyEffort ? `, effort ${config.agyEffort}` : ''}).`,
    `Project root: ${config.project}`,
    `Run directory: ${config.runDir}`,
    '',
    '## Objective',
    config.objective?.trim() || 'Complete the assigned stage below; it is one bounded stage of a larger user goal, not the whole goal.',
    '',
    '## Acceptance criteria (authoritative)',
    criteria ?? 'The authoritative acceptance criteria are in the assignment below (its "Stage acceptance" / "Acceptance" section). They are set by the caller; the worker report cannot redefine them.',
    config.preservedContracts ? `\nPreserved contracts:\n${config.preservedContracts}` : '',
    '',
    '## Assignment (verbatim)',
    `File: ${assignmentPath} (${sizeOf(assignmentPath) ?? '?'} bytes)`,
    boundInline(assignmentText, 12_000, 'Assignment inline').text,
    '',
    '## Changed source this stage',
    identity.comparable
      ? `Source identity verified (${identity.kind}). Fingerprint after worker: ${identity.fingerprintAfter}.`
      : `Source identity: unavailable — ${identity.reason}`,
    `Changed/added paths:\n${lineList([...(sourceDiff?.changed ?? []), ...(sourceDiff?.added ?? [])]) || '- (no changes detected in the scoped source identity)'}`,
    `Removed paths:\n${lineList(sourceDiff?.removed ?? []) || '- None'}`,
    changedPathsFile ? `Full changed-path evidence: ${changedPathsFile} (${sizeOf(changedPathsFile) ?? '?'} bytes)` : '',
    `Baseline file contents (including pre-existing changes): ${baselineDir ?? path.join(config.runDir, 'source-baseline')}. Compare the current delta against these contents; previous review snapshots are used for corrections with the same scope.`,
    diffFile ? `Diff/stat evidence (may be partial for untracked files): ${diffFile} (${sizeOf(diffFile) ?? '?'} bytes). Read source files directly for full context.` : 'Read the relevant source files directly under the project root.',
    '',
    `## Worker report (claims only — verify independently; exit code ${workerExitCode ?? 'unknown'}, worker status ${workerStatus})`,
    `Full report: ${workerReportPath} (${sizeOf(workerReportPath) ?? '?'} bytes)`,
    report.text,
    report.note ?? '',
    '',
    '## Test / deterministic evidence paths (read selectively)',
    verificationPath ? `Independent dispatcher verification receipt: ${verificationPath}. The dispatcher, not the worker, ran these caller-assigned commands against the fingerprinted source. Inspect their outputs and test coverage; this is independent execution evidence. Do not rerun identical checks in the read-only sandbox unless a gap or contradiction warrants it.` : '',
    testEvidence.length ? lineList(testEvidence.map(item => typeof item === 'string' ? `${item} (${sizeOf(path.resolve(config.project, item)) ?? '?'} bytes)` : JSON.stringify(item))) : '- None supplied; verify checks yourself from the report and source.',
    '',
    previousFindings.length ? [
      '## Previous unresolved findings (from the last review round)',
      'The worker was corrected for these. Re-verify each one; do not accept while any still reproduces.',
      boundInline(lineList(previousFindings.map((finding, index) => `${finding.id ?? index + 1}. ${finding.path ? `${finding.path}: ` : ''}${finding.issue}`)), 4_000, 'Previous findings').text,
      previousVerdictPath ? `Full previous verdict and all unresolved findings: ${previousVerdictPath}. Read it to verify every finding; the inline summary may be bounded.` : '',
      ''
    ].join('\n') : '',
    '## Rules',
    config.workflowVersion === 2 ? `- Current objective state: ${objectivePath}. Read the active findings and accepted contracts selectively; do not read append-only history. Reuse finding IDs for repeated defects; use null for new findings. Explicitly list resolvedFindingIds when evidence closes them. Accepted must resolve every active finding. For defects needing regression coverage, set regression to {artifact: project-relative test path, marker: exact test-case name or null, check: caller-assigned command name or null}; use null only when no regression artifact is appropriate. Never invent a command. Approved check names: ${JSON.stringify(config.verificationCommands.map(c => c.name))}.` : '',
    '- For corrections, start with the provided delta, active finding IDs and dispatcher receipts. Expand source/contract context where necessary to establish correctness. Do not reread entire large guides or old verdict/transcript wrappers; locate headings and read relevant sections. Follow applicable project instructions.',
    '- Judge only this stage against its acceptance criteria; deferred work is not a stage failure.',
    '- Independently read the relevant source and verify the needed evidence; do not trust the worker report.',
    '- A worker exit code of zero is not acceptance. Malformed or missing evidence is a finding, not a pass.',
    '- Cover each acceptance criterion in checks with concrete evidence. Accepted requires no unresolved findings and all required checks verified as pass. Use changes_required with actionable findings for defects or missing checks; do not implement the corrections yourself.',
    '- Use needs_replan only when the stage cannot be corrected by bounded feedback (architectural ambiguity or repeated failure that needs a new decision), not for ordinary defects.',
    reviewDir ? `- Record evidence paths in findings so corrections can reference them. Review transcript/events: ${reviewDir}.` : '',
    ''
  ].filter(part => part !== '').join('\n');
}

// ---------------------------------------------------------------------------
// Reviewer invocation (fresh codex exec context, never a fork/resume)
// ---------------------------------------------------------------------------

const REVIEWER_ARGV_NOTE = 'Reviewer argv contains exec with a fresh context: no fork, resume, or copied main transcript.';

export function buildReviewerArgs(config, { schemaPath, lastMessagePath }) {
  const args = ['exec', '--json',
    '--output-schema', schemaPath,
    '--output-last-message', lastMessagePath,
    '-C', config.project,
    '-m', config.reviewModel,
    '-c', `model_reasoning_effort=${config.reviewEffort}`,
    '-s', 'read-only',
    '--skip-git-repo-check',
    '--color', 'never'];
  for (const name of config.reviewDisabledMcp ?? []) {
    if (!/^[A-Za-z0-9_-]{1,100}$/.test(name)) throw new Error('This MCP name needs reviewMcpServers=inherit rather than a dotted CLI override.');
    args.push('-c', `mcp_servers.${name}.enabled=false`);
  }
  // --ephemeral is intentionally absent: it only controls session persistence,
  // it is not a cache or token optimization, and persisted review sessions
  // keep the review inspectable.
  return args;
}

/** Default transport: spawn the reviewer with argv + stdin, never a shell. */
export function spawnReviewer(config, args, { packetText, eventsPath, stderrPath }) {
  const events = fs.openSync(eventsPath, 'w');
  const err = fs.openSync(stderrPath, 'w');
  let command = config.codexExe, argv = args;
  // A .mjs/.js reviewer executable is a local/test fake run through Node.
  if (/\.(?:mjs|cjs|js)$/i.test(config.codexExe)) { command = process.execPath; argv = [config.codexExe, ...args]; }
  const env = { ...process.env };
  delete env.CODEX_THREAD_ID;
  const child = spawn(command, argv, { cwd: config.project, env, shell: false, windowsHide: true, detached: process.platform !== 'win32', stdio: ['pipe', events, err] });
  fs.closeSync(events); fs.closeSync(err);
  child.stdin.on('error', () => {}); // An early process failure is reported by close/error below.
  child.stdin.write(packetText); child.stdin.end();
  return child;
}

function waitExit(child, timeoutMs, deps) {
  return new Promise(resolve => {
    let settled = false, timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      void (deps.stopChild ?? stopOwnedWorker)(child).catch(error => finish({ code: null, error, stopUnconfirmed: child.exitCode === null && child.signalCode === null }));
    }, timeoutMs);
    const finish = result => { if (settled) return; settled = true; clearTimeout(timer); resolve({ ...result, timedOut }); };
    child.once('error', error => finish({ code: null, error }));
    child.once('close', code => finish({ code }));
  });
}

/** Execute only caller-supplied argv, never commands extracted from worker text. */
export async function runVerificationCommands(config, roundDir, deps = {}) {
  const checks = [];
  for (const [index, check] of (config.verificationCommands ?? []).entries()) {
    if (deps.isStopped?.()) break;
    const stdoutPath = path.join(roundDir, `check-${index + 1}-stdout.log`);
    const stderrPath = path.join(roundDir, `check-${index + 1}-stderr.log`);
    const out = fs.openSync(stdoutPath, 'w'), err = fs.openSync(stderrPath, 'w');
    let child;
    try { child = spawn(check.command, check.args, {cwd: path.resolve(config.project, check.cwd ?? '.'),
      shell: false, windowsHide: true, detached: process.platform !== 'win32', stdio: ['ignore', out, err]}); }
    finally { fs.closeSync(out); fs.closeSync(err); }
    deps.onSpawn?.(child);
    const exit = await waitExit(child, check.timeoutMs ?? 120_000, deps);
    if (exit.stopUnconfirmed) throw new Error('Verification process termination is unconfirmed; retain the project lock.');
    deps.onSpawn?.(null);
    checks.push({name: check.name, command: check.command, args: check.args, cwd: check.cwd ?? '.',
      exitCode: exit.code ?? null, passed: exit.code === 0 && !exit.timedOut && !exit.error,
      timedOut: exit.timedOut, error: exit.error?.message ?? null, stdoutPath, stderrPath});
  }
  return checks;
}

/**
 * One reviewer attempt. Returns a discriminated result; a malformed, absent,
 * timed-out or nonzero review is never a verdict and never accepted.
 */
export async function runReviewAttempt(config, { packetText, roundDir, attempt, timeoutMs, deps = {} }) {
  fs.mkdirSync(roundDir, { recursive: true });
  const stem = `attempt-${attempt}`;
  const packetPath = path.join(roundDir, `${stem}-packet.md`);
  const schemaPath = path.join(roundDir, `${stem}-verdict-schema.json`);
  const lastMessagePath = path.join(roundDir, `${stem}-last-message.json`);
  const eventsPath = path.join(roundDir, `${stem}-events.jsonl`);
  const stderrPath = path.join(roundDir, `${stem}-stderr.log`);
  fs.writeFileSync(packetPath, packetText);
  fs.writeFileSync(schemaPath, JSON.stringify(verdictJsonSchema(config.workflowVersion), null, 2) + '\n');
  let reviewerConfig = config;
  if (config.reviewMcpServers !== 'inherit' && !/\.(?:mjs|cjs|js)$/i.test(config.codexExe) && !deps.spawnReviewer) {
    const result = await spawnCaptured(config.codexExe, ['mcp', 'list', '--json'], { timeoutMs: 20_000 });
    if (!result.ok) throw new Error('Cannot resolve reviewer tools. Set reviewMcpServers to inherit explicitly if required.');
    const servers = JSON.parse(result.stdout);
    if (!Array.isArray(servers)) throw new Error('Unexpected Codex MCP discovery response.');
    const allowed = config.reviewMcpServers ?? [];
    reviewerConfig = { ...config, reviewDisabledMcp: servers.filter(server => server.enabled && !allowed.includes(server.name)).map(server => server.name) };
  }
  const args = buildReviewerArgs(reviewerConfig, { schemaPath, lastMessagePath });
  fs.writeFileSync(path.join(roundDir, `${stem}-invocation.json`), JSON.stringify({ model: config.reviewModel, effort: config.reviewEffort,
    argv: args, disabledMcp: reviewerConfig.reviewDisabledMcp ?? [], context: 'fresh exec; no parent task history' }, null, 2));
  const spawnFn = deps.spawnReviewer ?? spawnReviewer;
  const child = spawnFn(reviewerConfig, args, { packetText, eventsPath, stderrPath });
  deps.onSpawn?.(child);
  const exit = await waitExit(child, timeoutMs ?? config.reviewTimeoutMs, deps);
  let usage, usageReason = null;
  try { usage = parseReviewUsage(fs.readFileSync(eventsPath, 'utf8')); }
  catch (error) { usageReason = `Review events unreadable: ${error.message}`; }
  let lastMessage = null, verdict = null, parseError = null;
  try {
    lastMessage = fs.readFileSync(lastMessagePath, 'utf8');
    verdict = parseReviewVerdict(lastMessage, config.workflowVersion);
  } catch (error) { parseError = error; }
  const failed = exit.timedOut || exit.code !== 0 || !verdict;
  let failure = null;
  if (failed) {
    let message = '';
    try { message = fs.readFileSync(stderrPath, 'utf8').slice(-8_000); } catch {}
    try {
      for (const line of fs.readFileSync(eventsPath, 'utf8').split('\n')) {
        let event; try { event = JSON.parse(line); } catch { continue; }
        if (event.type === 'turn.failed' || event.type === 'error') message += '\n' + JSON.stringify(event.error ?? event.message ?? event);
      }
    } catch {}
    failure = classifyError({ message });
  }
  return { ok: !failed, args, packetPath, eventsPath, lastMessagePath, stderrPath,
    exitCode: exit.code ?? null, timedOut: exit.timedOut, stopUnconfirmed: exit.stopUnconfirmed === true,
    failure: failure?.stop ? failure : null,
    error: failed ? (parseError
      ? `Reviewer verdict unusable (${verdictWasWritten(lastMessagePath) ? 'malformed' : 'absent'}): ${parseError.message}`
      : exit.error ? `Reviewer failed to start: ${exit.error.message}`
      : exit.timedOut ? `Reviewer timed out after ${timeoutMs ?? config.reviewTimeoutMs}ms and was stopped.`
      : `Reviewer exited with code ${exit.code ?? 'unknown'} without a usable verdict.`) : null,
    usage: usage ?? null, usageReason, verdict };
}

function verdictWasWritten(lastMessagePath) { try { return fs.statSync(lastMessagePath).size > 0; } catch { return false; } }

/** Strict verdict parsing: fences tolerated, everything else must conform. */
export function parseReviewVerdict(text, version = 1) {
  let value = String(text ?? '').replace(/^\uFEFF/, '').trim();
  if (!value) throw new Error('The reviewer wrote no final message.');
  let parsed; try { parsed = JSON.parse(value); } catch (error) { throw new Error(`Reviewer final message is not JSON: ${error.message}`); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Reviewer verdict must be a JSON object.');
  if (!VERDICTS.includes(parsed.verdict)) throw new Error(`Reviewer verdict must be one of ${VERDICTS.join(', ')}.`);
  if (!Array.isArray(parsed.findings)) throw new Error('Reviewer verdict requires a findings array.');
  if (!Array.isArray(parsed.checks)) throw new Error('Reviewer verdict requires a checks array.');
  if (typeof parsed.summary !== 'string' || !parsed.summary.trim() || parsed.summary.length > 4_000) throw new Error('Reviewer verdict requires a nonempty summary up to 4000 characters.');
  const exactKeys = (object, keys) => {
    if (Object.keys(object).some(key => !keys.includes(key)) || keys.some(key => !Object.hasOwn(object, key))) throw new Error('Verdict fields must exactly match the output schema.');
  };
  const string = (value, field, empty = false) => {
    if (typeof value !== 'string' || (!empty && !value.trim()) || value.length > 2_000) throw new Error(`${field} must be a ${empty ? '' : 'nonempty '}string up to 2000 characters.`);
    return value;
  };
  exactKeys(parsed, ['verdict', 'summary', 'findings', 'checks', ...(version === 2 ? ['resolvedFindingIds'] : [])]);
  if (version === 2 && (!Array.isArray(parsed.resolvedFindingIds) || parsed.resolvedFindingIds.length > 30 || parsed.resolvedFindingIds.some(id => typeof id !== 'string' || !/^F\d{4,}$/.test(id)))) throw new Error('Invalid resolvedFindingIds.');
  if (parsed.findings.length > MAX_FINDINGS || parsed.checks.length > 30) throw new Error('Verdict exceeds the schema item bounds.');
  const findings = parsed.findings.map(finding => {
    if (!finding || typeof finding !== 'object' || Array.isArray(finding)) throw new Error('Each finding must be an object.');
    if (typeof finding.issue !== 'string' || !finding.issue.trim()) throw new Error('Each finding needs a nonempty issue.');
    exactKeys(finding, ['severity', 'path', 'issue', 'expected', 'evidence', ...(version === 2 ? ['id', 'regression'] : [])]);
    if (version === 2) {
      if (finding.id !== null && (typeof finding.id !== 'string' || !/^F\d{4,}$/.test(finding.id))) throw new Error('Invalid finding ID.');
      if (finding.regression !== null) {
        const r = finding.regression;
        if (!r || typeof r !== 'object' || Array.isArray(r)) throw new Error('Invalid regression obligation.');
        exactKeys(r, ['artifact', 'marker', 'check']); string(r.artifact, 'regression artifact');
        if (r.marker !== null) string(r.marker, 'regression marker');
        if (r.check !== null) string(r.check, 'regression check');
      }
    }
    if (!['high', 'medium', 'low'].includes(finding.severity)) throw new Error('Invalid finding severity.');
    return { ...(version === 2 ? {id: finding.id, regression: finding.regression} : {}), severity: finding.severity, path: string(finding.path, 'path', true), issue: string(finding.issue, 'issue'),
      expected: string(finding.expected, 'expected'), evidence: string(finding.evidence, 'evidence') };
  });
  const checks = parsed.checks.map(check => {
    if (!check || typeof check !== 'object' || Array.isArray(check) || typeof check.name !== 'string') throw new Error('Each check needs a name.');
    exactKeys(check, ['name', 'result', 'evidence']);
    if (!['pass', 'fail', 'not_verified'].includes(check.result)) throw new Error('Invalid check result.');
    return { name: string(check.name, 'check name'), result: check.result, evidence: string(check.evidence, 'check evidence') };
  });
  if (parsed.verdict === 'accepted' && (findings.length || !checks.length || checks.some(check => check.result !== 'pass'))) throw new Error('Accepted requires no findings and verified passing checks.');
  if (parsed.verdict === 'changes_required' && !findings.length) throw new Error('Changes required needs actionable findings.');
  return { verdict: parsed.verdict, summary: parsed.summary, findings, checks, ...(version === 2 ? {resolvedFindingIds: parsed.resolvedFindingIds} : {}) };
}

/**
 * Extract reviewer token usage from `codex exec --json` events. Each usage
 * event is counted once; unknown counters stay null with a reason.
 */
export function parseReviewUsage(jsonlText) {
  let threadId = null, turnIndex = 0, latestCumulative = null;
  const responses = new Map(), turns = new Map();
  for (const line of String(jsonlText ?? '').split('\n')) {
    let event; try { event = JSON.parse(line); } catch { continue; }
    if (!event || typeof event !== 'object') continue;
    threadId ??= event.thread_id ?? event.threadId ?? null;
    if (event.type === 'turn.started') turnIndex++;
    if (event.type === 'token_usage_record' && event.payload?.usage) responses.set(event.payload.response_id ?? `response-${responses.size}`, event.payload.usage);
    if (event.type === 'turn.completed' && event.usage) turns.set(event.turn_id ?? (turnIndex ? `turn-${turnIndex}` : `event-${turns.size}`), event.usage);
    const payload = event.type === 'event_msg' ? event.payload : event;
    if (payload?.type === 'token_count' && payload.info?.total_token_usage) latestCumulative = payload.info.total_token_usage;
  }
  const rows = responses.size ? [...responses.values()] : turns.size ? [...turns.values()] : latestCumulative ? [latestCumulative] : [];
  const number = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
  const get = (row, key) => {
    const recorded = number(row[key]);
    if (recorded != null) return recorded;
    if (key === 'cached_input_tokens') return number(row.input_tokens_details?.cached_tokens);
    if (key === 'reasoning_output_tokens') return number(row.output_tokens_details?.reasoning_tokens);
    if (key === 'total_tokens' && number(row.input_tokens) != null && number(row.output_tokens) != null) return row.input_tokens + row.output_tokens;
    return null;
  };
  const sum = key => rows.length && rows.every(row => get(row, key) != null) ? rows.reduce((n, row) => n + get(row, key), 0) : null;
  return { available: rows.length > 0, reason: rows.length ? null : 'No token usage records; usage is unknown, not zero.',
    requests: responses.size || null, completedTurns: turns.size || null, threadId,
    scope: responses.size ? 'unique responses' : turns.size ? 'completed turns' : 'latest reported cumulative total',
    inputTokens: sum('input_tokens'), cachedInputTokens: sum('cached_input_tokens'),
    outputTokens: sum('output_tokens'), reasoningTokens: sum('reasoning_output_tokens'), totalTokens: sum('total_tokens') };
}

export function aggregateReviewUsage(attempts) {
  const rows = attempts.map(attempt => attempt.usage);
  const sum = key => rows.length && rows.every(row => typeof row?.[key] === 'number') ? rows.reduce((n, row) => n + row[key], 0) : null;
  return { requests: sum('requests'), completedTurns: sum('completedTurns'), inputTokens: sum('inputTokens'),
    cachedInputTokens: sum('cachedInputTokens'), outputTokens: sum('outputTokens'), reasoningTokens: sum('reasoningTokens'),
    totalTokens: sum('totalTokens'), scope: 'all attempts in this review round' };
}

// ---------------------------------------------------------------------------
// Corrections and verdict records
// ---------------------------------------------------------------------------

const formatFinding = (finding, index) => {
  const expected = finding.expected ? ` Expected: ${finding.expected}` : '';
  const evidence = finding.evidence ? ` Evidence: ${finding.evidence}` : '';
  return `${index + 1}. [${finding.severity}] ${finding.path ? `${finding.path} — ` : ''}${finding.issue}.${expected}${evidence}`;
};

/** Compact actionable feedback routed by the script to the same worker session. */
export function buildCorrectionPrompt({ config, round, findings, assignmentPath, previousReportPath, verdictPath }) {
  const full = findings.map((finding, index) => formatFinding(finding, index)).join('\n');
  const inline = boundInline(full, 6_000, 'Correction findings excerpt');
  return [
    `Dispatch run: ${config.runId} (automatic correction round ${round} of ${config.maxAutoCorrections})`,
    '',
    'Your previous attempt needs corrections. These findings come from independent review or dispatcher verification; see the saved evidence for their origin. Fix them within the original assignment. The acceptance criteria are unchanged and remain authoritative; neither this feedback nor any report redefines them.',
    '',
    `Original assignment (reread it before editing): ${assignmentPath}`,
    previousReportPath ? `Your previous stage report (context only): ${previousReportPath}` : '',
    '',
    'Findings to fix:',
    inline.text,
    inline.note ?? '',
    verdictPath ? `Full independent verdict and every finding: ${verdictPath}. Address every finding, including any outside the inline excerpt.` : '',
    '',
    'Rules: preserve accepted behavior, pre-existing user changes and the assigned scope; do not invoke another reviewer and do not delegate; rerun the stage checks yourself and report actual results and exit codes. If a finding reveals a material wrong assumption instead of a defect, stop and report the decision needed rather than expanding scope.',
    '',
    'Return one concise Markdown final response: what you changed per finding, the checks you ran with exit codes, and any remaining problem.'
  ].filter(line => line !== '').join('\n');
}

export function buildVerdictMarkdown({ config, round, result, sourceDiff }) {
  const verdict = result.verdict;
  return [
    `# Independent review — round ${round}`,
    `Run: ${config.runId} · reviewer model ${config.reviewModel} (effort ${config.reviewEffort}) · reviewer requests: ${result.usage?.requests ?? 'unknown'}`,
    `Verdict: ${verdict.verdict}`,
    '',
    `## Summary`,
    verdict.summary || '(no summary provided)',
    '',
    verdict.findings.length ? `## Findings\n${verdict.findings.map((finding, index) => formatFinding(finding, index)).join('\n')}` : '## Findings\nNone recorded.',
    verdict.checks.length ? `\n## Checks\n${verdict.checks.map(check => `- ${check.result === 'pass' ? 'PASS' : check.result === 'fail' ? 'FAIL' : 'NOT VERIFIED'} ${check.name}${check.evidence ? ` — ${check.evidence}` : ''}`).join('\n')}` : '',
    '',
    `Source identity: ${sourceDiff?.comparable ? (sourceDiff.identical ? `unchanged during review (${sourceDiff.fingerprintAfter})` : 'CHANGED during review — this review is void') : 'unverifiable (no scoped identity)'};`,
    `Raw events: ${result.eventsPath} · last message: ${result.lastMessagePath} · packet: ${result.packetPath}`
  ].join('\n');
}
