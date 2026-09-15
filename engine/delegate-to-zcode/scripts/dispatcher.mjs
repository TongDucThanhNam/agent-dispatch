#!/usr/bin/env node
/**
 * dispatcher.mjs — tiny local integration test harness dispatcher.
 *
 * Node builtins only. Commands:
 *   node dispatcher.mjs selftest
 *   node dispatcher.mjs watch --job ID --thread ID --state-dir DIR --deadline ISO8601
 *   node dispatcher.mjs record-night --state-dir DIR --night YYYY-MM-DD
 *
 * watch polls `zc.mjs idle status JOB` every 30 seconds (a status query only —
 * no LLM invocation) until the job reports completed/failed/cancelled or the
 * deadline expires, then notifies Astra once via
 * `codex.exe queue --thread T --message M -m gpt-6-astra`. The message asks
 * Astra to read the job output and verify tests/review only — never to
 * implement or resubmit.
 *
 * Safety properties:
 *  - all CLI invocations use child_process.spawn with argument arrays,
 *    shell: false, windowsHide: true;
 *  - job output is parsed for a status keyword only; it is never executed and
 *    never forwarded verbatim into callback argv;
 *  - state is persisted atomically (temp file + rename) after every probe;
 *  - the callback result is retained in the state record: a failed callback is
 *    retried on the next watch run, a succeeded callback is never repeated;
 *  - a failed job is never reported as success;
 *  - an exclusive lock file guards the state dir; it is released on normal
 *    exit and on signals (a hard crash/reboot leaves a stale lock that must be
 *    removed by hand — see README limitations);
 *  - tests never invoke a live CLI: they inject fakes via the `deps` option.
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const ZC_CLI_PATH = 'C:\\Users\\terasumi\\AppData\\Local\\Programs\\ZCodeCLI\\zc.mjs';
export const CODEX_CLI_PATH = 'C:\\Users\\terasumi\\AppData\\Local\\Programs\\OpenAI\\Codex\\bin\\codex.exe';
export const CALLBACK_MODEL = 'gpt-6-astra';
export const POLL_INTERVAL_MS = 30_000;
export const PROBE_TIMEOUT_MS = 20_000;
export const CALLBACK_TIMEOUT_MS = 120_000;
export const TERMINAL_JOB_STATES = Object.freeze(['completed', 'failed', 'cancelled']);

const USAGE = `Usage:
  node dispatcher.mjs selftest
  node dispatcher.mjs watch --job ID --thread ID --state-dir DIR --deadline ISO8601
  node dispatcher.mjs record-night --state-dir DIR --night YYYY-MM-DD

Exit codes: 0 ok; 1 usage/validation/lock/night-taken; 3 watch ended without a
successful callback (retry on the next watch run); 130 after a signal.`;

export class HarnessError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'HarnessError';
    this.code = code ?? 'HARNESS_ERROR';
  }
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export function validateId(kind, value) {
  if (typeof value !== 'string' || !ID_RE.test(value)) {
    throw new HarnessError(
      `invalid ${kind}: must be 1-128 chars of [A-Za-z0-9._-] starting with an alphanumeric, got ${JSON.stringify(value)}`,
      'INVALID_ID',
    );
  }
  return value;
}

export function validateIsoDeadline(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T/.test(value)) {
    throw new HarnessError(`invalid deadline: expected an ISO 8601 date-time like 2026-09-10T00:00:00Z, got ${JSON.stringify(value)}`, 'INVALID_DEADLINE');
  }
  // A scheduler must not guess: require an explicit timezone (Z or ±HH:MM).
  if (!/(?:Z|[+-]\d{2}:\d{2})$/.test(value)) {
    throw new HarnessError(`invalid deadline: missing timezone; expected Z or a ±HH:MM offset: ${JSON.stringify(value)}`, 'INVALID_DEADLINE');
  }
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) {
    throw new HarnessError(`invalid deadline: not parseable as ISO 8601: ${JSON.stringify(value)}`, 'INVALID_DEADLINE');
  }
  // Engines may roll impossible dates forward (e.g. 2026-02-30 -> March);
  // reject them explicitly instead.
  const [y, m, d] = value.slice(0, 10).split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) {
    throw new HarnessError(`invalid deadline: not a real calendar date: ${value}`, 'INVALID_DEADLINE');
  }
  return ms;
}

export function validateNight(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new HarnessError(`invalid night: expected YYYY-MM-DD, got ${JSON.stringify(value)}`, 'INVALID_NIGHT');
  }
  const [y, m, d] = value.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) {
    throw new HarnessError(`invalid night: not a real calendar date: ${value}`, 'INVALID_NIGHT');
  }
  return value;
}

// ---------------------------------------------------------------------------
// Atomic persistence
// ---------------------------------------------------------------------------

/**
 * Write via temp file in the same directory + rename, so readers never see a
 * partial file. Retries once or twice on EPERM/EACCES (Windows AV lock).
 */
