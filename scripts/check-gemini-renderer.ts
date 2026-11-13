// Real stalled-JS checks in an OWNED local Chromium fixture, never the signed-in app.
// Pipe transport: https://chromium.googlesource.com/chromium/src/+/main/content/browser/devtools/devtools_pipe_handler.cc
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { asset, PACKAGE_ROOT } from '../src/core/paths.ts';
import { saveJson, sleep } from '../src/core/fsutil.ts';

const exe = process.env.GEMINI_TEST_CHROME ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe';
if (!fs.existsSync(exe)) throw Error('Set GEMINI_TEST_CHROME to an installed Chromium executable.');
const root = path.join(PACKAGE_ROOT, '.tmp'); fs.mkdirSync(root, { recursive: true });
const dir = fs.mkdtempSync(path.join(root, 'gemini-renderer-'));
const file = path.join(dir, 'fixture.html');
fs.writeFileSync(file, '<!doctype html><meta charset="utf-8"><div role="textbox" contenteditable="true"></div><button aria-label="Open mode picker, currently Flash-Lite">mode</button>');
const err = fs.openSync(path.join(dir, 'chromium-stderr.log'), 'wx');
const child = spawn(exe, ['--headless=new', '--no-first-run', '--no-default-browser-check', '--disable-background-networking',
  '--disable-gpu', '--remote-debugging-pipe', '--user-data-dir=' + path.join(dir, 'profile'), 'about:blank'],
  { windowsHide: true, shell: false, stdio: ['ignore', 'ignore', err, 'pipe', 'pipe'] });
