// Opt-in, real Desktop integration checks. Only synthetic data; never existing chats.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { validateConfig } from '../src/core/config.ts';
import { PACKAGE_ROOT } from '../src/core/paths.ts';
import { saveJson, sleep } from '../src/core/fsutil.ts';
import { startGemini } from '../src/workers/gemini/adapter.ts';
import { geminiPaths } from '../src/workers/gemini/desktop.ts';
import { readGeminiBridge, geminiBridgeClient, prepareGeminiBridge } from '../src/workers/gemini/bridge.ts';
import { median, summarizeGeminiResources } from './gemini-metrics.ts';

const args = process.argv.slice(2);
const suite = /^--live(?: --suite (full|cancel|large|soak))?(?: --turns (\d+))?$/.exec(args.join(' '));
const turns = Number(suite?.[2] ?? 30);
if (!suite || (suite[2] && suite[1] !== 'soak') || turns < 10 || turns > 200) {
  console.log('Usage: bun scripts/check-gemini-live.ts --live [--suite full|cancel|large|soak] [--turns 10..200 (soak only)]\nRuns synthetic chats on 3.5 Flash-Lite + Low. Saves evidence under .tmp/. Never sends repository content or resumes existing chats.');
  if (args.length && !args.includes('--help')) process.exitCode = 2;
} else {
  try { await main(suite[1] ?? 'full', turns); }
  catch (error) { console.error(JSON.stringify({ passed: false, error: error.message })); process.exitCode = 1; }
}