export function writeFileAtomic(filePath, data, retries = 3) {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  for (let attempt = 1; attempt <= retries; attempt++) {
    const tmp = path.join(
      dir,
      `.${path.basename(filePath)}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}.tmp`,
    );
    try {
      fs.writeFileSync(tmp, data);
      fs.renameSync(tmp, filePath);
      return;
    } catch (err) {
      try { fs.unlinkSync(tmp); } catch { /* best effort */ }
      if (attempt === retries || !['EPERM', 'EACCES'].includes(err.code)) throw err;
    }
  }
}

// ---------------------------------------------------------------------------
// Exclusive process lock
// ---------------------------------------------------------------------------

/**
 * Exclusive lock for a state dir: O_EXCL create of <stateDir>/watch.lock.
 * Released on normal exit and signals (see installSignalCleanup); a hard
 * crash or reboot leaves the file behind and requires manual removal.
 */
export function acquireLock(stateDir) {
  const lockPath = path.join(stateDir, 'watch.lock');
  fs.mkdirSync(stateDir, { recursive: true });
  let fd;
  try {
    fd = fs.openSync(lockPath, 'wx');
  } catch (err) {
    if (err.code === 'EEXIST') {
      let holder = 'unknown holder';
      try { holder = fs.readFileSync(lockPath, 'utf8'); } catch { /* ignore */ }
      throw new HarnessError(`watch lock already held: ${lockPath} (${holder})`, 'LOCK_HELD');
    }
    throw err;
  }
  fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, acquiredAt: new Date().toISOString() }));
  fs.closeSync(fd);
  let released = false;
  return {
    path: lockPath,
    get released() { return released; },
    release() {
      if (released) return;
      released = true;
      try { fs.unlinkSync(lockPath); } catch (err) {
        if (err.code !== 'ENOENT') throw err;
      }
    },
  };
}

/** Register lock release on exit and signals (CLI only; idempotent). */
export function installSignalCleanup(lock, log = () => {}) {
  const handler = (sig) => {
    try { lock.release(); } catch { /* best effort */ }
    log(`received ${sig}; released watch lock; exiting`);
    process.exit(130);
  };
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGBREAK', 'SIGHUP']) {
    try { process.on(sig, () => handler(sig)); } catch { /* signal unsupported */ }
  }
  process.on('exit', () => { try { lock.release(); } catch { /* best effort */ } });
}

// ---------------------------------------------------------------------------
// Status probing (spawn, parse) and callback argv builders
// ---------------------------------------------------------------------------

const MAX_CAPTURE_BYTES = 1_000_000;

/**
 * Kill a child process tree owned by this supervisor. Only call this on a
 * ChildProcess created by the calling process, never on a recovered PID.
 */
export async function stopOwnedProcessTree(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null || !child.pid) return;
  if (process.platform === 'win32') {
    const result = await spawnCaptured(path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'taskkill.exe'),
      ['/PID', String(child.pid), '/T', '/F'], { timeoutMs: 15_000 });
    if (!result.ok && child.exitCode === null && child.signalCode === null) throw new Error('The owned process could not be stopped. Its state is still uncertain.');
  } else {
    process.kill(-child.pid, 'SIGTERM');
    await new Promise((resolve) => setTimeout(resolve, 500));
    if (child.exitCode === null && child.signalCode === null) process.kill(-child.pid, 'SIGKILL');
  }
}