fs.closeSync(err);
const closed = new Promise(resolve => child.once('close', resolve));
const pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
let next = 0, buffer = '';
const fail = (message: string) => {
  for (const entry of pending.values()) { clearTimeout(entry.timer); entry.reject(Error(message)); }
  pending.clear();
};
child.once('error', error => fail(error.message));
child.once('close', () => fail('Owned Chromium fixture exited.'));
const writer: any = child.stdio[3], reader: any = child.stdio[4];
reader.setEncoding('utf8');
reader.on('data', chunk => {
  buffer += chunk;
  let end: number;
  while ((end = buffer.indexOf('\0')) >= 0) {
    const raw = buffer.slice(0, end); buffer = buffer.slice(end + 1);
    if (!raw) continue;
    const value = JSON.parse(raw), entry = pending.get(value.id);
    if (!entry) continue;
    clearTimeout(entry.timer); pending.delete(value.id);
    if (value.error) entry.reject(Error(value.error.message)); else entry.resolve(value.result);
  }
});
const call = (method: string, params: any = {}, sessionId?: string) => new Promise<any>((resolve, reject) => {
  const id = ++next, timer = setTimeout(() => { pending.delete(id); reject(Error(`Fixture protocol timed out: ${method}`)); }, 45_000);
  pending.set(id, { resolve, reject, timer });
  writer.write(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }) + '\0');
});
const check = (condition: unknown, message: string) => { if (!condition) throw Error(message); };
const results: any[] = [];
try {
  await call('Browser.getVersion');
  const target = await call('Target.createTarget', { url: pathToFileURL(file).href });
  const { sessionId } = await call('Target.attachToTarget', { targetId: target.targetId, flatten: true });
  const evaluate = async (expression: string) => {
    const value = await call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, sessionId);
    if (value.exceptionDetails) throw Error('Fixture renderer exception: ' + value.exceptionDetails.text);
    return value.result.value;
  };
  for (let i = 0; i < 100; i++) {
    if (await evaluate('location.protocol === "file:" && document.readyState === "complete"')) break;
    await sleep(50);
  }
  const require = createRequire(import.meta.url), sandbox: any = { Buffer, URL, process, setTimeout, clearTimeout,
    require: (name: string) => name === 'electron' ? { app: { whenReady: () => new Promise(() => {}), on() {} }, ipcMain: { on() {} } } :
      name === './gemini-safety.cjs' ? require(asset('node', 'gemini-safety.cjs')) : require(name) };
  const source = fs.readFileSync(asset('node', 'gemini-bridge.cjs'), 'utf8');
  check(source.includes("location.origin !== 'https://gemini.google.com'"), 'Expected renderer origin guard not found.');
  // Test-copy origin substitution only; no installed app bytes or auth guard change.
  vm.runInNewContext(source.replace("location.origin !== 'https://gemini.google.com'", "location.protocol !== 'file:'") +
    '\n;globalThis.api = { command, commandContexts };', sandbox);
  const api = sandbox.api;
  const fixture = (delay: number) => {
    let executions = 0;
    let execution: Promise<any> | undefined;
    const events: any[] = [];
    const context: any = { deadline: Date.now() + 90_000, stage: 'fixture-read', res: { destroyed: false, write: line => events.push(JSON.parse(line)) } };
    const wc = { isDestroyed: () => false, getURL: () => 'https://gemini.google.com/app', executeJavaScript: expression => {
      executions++;
      execution = evaluate(`(() => { const until = performance.now() + ${delay}; while (performance.now() < until) {} return (${expression}); })()`);
      return execution;
    } };
    api.commandContexts.set(wc, context);
    return { wc, context, events, get executions() { return executions; }, settled: () => execution?.catch(() => {}) };
  };

  let fixtureState = fixture(12_000), started = Date.now();
  const reads = await Promise.all([api.command(fixtureState.wc, 'snapshot'), api.command(fixtureState.wc, 'snapshot')]);
  check(reads.every(value => value.ready) && fixtureState.executions === 1, 'Slow concurrent reads overlapped or failed.');
  check(fixtureState.events.some(event => event.outcome === 'read-grace'), 'Slow read did not enter grace.');
  results.push({ case: 'real-12s-renderer-stall', passed: true, elapsedMs: Date.now() - started, executions: fixtureState.executions });
  console.log(JSON.stringify(results.at(-1)));

  fixtureState = fixture(24_000); started = Date.now();
  let timedOut = false;
  try { await api.command(fixtureState.wc, 'snapshot'); } catch (error) { timedOut = /renderer timeout/.test(error.message); }
  check(timedOut && fixtureState.executions === 1, 'Stalled read did not time out once.');
  const recovered = await api.command(fixtureState.wc, 'snapshot');
  check(recovered.ready && fixtureState.executions === 1, 'Recovery reissued an unresolved renderer read.');
  results.push({ case: 'real-24s-timeout-and-join', passed: true, elapsedMs: Date.now() - started, executions: fixtureState.executions });
  console.log(JSON.stringify(results.at(-1)));

  fixtureState = fixture(30_000); started = Date.now();
  const cancel = setTimeout(() => { fixtureState.context.cancel = true; }, 1000);
  let cancelledInBound = false;
  try { await api.command(fixtureState.wc, 'snapshot'); } catch (error) { cancelledInBound = /renderer timeout/.test(error.message) && Date.now() - started < 17_000; }
  finally { clearTimeout(cancel); }
  check(cancelledInBound && fixtureState.executions === 1, 'Cancellation did not bound the frozen read.');
  const elapsedMs = Date.now() - started;
  await call('Runtime.terminateExecution', {}, sessionId); // ONLY this disposable fixture.
  await fixtureState.settled();
  check(await evaluate('document.readyState === "complete"'), 'Fixture did not recover after terminating its injected loop.');
  results.push({ case: 'real-stall-cancel-deadline', passed: true, elapsedMs, executions: fixtureState.executions });
  console.log(JSON.stringify(results.at(-1)));
  saveJson(path.join(dir, 'summary.json'), { passed: true, scope: 'Owned local Chromium only; not a live Gemini renderer crash.', results });
  console.log(JSON.stringify({ passed: true, evidence: dir, cases: results.length }));
} catch (error) {
  saveJson(path.join(dir, 'summary.json'), { passed: false, results, error: error.message });
  console.error(JSON.stringify({ passed: false, error: error.message, evidence: dir })); process.exitCode = 1;
} finally {
  try { await call('Browser.close'); } catch {}
  const timer = setTimeout(() => child.kill(), 5000); // Only the owned, isolated Chrome helper; NEVER Gemini.
  await closed; clearTimeout(timer);
}