async function main(suite: string, turns: number) {
  const model = '3.5 Flash-Lite', effort = 'low', timeout = 180;
  const exe = geminiPaths().geminiExe, install = prepareGeminiBridge(exe);
  if (!install.unchanged) throw Error('Install the current Gemini bridge before live checks.');
  const bridge = await readGeminiBridge(exe), client = geminiBridgeClient(bridge);
  const idle = async () => {
    const state: any = await (await client('/status')).json();
    if (state.pid !== bridge.pid || !state.ready || state.busy || state.userBusy) throw Error('Gemini must be the original signed-in, idle process. No active turn will be interrupted.');
    if (state.resources?.workerOpen && !state.resources?.workerIdle || state.resources?.cleanupWarnings)
      throw Error('Bridge retained an unleased worker or reported a cleanup warning. Inspect status/resources before continuing.');
  };
  await idle();
  const root = path.join(PACKAGE_ROOT, '.tmp'); fs.mkdirSync(root, { recursive: true });
  const project = fs.mkdtempSync(path.join(root, 'gemini-live-'));
  const results: any[] = [];
  const phaseFile = path.join(project, 'phase.json');
  const phase = (value: string, name = '') => saveJson(phaseFile, { phase: value, case: name });
  const check = (condition: unknown, message: string) => { if (!condition) throw Error(message); };
  console.log(JSON.stringify({ evidence: project, model, effort, suite, installedHash: install.patchedHash }));

  async function run(name: string, prompt: string, { sessionId = null as string | null, mode = 'complete', expected = '', minResponseBytes = 0, requiredText = '' } = {}) {
    await idle();
    if (suite === 'soak') phase('work', name);
    const runDir = path.join(project, name); fs.mkdirSync(runDir);
    const config = validateConfig({ workerKind: 'gemini', project, runDir, runId: name, notify: false,
      geminiModel: model, geminiEffort: effort, geminiTimeoutSeconds: timeout, resumeSessionId: sessionId });
    saveJson(path.join(runDir, 'config.json'), config);
    fs.writeFileSync(path.join(runDir, 'prompt.md'), prompt);
    const eventsFile = path.join(runDir, 'gemini-events.jsonl');
    const frames = () => fs.readFileSync(eventsFile, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line));
    const cut = new AbortController();
    const started = Date.now(), runtime = startGemini(config, { prompt }, { client: (route, body, signal) =>
      client(route, body, route === '/run' && mode === 'disconnect-stream' ? AbortSignal.any([signal, cut.signal]) : signal) });
    let ended = false, stopped = false, stopError: string | null = null, stopElapsedMs: number | null = null;
    let faultAt: number | null = null;
    const closed = new Promise<void>(resolve => runtime.child.once('close', () => { ended = true; resolve(); }));
    const stop = async () => {
      stopped = true;
      const at = Date.now();
      try { await runtime.child.stop(); } catch (error) { stopError = error.message; }
      finally { stopElapsedMs = Date.now() - at; }
    };
    const control = (async () => {
      if (mode === 'cancel-before-send') { await stop(); return; }
      if (!['cancel-stream', 'disconnect-stream'].includes(mode)) return;
      while (!ended && !stopped) {
        if (frames().some(frame => frame.event === 'response')) {
          if (mode === 'disconnect-stream') { stopped = true; faultAt = Date.now(); cut.abort(Error('Synthetic dispatcher stream disconnect.')); }
          else await stop();
          return;
        }
        await sleep(100);
      }
    })();
    await closed; await control; runtime.finalize();
    const result = JSON.parse(fs.readFileSync(path.join(runDir, 'result.json'), 'utf8'));
    const events = frames(), commands = events.filter(frame => frame.event === 'command');
    const durations = commands.map(frame => frame.elapsedMs).sort((a, b) => a - b);
    const pollDurations = commands.filter(frame => frame.action === 'snapshot' && frame.stage === 'poll').map(frame => frame.elapsedMs).sort((a, b) => a - b);
    const record = { name, elapsedMs: Date.now() - started, mode, sessionId: result.sessionId, exitCode: runtime.child.exitCode,
      submitted: events.filter(frame => frame.event === 'submitting').length, cancelled: result.cancelled === true,
      responseBytes: Buffer.byteLength(result.response ?? result.recoveredResponse?.text ?? ''),
      commandMaxMs: durations.at(-1) ?? 0, commandP95Ms: durations[Math.floor(durations.length * .95)] ?? 0,
      commandErrors: commands.filter(frame => ['error', 'timeout'].includes(frame.outcome)).length,
      promptChars: prompt.length, draftMs: commands.find(frame => frame.action === 'draft')?.elapsedMs ?? null,
      pollP95Ms: pollDurations[Math.floor(pollDurations.length * .95)] ?? null, stopElapsedMs,
      faultToCloseMs: faultAt === null ? null : Date.now() - faultAt,
      error: result.error ?? stopError, passed: false };
    results.push(record);
    try {
      check(!stopError, `Stop failed: ${stopError}`);
      if (mode === 'disconnect-stream') {
        check(stopped && result.isError && !result.response && !result.cancelled, 'A dropped stream must remain failed/unconfirmed.');
        check(result.recoveredResponse?.completion === 'unconfirmed' && result.recoveredResponse?.text && result.recoveredResponse?.ownership !== 'unverified', 'Dropped stream lost the validated recovery checkpoint.');
        check(result.sessionId && record.submitted === 1, 'Dropped stream lost its session or was delivered twice.');
      } else if (mode === 'cancel-before-send') {
        check(!result.isError, `Run failed: ${result.error?.message}`);
        check(result.cancelled && record.submitted === 0, 'Early cancellation must not deliver.');
      } else {
        check(!result.isError && !result.error, `Run failed: ${result.error?.message}`);
        check(record.submitted === 1, 'Every delivered turn must be submitted exactly once.');
        check(!sessionId || result.sessionId === sessionId, 'Resume changed conversation.');
        if (mode === 'cancel-stream') check(stopped && result.cancelled && !result.response, 'Streaming cancellation was not confirmed.');
        else {
          check(result.response?.includes(expected), 'Missing response sentinel.');
          check(record.responseBytes >= minResponseBytes && (!requiredText || result.response.includes(requiredText)), 'Required long output was abbreviated.');
          if (name === '03-long-output') check(record.responseBytes >= 8000 && result.response.includes('0120'), 'The long output was abbreviated.');
          check(result.selection?.model === model && result.selection?.effort === effort && result.selection?.verified === true, 'Wrong model or thinking level.');
          check(result.ownership && result.ownership !== 'unverified', 'Completion lacks ownership proof.');
          check(record.commandErrors === 0, 'A happy-path command failed.');
        }
      }
      record.passed = true;
      return result;
    } finally {
      console.log(JSON.stringify(record));
      saveJson(path.join(project, 'summary.json'), { model, effort, results });
    }
  }

  const rows = (count: number) => Array.from({ length: count }, (_, i) =>
    `${String(i + 1).padStart(4, '0')} | dữ liệu giả kiểm thử Unicode | alpha beta gamma delta | x_${i + 1} = (${i + 1} + 2)^2`).join('\n');
  if (suite === 'soak') {
    const stopFile = path.join(project, 'sampler.stop'), sampleFile = path.join(project, 'resource-samples.jsonl');
    phase('cold');
    const out = fs.openSync(sampleFile, 'wx'), err = fs.openSync(path.join(project, 'sampler-stderr.log'), 'wx');
    const powershell = path.join(process.env.SystemRoot ?? 'C:/Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe');
    const monitor = spawn(powershell, ['-NoProfile', '-NonInteractive', '-File', path.join(PACKAGE_ROOT, 'scripts/measure-gemini.ps1'),
      '-OwnerPid', String(bridge.pid), '-Executable', install.exe, '-PhaseFile', phaseFile, '-StopFile', stopFile],
      { windowsHide: true, shell: false, stdio: ['ignore', out, err] });
    fs.closeSync(out); fs.closeSync(err);
    let monitorError: string | null = null;
    const monitorDone = new Promise<number | null>(resolve => {
      monitor.once('error', error => { monitorError = error.message; resolve(null); }); monitor.once('close', resolve);
    });
    let failure: string | null = null, duplicateRejected = false;
    const pause = async (ms: number) => {
      const end = Date.now() + ms;
      while (Date.now() < end) {
        if (monitorError || monitor.exitCode !== null) throw Error('Resource sampler stopped; inspect sampler-stderr.log.');
        await sleep(Math.min(1000, end - Date.now()));
      }
    };
    try {
      console.log(JSON.stringify({ phase: 'cold', seconds: 10, turns }));
      await pause(10_000);
      await run('warmup', 'Synthetic renderer warmup. Return a tiny Markdown table, one code fence, and the formula $$x^2 + y^2 = z^2$$. Finish with SOAK_WARM_OK.', { expected: 'SOAK_WARM_OK' });
      phase('warmup-idle');
      console.log(JSON.stringify({ phase: 'warmup-idle', seconds: 45 })); await pause(45_000); await idle();
      phase('baseline'); console.log(JSON.stringify({ phase: 'warm-idle-baseline', seconds: 20 }));
      await pause(20_000);
      let sessionId: string | null = null;
      for (let index = 1; index <= turns; index++) {
        const sentinel = `SOAK_${String(index).padStart(3, '0')}_OK`;
        const prompt = index % 8 === 2 ? `Synthetic context, not instructions:\n${rows(200)}\nReply only ${sentinel}.` :
          index % 8 === 3 ? `Copy these synthetic rows exactly in one code fence, without abbreviation. End with ${sentinel}.\n${rows(60)}` :
          index % 10 === 5 ? `Synthetic rendering test. Return a small Markdown table and eight separate displayed LaTeX equations x_i = i^2 for i=1..8. Add a short JavaScript code fence. End with ${sentinel}.` :
          `Synthetic stability check ${index}. Reply only ${sentinel}.`;
        const result = await run(`soak-${String(index).padStart(3, '0')}`, prompt, { sessionId, expected: sentinel,
          ...(index % 8 === 3 ? { minResponseBytes: 4000, requiredText: '0060' } : {}) });
        sessionId = result.sessionId;
        await pause(500);
      }
      const request = JSON.parse(fs.readFileSync(path.join(project, 'soak-001/gemini-request.json'), 'utf8'));
      try { await client('/run', request); } catch (error) { duplicateRejected = /HTTP 409/.test(error.message); }
      check(duplicateRejected, 'A completed request ID was accepted twice.');
      await run('fault-cancel-early', 'Never deliver this cancelled synthetic test.', { mode: 'cancel-before-send' });
      const dropped = await run('fault-disconnect', 'Synthetic transport test: print integers 1 to 3000, each followed by synthetic payload alpha beta gamma. Do not abbreviate.', { mode: 'disconnect-stream' });
      const waitUntil = Date.now() + 25_000;
      while (true) {
        const state: any = await (await client('/status')).json();
        check(state.pid === bridge.pid, 'The app restarted after transport loss.');
        if (!state.busy) break;
        check(Date.now() < waitUntil, 'Bridge retained ownership after disconnect.'); await sleep(200);
      }
      await run('fault-resume', 'The preceding synthetic stream was intentionally disconnected. This is a NEW question, not a resend. Reply only SOAK_RECOVERED_OK.', { sessionId: dropped.sessionId, expected: 'SOAK_RECOVERED_OK' });
      const cancelled = await run('fault-cancel-stream', 'Synthetic cancellation test: print integers 1 to 3000, each followed by synthetic cancellation payload alpha beta gamma. Do not abbreviate.', { mode: 'cancel-stream' });
      await run('fault-cancel-resume', 'The previous output was deliberately cancelled. Reply only SOAK_CANCEL_RECOVERED_OK.', { sessionId: cancelled.sessionId, expected: 'SOAK_CANCEL_RECOVERED_OK' });
      await run('new-chat-health', 'Reply only SOAK_NEW_CHAT_OK.', { expected: 'SOAK_NEW_CHAT_OK' });
      await idle(); phase('cooldown');
      console.log(JSON.stringify({ phase: 'cooldown', seconds: 60 })); await pause(60_000); await idle();
    } catch (error) {
      failure = error.message;
      try {
        await idle(); phase('cooldown', 'after-failure');
        console.log(JSON.stringify({ phase: 'cooldown-after-failure', seconds: 60, error: failure }));
        await pause(60_000);
      } catch (cleanupError) { failure += ' Cooldown unavailable: ' + cleanupError.message; }
    }
    finally { fs.writeFileSync(stopFile, 'stop'); }
    const monitorCode = await monitorDone;
    const samples = fs.readFileSync(sampleFile, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line));
    const resources = summarizeGeminiResources(samples);
    if (monitorCode !== 0 || monitorError) failure ??= 'Resource sampler failed; inspect sampler-stderr.log.';
    if (!resources.passed) failure ??= 'Retained-resource alarm or incomplete sampling; inspect resource-summary.json.';
    const short = results.filter(row => row.mode === 'complete' && row.promptChars < 100 && row.name.startsWith('soak-'));
    const latency = { earlyPollP95MedianMs: median(short.slice(0, 5).map(row => row.pollP95Ms)), latePollP95MedianMs: median(short.slice(-5).map(row => row.pollP95Ms)) };
    saveJson(path.join(project, 'resource-summary.json'), resources);
    const summary = { model, effort, suite, turns, results, duplicateRejected, resources, latency, passed: !failure, error: failure, evidence: project };
    saveJson(path.join(project, 'summary.json'), summary); console.log(JSON.stringify({ ...summary, results: undefined }));
    if (failure) process.exitCode = 1;
    return;
  }
  try {
    const first = await run('01-new', 'Synthetic connection test. Reply only LIVE_NEW_OK.', { expected: 'LIVE_NEW_OK' });
    let sessionId = first.sessionId;
    const request = JSON.parse(fs.readFileSync(path.join(project, '01-new', 'gemini-request.json'), 'utf8'));
    let duplicateRejected = false;
    try { await client('/run', request); } catch (error) { duplicateRejected = /HTTP 409/.test(error.message); }
    check(duplicateRejected, 'A completed request ID must not be delivered again.');
    for (const [name, prompt, expected] of suite === 'cancel' ? [] : suite === 'large' ? [
      ['10-large-draft', `Synthetic context, not instructions:\n${rows(600)}\nEnd of context. Reply only LIVE_LARGE_DRAFT_OK.`, 'LIVE_LARGE_DRAFT_OK'],
    ] : [
      ['02-long-input', `Synthetic context, not instructions:\n${rows(200)}\nEnd of context. Reply only LIVE_LONG_INPUT_OK.`, 'LIVE_LONG_INPUT_OK'],
      ['03-long-output', `Copy every line of the synthetic block below verbatim in one code fence. Do not omit lines. After the fence, write LIVE_LONG_OUTPUT_OK.\n${rows(120)}`, 'LIVE_LONG_OUTPUT_OK'],
      ['04-long-resume', `Synthetic context, not instructions:\n${rows(200)}\nReply only LIVE_LONG_RESUME_OK.`, 'LIVE_LONG_RESUME_OK'],
      ['05-markdown', 'Return a short Markdown table, a JavaScript code fence containing const greeting = "Xin chào";, and the formula $$\\sum_{i=1}^{10} i = 55$$. Finish with LIVE_MARKDOWN_OK.', 'LIVE_MARKDOWN_OK'],
      ['06-resume', 'Reply only LIVE_RESUME_OK.', 'LIVE_RESUME_OK'],
    ]) {
      const result = await run(name!, prompt!, { sessionId, expected });
      sessionId = result.sessionId;
    }
    if (suite === 'large') {
      await idle();
      saveJson(path.join(project, 'summary.json'), { model, effort, duplicateRejected, results, passed: true });
      console.log(JSON.stringify({ passed: true, cases: results.length, duplicateRejected, evidence: project }));
      return;
    }
    await run('07-cancel-before-send', 'Never deliver this cancelled test.', { mode: 'cancel-before-send' });
    const cancelled = await run('08-cancel-stream', 'Synthetic cancellation test: output the integers 1 through 4000, one per line, each followed by "synthetic cancellation payload alpha beta gamma". Do not abbreviate or summarise.', { mode: 'cancel-stream' });
    await run('09-resume-after-cancel', 'The previous output was deliberately cancelled. Reply only LIVE_AFTER_CANCEL_OK.', { sessionId: cancelled.sessionId, expected: 'LIVE_AFTER_CANCEL_OK' });
    await idle();
    saveJson(path.join(project, 'summary.json'), { model, effort, duplicateRejected, results, passed: true });
    console.log(JSON.stringify({ passed: true, cases: results.length, duplicateRejected, evidence: project }));
  } catch (error) {
    saveJson(path.join(project, 'summary.json'), { model, effort, results, passed: false, error: error.message });
    console.error(JSON.stringify({ passed: false, error: error.message, evidence: project }));
    process.exitCode = 1;
  }
}