/**
 * Run a command to completion and capture output. Never throws; reports
 * { ok, exitCode, stdout, stderr, error? }. Kills the child after timeoutMs.
 */
export function spawnCaptured(command, args, { timeoutMs }) {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let settled = false;
    let timedOut = false;
    let child;
    try {
      child = spawn(command, args, { shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) {
      resolve({ ok: false, exitCode: null, stdout: '', stderr: '', error: `spawn failed: ${err.message}` });
      return;
    }
    const timer = setTimeout(() => {
      timedOut = true;
      try { child.kill(); } catch { /* best effort */ }
    }, timeoutMs);
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    child.stdout?.on('data', (chunk) => { if (stdout.length < MAX_CAPTURE_BYTES) stdout += chunk; });
    child.stderr?.on('data', (chunk) => { if (stderr.length < MAX_CAPTURE_BYTES) stderr += chunk; });
    child.on('error', (err) => {
      finish({ ok: false, exitCode: null, stdout, stderr, error: `spawn error: ${err.message}` });
    });
    child.on('close', (code) => {
      finish({
        ok: !timedOut && code === 0,
        exitCode: code,
        stdout,
        stderr,
        error: timedOut ? `timed out after ${timeoutMs}ms` : undefined,
      });
    });
  });
}

/** Exact argv for the zc status probe: a status query, never an LLM call. */
export function probeArgs(job) {
  return [ZC_CLI_PATH, 'idle', 'status', job];
}

/** CLI arguments for the codex callback. The executable itself is spawn's
 * `command` and must NOT be repeated as argv[0]. */
export function callbackArgs(thread, message) {
  return ['queue', '--thread', thread, '--message', message, '-m', CALLBACK_MODEL];
}

export function makeDefaultProbeRunner(zcPath = ZC_CLI_PATH) {
  return async function runProbe(job) {
    const r = await spawnCaptured(process.execPath, [zcPath, 'idle', 'status', job], { timeoutMs: PROBE_TIMEOUT_MS });
    return { ...r, status: r.ok ? parseStatusOutput(r.stdout) : undefined };
  };
}

export function makeDefaultCallbackRunner(codexPath = CODEX_CLI_PATH, spawnFn = spawnCaptured) {
  return async function runCallback(thread, message) {
    // command and argv travel separately: argv carries only the CLI arguments
    return spawnFn(codexPath, callbackArgs(thread, message), { timeoutMs: CALLBACK_TIMEOUT_MS });
  };
}

const RUNNING_SYNONYMS = new Set(['running', 'pending', 'queued', 'idle', 'in_progress', 'in-progress', 'started', 'working']);
const COMPLETED_SYNONYMS = new Set(['completed', 'succeeded', 'success', 'done', 'finished']);
const FAILED_SYNONYMS = new Set(['failed', 'failure', 'error', 'errored']);
const CANCELLED_SYNONYMS = new Set(['cancelled', 'canceled', 'cancel']);

export function normalizeStatus(raw) {
  if (typeof raw !== 'string') return undefined;
  const v = raw.trim().toLowerCase();
  if (COMPLETED_SYNONYMS.has(v)) return 'completed';
  if (FAILED_SYNONYMS.has(v)) return 'failed';
  if (CANCELLED_SYNONYMS.has(v)) return 'cancelled';
  if (RUNNING_SYNONYMS.has(v)) return 'running';
  return undefined;
}

/**
 * Extract a job status from probe stdout. Strict: the output must be a JSON
 * object carrying a status/state/jobStatus field; malformed or non-JSON
 * output and missing or unknown status values (including nonterminal ones
 * like "paused") return undefined and are treated as nonterminal. Prompt,
 * error and log text embedded in the record is never scanned for keywords,
 * so a phrase like "report completed when done" can never flip the state.
 */
