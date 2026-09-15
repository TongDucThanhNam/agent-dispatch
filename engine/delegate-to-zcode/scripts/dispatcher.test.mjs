/**
 * node:test suite for dispatcher.mjs. Fully hermetic: every external effect
 * (status probe, codex callback, clock, sleep) is injected — no live CLI is
 * ever invoked.
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  acquireLock,
  buildCallbackMessage,
  callbackArgs,
  CALLBACK_MODEL,
  CODEX_CLI_PATH,
  HarnessError,
  loadJobState,
  makeDefaultCallbackRunner,
  parseStatusOutput,
  probeArgs,
  recordNight,
  runWatch,
  spawnCaptured,
  validateId,
  validateIsoDeadline,
  validateNight,
  writeFileAtomic,
  ZC_CLI_PATH,
} from './dispatcher.mjs';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeStateDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'dispatcher-test-'));
}

function withStateDir(fn) {
  return async () => {
    const dir = makeStateDir();
    try {
      await fn(dir);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  };
}

function fakeClock(start = 1_700_000_000_000) {
  let t = start;
  return {
    now: () => t,
    advance: (ms) => { t += ms; },
    value: () => t,
    start,
  };
}

function fakeDeps({ probes = [], callbackResults = [], clock = fakeClock() } = {}) {
  const calls = { probeJobs: [], probeCount: 0, callbackCount: 0, callbackMessages: [] };
  let p = 0;
  let c = 0;
  return {
    calls,
    clock,
    deps: {
      now: clock.now,
      sleep: async (ms) => clock.advance(ms),
      runProbe: async (job) => {
        calls.probeCount += 1;
        calls.probeJobs.push(job);
        const item = probes[Math.min(p, probes.length - 1)];
        p += 1;
        if (item?.throw) throw item.throw;
        return item;
      },
      runCallback: async (thread, message) => {
        calls.callbackCount += 1;
        calls.callbackMessages.push({ thread, message });
        const item = callbackResults[Math.min(c, callbackResults.length - 1)];
        c += 1;
        if (item?.throw) throw item.throw;
        return item;
      },
    },
  };
}

const PROBE_RUNNING = { ok: true, status: 'running', stdout: '{"status":"running"}' };
const probeTerminal = (status) => ({ ok: true, status, stdout: `{"status":"${status}"}` });
const CB_OK = { ok: true, exitCode: 0, stdout: 'queued' };
const cbFail = (error, exitCode = 1) => ({ ok: false, exitCode, error });

// ---------------------------------------------------------------------------
// Argument validation
// ---------------------------------------------------------------------------

describe('argument validation', () => {
  test('rejects invalid job and thread ids', () => {
    validateId('job', 'job-1');
    validateId('thread', 'th_2.x');
    for (const bad of ['', '../escape', 'has space', 'a'.repeat(200), 'semi;colon']) {
      assert.throws(() => validateId('job', bad), HarnessError);
      assert.throws(() => validateId('thread', bad), HarnessError);
    }
  });

  test('rejects invalid deadlines and nights with stable error codes', () => {
    validateIsoDeadline('2026-09-10T00:00:00Z');
    validateIsoDeadline('2026-09-10T00:00:00+07:00');
    validateIsoDeadline('2026-09-10T00:00:00.123Z');
    validateIsoDeadline('2024-02-29T00:00:00Z'); // leap day
    const badDeadline = (v) => assert.throws(
      () => validateIsoDeadline(v),
      (err) => err instanceof HarnessError && err.code === 'INVALID_DEADLINE',
    );
    badDeadline('2026-09-10'); // date only
    badDeadline('2026-09-10T00:00:00'); // missing timezone — ambiguous for a scheduler
    badDeadline('2026-02-30T00:00:00Z'); // impossible calendar date (engines roll it forward)
    badDeadline('2026-13-01T00:00:00Z'); // month 13
    badDeadline('2025-02-29T00:00:00Z'); // non-leap year
    badDeadline('tomorrow');

    validateNight('2026-09-09');
    validateNight('2024-02-29');
    const badNight = (v) => assert.throws(
      () => validateNight(v),
      (err) => err instanceof HarnessError && err.code === 'INVALID_NIGHT',
    );
    badNight('2026-02-30'); // non-calendar dates reject with INVALID_NIGHT
    badNight('2026-13-01');
    badNight('09-09-2026'); // format-level rejection carries the same code
  });

  test(
    'refuses a brand-new watch whose deadline is already in the past',
    withStateDir(async (dir) => {
      const clock = fakeClock();
      const { deps } = fakeDeps({ probes: [probeTerminal('completed')], callbackResults: [CB_OK], clock });
      await assert.rejects(
        runWatch({
          job: 'job-1', thread: 'th-1', stateDir: dir,
          deadline: new Date(clock.value() - 1_000).toISOString(), deps,
        }),
        /deadline .* is already in the past/,
      );
    }),
  );

  test(
    'rejects a retry run whose thread differs from the recorded one',
    withStateDir(async (dir) => {
      const start = fakeClock().start;
      const first = fakeDeps({ probes: [probeTerminal('failed')], callbackResults: [CB_OK] });
      await runWatch({
        job: 'job-1', thread: 'th-1', stateDir: dir,
        deadline: new Date(start + 600_000).toISOString(), deps: first.deps,
      });
      const second = fakeDeps({ callbackResults: [CB_OK] });
      await assert.rejects(
        runWatch({
          job: 'job-1', thread: 'th-2', stateDir: dir,
          deadline: new Date(start + 600_000).toISOString(), deps: second.deps,
        }),
        (err) => err instanceof HarnessError && err.code === 'THREAD_MISMATCH',
      );
    }),
  );
});

// ---------------------------------------------------------------------------
// Terminal states and callback message contract
// ---------------------------------------------------------------------------

describe('watch terminal states', () => {
  const deadline = new Date(fakeClock().start + 600_000).toISOString();

  test(
    'completed: notifies once with a success-identifying message and persists the result',
    withStateDir(async (dir) => {
      const { deps, calls } = fakeDeps({
        probes: [PROBE_RUNNING, probeTerminal('completed')],
        callbackResults: [CB_OK],
      });
      const { outcome, state } = await runWatch({ job: 'job-1', thread: 'th-1', stateDir: dir, deadline, deps });
      assert.equal(outcome, 'notified');
      assert.equal(calls.callbackCount, 1);
      const msg = calls.callbackMessages[0];
      assert.equal(msg.thread, 'th-1');
      assert.match(msg.message, /COMPLETED/);
      assert.match(msg.message, /job-1/);
      assert.match(msg.message, /verify the tests and review results only/);
      assert.match(msg.message, /Do not implement changes and do not resubmit/);
      assert.equal(state.status, 'completed');
      assert.equal(state.terminal, true);

      const persisted = loadJobState(dir, 'job-1');
      assert.equal(persisted.callback.succeeded, true);
      assert.equal(persisted.callback.attempts.length, 1);
      assert.equal(persisted.callback.attempts[0].ok, true);
      assert.ok(persisted.callback.attempts[0].at);
    }),
  );

  test(
    'failed: notifies failure and never uses success wording',
    withStateDir(async (dir) => {
      const { deps, calls } = fakeDeps({ probes: [probeTerminal('failed')], callbackResults: [CB_OK] });
      const { outcome, state } = await runWatch({ job: 'job-1', thread: 'th-1', stateDir: dir, deadline, deps });
      assert.equal(outcome, 'notified');
      assert.equal(state.status, 'failed');
      const msg = calls.callbackMessages[0].message;
      assert.match(msg, /FAILED/);
      assert.doesNotMatch(msg, /success/i);
    }),
  );

  test(
    'cancelled: notifies cancellation and never uses success wording',
    withStateDir(async (dir) => {
      const { deps, calls } = fakeDeps({ probes: [probeTerminal('cancelled')], callbackResults: [CB_OK] });
      const { outcome, state } = await runWatch({ job: 'job-1', thread: 'th-1', stateDir: dir, deadline, deps });
      assert.equal(outcome, 'notified');
      assert.equal(state.status, 'cancelled');
      const msg = calls.callbackMessages[0].message;
      assert.match(msg, /CANCELLED/);
      assert.doesNotMatch(msg, /success/i);
    }),
  );
});

// ---------------------------------------------------------------------------
// Deadline expiration
// ---------------------------------------------------------------------------

describe('watch deadline', () => {
  test(
    'expires while running, notifies deadline-expired, never claims success',
    withStateDir(async (dir) => {
      const { deps, calls } = fakeDeps({ probes: [PROBE_RUNNING], callbackResults: [CB_OK] });
      // 65s window, 30s poll: probes at t=0, 30s, 60s; expiry at t=65s.
      const deadline = new Date(fakeClock().start + 65_000).toISOString();
      const { outcome, state } = await runWatch({ job: 'job-1', thread: 'th-1', stateDir: dir, deadline, deps });
      assert.equal(outcome, 'deadline-notified');
      assert.equal(state.status, 'deadline-expired');
      assert.equal(state.terminal, true);
      assert.equal(calls.probeCount, 3);
      const msg = calls.callbackMessages[0].message;
      assert.match(msg, /expired/);
      assert.match(msg, /deadline 2026|Watch deadline/);
      assert.match(msg, /may still be running/);
      assert.match(msg, /job-1/);
      assert.doesNotMatch(msg, /success/i);
      const persisted = loadJobState(dir, 'job-1');
      assert.equal(persisted.status, 'deadline-expired');
      assert.equal(persisted.callback.succeeded, true);
    }),
  );
});

// ---------------------------------------------------------------------------
// Callback retry and deduplication
// ---------------------------------------------------------------------------

describe('callback retry and deduplication', () => {
  const start = fakeClock().start;
  const deadline = new Date(start + 600_000).toISOString();

  test(
    'failed callback is recorded, retried on the next run without re-probing, then deduplicated',
    withStateDir(async (dir) => {
      // Run 1: terminal reached, callback fails.
      const run1 = fakeDeps({ probes: [probeTerminal('completed')], callbackResults: [cbFail('codex queue unavailable')] });
      const r1 = await runWatch({ job: 'job-1', thread: 'th-1', stateDir: dir, deadline, deps: run1.deps });
      assert.equal(r1.outcome, 'callback-failed');
      assert.equal(r1.state.callback.succeeded, false);
      assert.equal(r1.state.callback.attempts.length, 1);
      assert.match(r1.state.callback.lastError, /codex queue unavailable/);

      // Run 2: no probe at all (state already terminal), callback succeeds.
      let probeCalled = false;
      const run2 = fakeDeps({ callbackResults: [CB_OK] });
      run2.deps.runProbe = async () => { probeCalled = true; return probeTerminal('completed'); };
      const r2 = await runWatch({ job: 'job-1', thread: 'th-1', stateDir: dir, deadline, deps: run2.deps });
      assert.equal(r2.outcome, 'notified-on-retry');
      assert.equal(probeCalled, false, 'a terminal job must not be probed again');
      assert.equal(r2.state.callback.attempts.length, 2);
      assert.equal(r2.state.callback.succeeded, true);

      // Run 3: successful callback is never repeated.
      let callbackCalled = false;
      const run3 = fakeDeps({ callbackResults: [] });
      run3.deps.runCallback = async () => { callbackCalled = true; return CB_OK; };
      const r3 = await runWatch({ job: 'job-1', thread: 'th-1', stateDir: dir, deadline, deps: run3.deps });
      assert.equal(r3.outcome, 'already-notified');
      assert.equal(callbackCalled, false, 'a succeeded callback must not repeat');
      assert.equal(loadJobState(dir, 'job-1').callback.attempts.length, 2);
    }),
  );

  test(
    'a deadline-expired job also retries a failed callback on the next run',
    withStateDir(async (dir) => {
      const dl = new Date(start + 65_000).toISOString();
      const run1 = fakeDeps({ probes: [PROBE_RUNNING], callbackResults: [cbFail('transient spawn error')] });
      const r1 = await runWatch({ job: 'job-1', thread: 'th-1', stateDir: dir, deadline: dl, deps: run1.deps });
      assert.equal(r1.outcome, 'callback-failed');
      assert.equal(r1.state.status, 'deadline-expired');

      const run2 = fakeDeps({ callbackResults: [CB_OK] });
      const r2 = await runWatch({ job: 'job-1', thread: 'th-1', stateDir: dir, deadline: dl, deps: run2.deps });
      assert.equal(r2.outcome, 'notified-on-retry');
      assert.equal(r2.state.callback.succeeded, true);
    }),
  );
});

// ---------------------------------------------------------------------------
// Transient probe failures
// ---------------------------------------------------------------------------

describe('transient probe failures', () => {
  test(
    'are recorded, persisted after each probe, and retried until a terminal state arrives',
    withStateDir(async (dir) => {
      let sawPersistedFailure = false;
      const blip = { ok: false, exitCode: null, error: 'spawn error: EBUSY' };
      const probes = [
        PROBE_RUNNING,
        blip,
        // On the next probe, the state file on disk must already retain the
        // failed probe (atomic persistence after every probe).
        {
          get ok() { return true; },
          status: 'completed',
          stdout: '{"status":"completed"}',
        },
      ];
      const { deps, calls } = fakeDeps({ probes, callbackResults: [CB_OK] });
      const realRunProbe = deps.runProbe;
      deps.runProbe = async (job) => {
        const result = await realRunProbe(job);
        if (calls.probeCount === 3) {
          const persisted = loadJobState(dir, 'job-1');
          sawPersistedFailure = persisted.probeCount === 2
            && persisted.lastProbeOk === false
            && persisted.lastProbeError === 'spawn error: EBUSY';
        }
        return result;
      };
      const deadline = new Date(fakeClock().start + 600_000).toISOString();
      const { outcome, state } = await runWatch({ job: 'job-1', thread: 'th-1', stateDir: dir, deadline, deps });
      assert.equal(outcome, 'notified');
      assert.equal(calls.probeCount, 3);
      assert.equal(state.probeCount, 3);
      assert.equal(state.lastProbeOk, true);
      assert.equal(state.lastProbeError, undefined);
      assert.equal(sawPersistedFailure, true, 'failed probe must be persisted before the next probe runs');
    }),
  );
});

// ---------------------------------------------------------------------------
// Exclusive lock
// ---------------------------------------------------------------------------

describe('exclusive lock', () => {
  test(
    'blocks a second concurrent watcher and is released for the next run',
    withStateDir(async (dir) => {
      const lock = acquireLock(dir);
      assert.match(fs.readFileSync(lock.path, 'utf8'), /"pid"/);
      assert.throws(() => acquireLock(dir), (err) => err instanceof HarnessError && err.code === 'LOCK_HELD');

      const { deps } = fakeDeps({ probes: [probeTerminal('completed')], callbackResults: [CB_OK] });
      await assert.rejects(
        runWatch({
          job: 'job-1', thread: 'th-1', stateDir: dir,
          deadline: new Date(fakeClock().start + 600_000).toISOString(), deps,
        }),
        /watch lock already held/,
      );

      lock.release();
      const { outcome } = await runWatch({
        job: 'job-1', thread: 'th-1', stateDir: dir,
        deadline: new Date(fakeClock().start + 600_000).toISOString(), deps,
      });
      assert.equal(outcome, 'notified');
      assert.equal(fs.existsSync(lock.path), false, 'lock file must be cleaned up');
    }),
  );
});

// ---------------------------------------------------------------------------
// record-night
// ---------------------------------------------------------------------------

describe('record-night', () => {
  test(
    'allows exactly one reservation per date and rejects duplicates',
    withStateDir(async (dir) => {
      const first = recordNight({ stateDir: dir, night: '2026-09-09' });
      assert.equal(first.night, '2026-09-09');
      const stored = JSON.parse(fs.readFileSync(first.file, 'utf8'));
      assert.equal(stored.night, '2026-09-09');
      assert.ok(stored.reservedAt);

      assert.throws(() => recordNight({ stateDir: dir, night: '2026-09-09' }),
        (err) => err instanceof HarnessError && err.code === 'NIGHT_TAKEN');
      // Duplicate attempt must not overwrite the original record.
      const after = JSON.parse(fs.readFileSync(first.file, 'utf8'));
      assert.equal(after.reservedAt, stored.reservedAt);
    }),
  );

  test(
    'allows distinct nights independently',
    withStateDir(async (dir) => {
      recordNight({ stateDir: dir, night: '2026-09-09' });
      recordNight({ stateDir: dir, night: '2026-09-10' });
      const nights = fs.readdirSync(path.join(dir, 'nights')).sort();
      assert.deepEqual(nights, ['2026-09-09.json', '2026-09-10.json']);
      assert.throws(() => recordNight({ stateDir: dir, night: '2026-09-10' }), /already reserved/);
    }),
  );
});

// ---------------------------------------------------------------------------
// Unit-level checks: parsing, argv builders, atomic write, messages
// ---------------------------------------------------------------------------

describe('status parsing and argv builders', () => {
  test('parseStatusOutput: strict JSON status fields only, never prompt or log text', () => {
    // normal records
    assert.equal(parseStatusOutput('{"status":"completed"}'), 'completed');
    assert.equal(parseStatusOutput('{"status":"failed"}'), 'failed');
    assert.equal(parseStatusOutput('{"status":"cancelled"}'), 'cancelled');
    assert.equal(parseStatusOutput('{"state":"canceled"}'), 'cancelled');
    assert.equal(parseStatusOutput('{"jobStatus":"Running"}'), 'running');
    // paused is nonterminal, even when the embedded prompt mentions outcomes
    assert.equal(
      parseStatusOutput(JSON.stringify({ status: 'paused', prompt: 'Report completed when done' })),
      undefined,
    );
    assert.equal(
      parseStatusOutput(JSON.stringify({ status: 'paused', prompt: 'the job failed and was cancelled earlier' })),
      undefined,
    );
    assert.equal(parseStatusOutput(JSON.stringify({ status: 'warming-up', prompt: 'aim for success' })), undefined);
    // unknown or missing status
    assert.equal(parseStatusOutput('{"status":"weird-value"}'), undefined);
    assert.equal(parseStatusOutput('{"job":"job-1"}'), undefined);
    assert.equal(parseStatusOutput('{"status":123}'), undefined);
    // malformed / non-JSON output is rejected instead of keyword-scanned
    assert.equal(parseStatusOutput(''), undefined);
    assert.equal(parseStatusOutput('plain text: job completed'), undefined);
    assert.equal(parseStatusOutput('job failed'), undefined);
    assert.equal(parseStatusOutput('retry did not succeed, failed twice'), undefined);
    assert.equal(parseStatusOutput('{"status": "completed"'), undefined); // truncated JSON
    assert.equal(parseStatusOutput('[{"status":"completed"}]'), undefined); // not an object
    assert.equal(parseStatusOutput('null'), undefined);
  });

  test('callbackArgs carry only CLI arguments; the executable is spawn command', () => {
    assert.deepEqual(probeArgs('job-1'), [ZC_CLI_PATH, 'idle', 'status', 'job-1']);
    assert.deepEqual(
      callbackArgs('th-1', 'hello'),
      ['queue', '--thread', 'th-1', '--message', 'hello', '-m', CALLBACK_MODEL],
    );
  });

  test('default callback runner composes command and argv without duplicating the executable', async () => {
    const observed = [];
    const runner = makeDefaultCallbackRunner(CODEX_CLI_PATH, async (command, args, opts) => {
      observed.push({ command, args, opts });
      return { ok: true, exitCode: 0 };
    });
    const r = await runner('th-1', 'hello');
    assert.equal(r.ok, true);
    assert.equal(observed.length, 1);
    assert.equal(observed[0].command, CODEX_CLI_PATH);
    assert.deepEqual(observed[0].args, ['queue', '--thread', 'th-1', '--message', 'hello', '-m', CALLBACK_MODEL]);
    assert.equal(observed[0].args.filter((a) => a === CODEX_CLI_PATH).length, 0);
    assert.equal(observed[0].opts.timeoutMs > 0, true);
  });

  test('spawnCaptured passes command and argv to a real child process separately', withStateDir(async (dir) => {
    // Harmless stand-in child: echoes back the exact argv it received beyond
    // the node executable. Codex is never invoked.
    const echo = path.join(dir, 'echo-argv.mjs');
    fs.writeFileSync(echo, 'process.stdout.write(JSON.stringify(process.argv.slice(1)));');
    const args = callbackArgs('th-1', 'hello');
    const r = await spawnCaptured(process.execPath, [echo, ...args], { timeoutMs: 15_000 });
    assert.equal(r.ok, true, `child failed: ${r.error ?? r.stderr}`);
    assert.deepEqual(JSON.parse(r.stdout), [echo, ...args]);
  }));

  test('writeFileAtomic replaces content and leaves no temp files', withStateDir(async (dir) => {
    const file = path.join(dir, 'nested', 'state.json');
    writeFileAtomic(file, 'one');
    writeFileAtomic(file, 'two');
    assert.equal(fs.readFileSync(file, 'utf8'), 'two');
    assert.equal(fs.readdirSync(path.join(dir, 'nested')).filter((f) => f.endsWith('.tmp')).length, 0);
  }));

  test('buildCallbackMessage scopes Astra to verification for every state', () => {
    const base = { job: 'j', thread: 't', at: '2026-09-09T00:00:00Z' };
    for (const status of ['completed', 'failed', 'cancelled', 'deadline-expired']) {
      const msg = buildCallbackMessage({ ...base, status, lastStatus: 'running', probeCount: 1, deadline: 'D' });
      assert.match(msg, /verify the tests and review results only/);
      assert.match(msg, /Do not implement changes and do not resubmit/);
      assert.ok(msg.includes('j') && msg.includes('t'));
    }
    assert.doesNotMatch(buildCallbackMessage({ ...base, status: 'failed' }), /success/i);
    assert.match(buildCallbackMessage({ ...base, status: 'completed' }), /success/);
  });
});