export function parseStatusOutput(stdout) {
  const text = (stdout ?? '').trim();
  if (!text) return undefined;
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined; // malformed / non-JSON output is never interpreted
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;
  const raw = parsed.status ?? parsed.state ?? parsed.jobStatus ?? parsed.job_state;
  if (typeof raw !== 'string') return undefined;
  return normalizeStatus(raw);
}

/**
 * Callback message for Astra. Identifies the state and job, asks Astra to
 * read the job output and verify tests/review only — never implement or
 * resubmit. The word "success" appears only in the completed message, so a
 * failure is never notified as success.
 */
export function buildCallbackMessage({ job, thread, status, at, lastStatus, probeCount, deadline }) {
  const parts = [`[harness-dispatcher] Watch result for job "${job}" (thread "${thread}").`];
  switch (status) {
    case 'completed':
      parts.push(`Terminal state: COMPLETED (observed ${at}). The job reports success.`);
      break;
    case 'failed':
      parts.push(`Terminal state: FAILED (observed ${at}). The job reports failure.`);
      break;
    case 'cancelled':
      parts.push(`Terminal state: CANCELLED (observed ${at}). The job was cancelled before completion.`);
      break;
    case 'deadline-expired':
      parts.push(`Watch deadline ${deadline} expired at ${at} before a terminal state was observed. Last observed status: ${lastStatus ?? 'unknown'} after ${probeCount ?? 0} probe(s); the job may still be running.`);
      break;
    default:
      parts.push(`Watch ended with status ${status} at ${at}.`);
  }
  parts.push('Please read the job output and verify the tests and review results only. Do not implement changes and do not resubmit this job.');
  return parts.join(' ');
}

// ---------------------------------------------------------------------------
// Job state records
// ---------------------------------------------------------------------------

export function jobStatePath(stateDir, job) {
  return path.join(stateDir, 'jobs', `${job}.json`);
}

export function loadJobState(stateDir, job) {
  const p = jobStatePath(stateDir, job);
  let raw;
  try {
    raw = fs.readFileSync(p, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new HarnessError(`job state file ${p} is unreadable: ${err.message}`, 'STATE_CORRUPT');
  }
}

function normalizeState(state) {
  state.terminal = !!state.terminal;
  state.probeCount = state.probeCount ?? 0;
  state.status = state.status ?? 'watching';
  state.callback = state.callback ?? {};
  state.callback.attempts = Array.isArray(state.callback.attempts) ? state.callback.attempts : [];
  state.callback.succeeded = !!state.callback.succeeded;
  return state;
}

function saveJobState(stateDir, state) {
  state.updatedAt = new Date().toISOString();
  writeFileAtomic(jobStatePath(stateDir, state.job), JSON.stringify(state, null, 2));
}

async function attemptCallback(state, { runCallback, now, log }) {
  const stamp = () => new Date(now()).toISOString();
  const message = buildCallbackMessage({
    job: state.job,
    thread: state.thread,
    status: state.status,
    at: stamp(),
    lastStatus: state.lastStatus,
    probeCount: state.probeCount,
    deadline: state.deadline,
  });
  let result;
  try {
    const r = await runCallback(state.thread, message);
    result = { at: stamp(), ok: !!(r && r.ok), exitCode: r?.exitCode ?? null, error: r?.error ?? null };
  } catch (err) {
    result = { at: stamp(), ok: false, exitCode: null, error: err?.message ?? String(err) };
  }
  state.callback.attempts.push(result);
  if (result.ok) state.callback.succeeded = true;
  state.callback.lastError = result.ok ? undefined : (result.error ?? `codex exited with code ${result.exitCode}`);
  state.updatedAt = result.at;
  log(`callback attempt ${state.callback.attempts.length}: ${result.ok ? 'succeeded' : `failed (${state.callback.lastError})`}`);
  return result.ok;
}

// ---------------------------------------------------------------------------
// watch
// ---------------------------------------------------------------------------

/**
 * Watch one job until a terminal state or deadline, then notify Astra once.
 *
 * All external effects are injectable through `deps` so tests never touch a
 * live CLI:
 *   now(), sleep(ms), runProbe(job) -> {ok, status?, error?, exitCode?},
 *   runCallback(thread, message) -> {ok, exitCode?, error?},
 *   acquireLock(stateDir), log(msg), onLock(lock).
 *
 * Returns { outcome, state } where outcome is one of:
 *   'notified' | 'notified-on-retry' | 'already-notified' |
 *   'deadline-notified' | 'callback-failed'.
 */
export async function runWatch(options) {
  const { job, thread, stateDir, deadline, pollIntervalMs = POLL_INTERVAL_MS, deps = {} } = options ?? {};
  validateId('job', job);
  validateId('thread', thread);
  const deadlineMs = validateIsoDeadline(deadline);
  if (typeof stateDir !== 'string' || stateDir.trim() === '') {
    throw new HarnessError('stateDir must be a non-empty string', 'INVALID_ARG');
  }
  if (!Number.isFinite(pollIntervalMs) || pollIntervalMs <= 0) {
    throw new HarnessError('pollIntervalMs must be a positive number', 'INVALID_ARG');
  }

  const now = deps.now ?? (() => Date.now());
  const sleep = deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const runProbe = deps.runProbe ?? makeDefaultProbeRunner();
  const runCallback = deps.runCallback ?? makeDefaultCallbackRunner();
  const acquire = deps.acquireLock ?? acquireLock;
  const log = deps.log ?? (() => {});
  const onLock = deps.onLock ?? (() => {});

  fs.mkdirSync(path.join(stateDir, 'jobs'), { recursive: true });
  fs.mkdirSync(path.join(stateDir, 'nights'), { recursive: true });

  const lock = acquire(stateDir);
  onLock(lock);
  try {
    let state = loadJobState(stateDir, job);
    if (state) {
      if (state.thread !== thread) {
        throw new HarnessError(
          `existing state for job "${job}" belongs to thread "${state.thread}", requested "${thread}"`,
          'THREAD_MISMATCH',
        );
      }
      state = normalizeState(state);
      if (state.deadline !== deadline && !state.terminal) {
        state.deadline = deadline;
        log(`deadline updated to ${deadline}`);
      }
    } else {
      if (deadlineMs <= now()) {
        throw new HarnessError(`deadline ${deadline} is already in the past; refusing to start a new watch`, 'DEADLINE_IN_PAST');
      }
      state = normalizeState({
        job,
        thread,
        deadline,
        status: 'watching',
        terminal: false,
        createdAt: new Date(now()).toISOString(),
        probeCount: 0,
        callback: { attempts: [], succeeded: false },
      });
      saveJobState(stateDir, state);
    }

    // Already terminal from a previous run: only the callback may be pending.
    if (state.terminal) {
      if (state.callback.succeeded) {
        log(`job "${job}" already terminal (${state.status}) and callback already succeeded; nothing to do`);
        return { outcome: 'already-notified', state };
      }
      const ok = await attemptCallback(state, { runCallback, now, log });
      saveJobState(stateDir, state);
      return { outcome: ok ? 'notified-on-retry' : 'callback-failed', state };
    }

    let status;
    for (;;) {
      if (now() >= deadlineMs) {
        status = 'deadline-expired';
        break;
      }
      state.probeCount += 1;
      const r = await runProbe(job);
      state.lastProbeAt = new Date(now()).toISOString();
      state.lastProbeOk = !!r?.ok;
      log(`probe ${state.probeCount}: ${r?.ok ? (r.status ?? 'no recognizable status') : `transient error: ${r?.error ?? `exit code ${r?.exitCode ?? 'null'}`}`}`);
      if (r?.ok && TERMINAL_JOB_STATES.includes(r.status)) {
        state.lastStatus = r.status;
        state.lastProbeError = undefined;
        status = r.status;
        break;
      }
      if (r?.ok) {
        state.lastProbeError = undefined;
        state.lastStatus = r.status ?? 'unknown';
      } else {
        // Transient probe failure: record it and keep retrying within deadline.
        state.lastProbeError = r?.error ?? `probe exited with code ${r?.exitCode ?? 'null'}`;
        state.lastStatus = state.lastStatus ?? 'unknown';
      }
      saveJobState(stateDir, state); // atomic status persistence after every probe
      const remaining = deadlineMs - now();
      if (remaining <= 0) {
        status = 'deadline-expired';
        break;
      }
      await sleep(Math.min(pollIntervalMs, remaining));
    }

    state.status = status;
    state.terminal = true;
    state.terminalAt = new Date(now()).toISOString();
    saveJobState(stateDir, state);

    let callbackOk = true;
    if (!state.callback.succeeded) {
      callbackOk = await attemptCallback(state, { runCallback, now, log });
      saveJobState(stateDir, state);
    }
    const outcome = !callbackOk
      ? 'callback-failed'
      : (status === 'deadline-expired' ? 'deadline-notified' : 'notified');
    log(`watch finished: status=${state.status} outcome=${outcome} probes=${state.probeCount} callbackAttempts=${state.callback.attempts.length}`);
    return { outcome, state };
  } finally {
    lock.release();
  }
}

// ---------------------------------------------------------------------------
// record-night
// ---------------------------------------------------------------------------

/**
 * Reserve a night: at most one reservation per date, enforced atomically via
 * O_EXCL file creation (nights/<date>.json). Purely local — no ZCode task is
 * submitted here. Throws HarnessError 'NIGHT_TAKEN' on a duplicate.
 */
export function recordNight({ stateDir, night, deps = {} }) {
  validateNight(night);
  if (typeof stateDir !== 'string' || stateDir.trim() === '') {
    throw new HarnessError('stateDir must be a non-empty string', 'INVALID_ARG');
  }
  const now = deps.now ?? (() => Date.now());
  const nightsDir = path.join(stateDir, 'nights');
  fs.mkdirSync(nightsDir, { recursive: true });
  const file = path.join(nightsDir, `${night}.json`);
  let fd;
  try {
    fd = fs.openSync(file, 'wx');
  } catch (err) {
    if (err.code === 'EEXIST') {
      throw new HarnessError(`night ${night} is already reserved (${file})`, 'NIGHT_TAKEN');
    }
    throw err;
  }
  try {
    fs.writeFileSync(fd, JSON.stringify({ night, reservedAt: new Date(now()).toISOString(), pid: process.pid }, null, 2));
  } finally {
    fs.closeSync(fd);
  }
  return { night, file };
}

// ---------------------------------------------------------------------------
// selftest
// ---------------------------------------------------------------------------

function expectThrow(fn, matcher) {
  let threw = null;
  try {
    fn();
  } catch (err) {
    threw = err;
  }
  if (!threw) throw new Error('expected function to throw, but it returned');
  if (matcher && !matcher.test?.(threw.message) && threw.code !== matcher) {
    throw new Error(`threw unexpected error: ${threw.message}`);
  }
}

export async function runSelfTest(log = () => {}) {
  const withTempDir = (fn) => async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatcher-selftest-'));
    try {
      await fn(dir);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  };

  const checks = [
    ['id validation', () => {
      validateId('job', 'job-1');
      validateId('thread', 'th_2.x');
      expectThrow(() => validateId('job', '../escape'));
      expectThrow(() => validateId('job', ''));
      expectThrow(() => validateId('job', 'has space'));
      expectThrow(() => validateId('job', `a${'b'.repeat(200)}`));
    }],
    ['deadline and night validation', () => {
      validateIsoDeadline('2026-09-10T00:00:00Z');
      validateIsoDeadline('2026-09-10T00:00:00+07:00');
      validateIsoDeadline('2024-02-29T00:00:00Z');
      expectThrow(() => validateIsoDeadline('2026-09-10'), 'INVALID_DEADLINE');
      expectThrow(() => validateIsoDeadline('2026-09-10T00:00:00'), 'INVALID_DEADLINE');
      expectThrow(() => validateIsoDeadline('2026-02-30T00:00:00Z'), 'INVALID_DEADLINE');
      expectThrow(() => validateIsoDeadline('2026-13-01T00:00:00Z'), 'INVALID_DEADLINE');
      expectThrow(() => validateIsoDeadline('tomorrow'), 'INVALID_DEADLINE');
      validateNight('2026-09-09');
      validateNight('2024-02-29');
      expectThrow(() => validateNight('2026-02-30'), 'INVALID_NIGHT');
      expectThrow(() => validateNight('2026-13-01'), 'INVALID_NIGHT');
      expectThrow(() => validateNight('09-09-2026'), 'INVALID_NIGHT');
    }],
    ['atomic write', withTempDir(async (dir) => {
      const file = path.join(dir, 'state.json');
      writeFileAtomic(file, '{"v":1}');
      assertEqual(fs.readFileSync(file, 'utf8'), '{"v":1}');
      writeFileAtomic(file, '{"v":2}');
      assertEqual(fs.readFileSync(file, 'utf8'), '{"v":2}');
      const leftovers = fs.readdirSync(dir).filter((f) => f.endsWith('.tmp'));
      assertEqual(leftovers.length, 0, `tmp leftovers: ${leftovers.join(', ')}`);
    })],
    ['exclusive lock', withTempDir(async (dir) => {
      const lock = acquireLock(dir);
      expectThrow(() => acquireLock(dir), 'LOCK_HELD');
      lock.release();
      const again = acquireLock(dir);
      again.release();
    })],
    ['strict status parsing', () => {
      assertEqual(parseStatusOutput('{"status":"completed"}'), 'completed');
      assertEqual(parseStatusOutput('{"state":"canceled"}'), 'cancelled');
      assertEqual(parseStatusOutput('{"jobStatus":"Running"}'), 'running');
      // paused is nonterminal even when the embedded prompt mentions outcomes
      assertEqual(parseStatusOutput(JSON.stringify({ status: 'paused', prompt: 'Report completed when done' })), undefined);
      assertEqual(parseStatusOutput(JSON.stringify({ status: 'paused', prompt: 'it failed and was cancelled before' })), undefined);
      assertEqual(parseStatusOutput('{"status":"weird"}'), undefined);
      assertEqual(parseStatusOutput('{"job":"job-1"}'), undefined);
      // malformed / non-JSON output is never interpreted
      assertEqual(parseStatusOutput(''), undefined);
      assertEqual(parseStatusOutput('job failed'), undefined);
      assertEqual(parseStatusOutput('{"status": "completed"'), undefined);
    }],
    ['callback messages', () => {
      const base = { job: 'job-1', thread: 'th-1', at: '2026-09-09T00:00:00Z' };
      const ok = buildCallbackMessage({ ...base, status: 'completed' });
      if (!/success/.test(ok)) throw new Error('completed message should report success');
      for (const status of ['failed', 'cancelled', 'deadline-expired']) {
        const msg = buildCallbackMessage({ ...base, status, lastStatus: 'running', probeCount: 2, deadline: '2026-09-10T00:00:00Z' });
        if (/success/i.test(msg)) throw new Error(`${status} message must never notify success`);
        if (!msg.includes('job-1') || !msg.includes('th-1')) throw new Error('message must identify job and thread');
        if (!/verify the tests and review results only/.test(msg)) throw new Error('message must scope Astra to verification');
        if (!/Do not implement changes and do not resubmit/.test(msg)) throw new Error('message must forbid implement/resubmit');
      }
    }],
    ['night reservation', withTempDir(async (dir) => {
      const first = recordNight({ stateDir: dir, night: '2026-09-09' });
      if (!fs.existsSync(first.file)) throw new Error('reservation file missing');
      expectThrow(() => recordNight({ stateDir: dir, night: '2026-09-09' }), 'NIGHT_TAKEN');
      const other = recordNight({ stateDir: dir, night: '2026-09-10' });
      if (other.file === first.file) throw new Error('distinct nights must use distinct files');
    })],
    ['watch end-to-end with injected fakes', withTempDir(async (dir) => {
      const start = 1_700_000_000_000;
      let t = start;
      let callbacks = 0;
      const { outcome } = await runWatch({
        job: 'selftest-job',
        thread: 'selftest-thread',
        stateDir: dir,
        deadline: new Date(start + 600_000).toISOString(),
        deps: {
          now: () => t,
          sleep: async (ms) => { t += ms; },
          runProbe: async () => ({ ok: true, status: 'completed' }),
          runCallback: async () => { callbacks += 1; return { ok: true, exitCode: 0 }; },
        },
      });
      assertEqual(outcome, 'notified');
      assertEqual(callbacks, 1);
      const state = loadJobState(dir, 'selftest-job');
      assertEqual(state.callback.succeeded, true);
    })],
  ];

  let failed = 0;
  for (const [name, fn] of checks) {
    try {
      await fn();
      log(`PASS ${name}`);
    } catch (err) {
      failed += 1;
      log(`FAIL ${name}: ${err?.message ?? err}`);
    }
  }
  log(failed === 0 ? 'selftest: all checks passed' : `selftest: ${failed} check(s) FAILED`);
  return failed === 0 ? 0 : 1;
}

function assertEqual(actual, expected, message) {
  if (actual !== expected) {
    throw new Error(message ?? `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function parseFlags(argv, requiredKeys) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('--')) {
      throw new HarnessError(`unexpected argument: ${arg}\n${USAGE}`, 'USAGE');
    }
    const key = arg.slice(2);
    const value = argv[++i];
    if (value === undefined || value.startsWith('--')) {
      throw new HarnessError(`missing value for --${key}\n${USAGE}`, 'USAGE');
    }
    out[key] = value;
  }
  for (const key of requiredKeys) {
    if (!(key in out)) {
      throw new HarnessError(`missing required option --${key}\n${USAGE}`, 'USAGE');
    }
  }
  const known = new Set(requiredKeys);
  for (const key of Object.keys(out)) {
    if (!known.has(key)) {
      throw new HarnessError(`unknown option --${key}\n${USAGE}`, 'USAGE');
    }
  }
  return out;
}

async function cmdWatch(argv) {
  const flags = parseFlags(argv, ['job', 'thread', 'state-dir', 'deadline']);
  const job = validateId('job', flags.job);
  const thread = validateId('thread', flags.thread);
  validateIsoDeadline(flags.deadline);
  const { outcome, state } = await runWatch({
    job,
    thread,
    stateDir: flags['state-dir'],
    deadline: flags.deadline,
    deps: {
      log: (m) => console.log(`[watch] ${m}`),
      onLock: (lock) => installSignalCleanup(lock, (m) => console.error(`[watch] ${m}`)),
    },
  });
  console.log(`[watch] done: outcome=${outcome} status=${state.status} probes=${state.probeCount} callbackAttempts=${state.callback.attempts.length} callbackSucceeded=${state.callback.succeeded}`);
  return state.callback.succeeded ? 0 : 3;
}

function cmdRecordNight(argv) {
  const flags = parseFlags(argv, ['state-dir', 'night']);
  const night = validateNight(flags.night);
  const r = recordNight({ stateDir: flags['state-dir'], night });
  console.log(`[record-night] reserved night ${r.night} -> ${r.file}`);
  return 0;
}

export async function main(argv = []) {
  const [cmd, ...rest] = argv;
  try {
    switch (cmd) {
      case 'selftest':
        return await runSelfTest((m) => console.log(m));
      case 'watch':
        return await cmdWatch(rest);
      case 'record-night':
        return cmdRecordNight(rest);
      case 'help':
      case '--help':
      case '-h':
        console.log(USAGE);
        return 0;
      default:
        console.error(USAGE);
        return 1;
    }
  } catch (err) {
    console.error(`error${err?.code ? ` [${err.code}]` : ''}: ${err?.message ?? err}`);
    return 1;
  }
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isMain) {
  main(process.argv.slice(2)).then(
    (code) => { process.exitCode = code; },
    (err) => {
      console.error(`fatal: ${err?.stack ?? err}`);
      process.exitCode = 1;
    },
  );
}
