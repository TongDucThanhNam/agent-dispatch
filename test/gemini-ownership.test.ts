import { test, expect } from 'bun:test';
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';
import { asset } from '../src/core/paths.ts';
import { validateConfig } from '../src/core/config.ts';
import { startGemini } from '../src/workers/gemini/adapter.ts';
import { finishResult } from '../src/core/supervisor.ts';
import { cli, rmTree } from './helpers.ts';

const require = createRequire(import.meta.url);
const safety = require(asset('node', 'gemini-safety.cjs'));
const marker = '[ad:1234567890abcdef]';
const brief = fs.readFileSync(new URL('./fixtures/gemini/synthetic-consultation.md', import.meta.url), 'utf8');
const sid = 'gemini_1234567890abcdef', url = 'https://gemini.google.com/app/1234567890abcdef';
const uid = 'user-query-content-1', rid = 'model-response-message-content1';
const selection = { model: '4 Argon', effort: 'high', displayModel: 'Argon Cao', verified: true };
const flat = (text: string) => text.replace(/\s+/gu, ' ').trim();

function runtime(extra: any = {}) {
  const sandbox: any = { Buffer, URL, process, setTimeout, clearTimeout,
    require: (name: string) => name === 'electron' ? { app: { whenReady: () => new Promise(() => {}), on() {} }, ipcMain: { on() {} } } :
      name === './gemini-safety.cjs' ? safety : require(name), ...extra };
  vm.runInNewContext(fs.readFileSync(asset('node', 'gemini-bridge.cjs'), 'utf8') + `
    globalThis.api = { pageCommand, runPrompt, handle, command, commandContexts,
      setup: (wc, before, selection, readiness) => {
        createWorker = async (_, context) => { commandContexts.set(wc, context); return { wc, snapshot: readiness ? await command(wc, 'snapshot') : before }; };
        selectModel = async () => selection;
      }
    };`, sandbox);
  return sandbox.api;
}

// Deterministic renderer/deadline tests, without waiting tens of real seconds.
function virtualClock() {
  let now = 0, next = 0;
  const timers = new Map<number, { at: number; fn: () => void }>();
  const clock = {
    Date: class extends Date { static now() { return now; } },
    setTimeout(fn: () => void, ms: number) { const id = ++next; timers.set(id, { at: now + ms, fn }); return id; },
    clearTimeout(id: number) { timers.delete(id); },
    async drive(promise: Promise<any>) {
      let done = false, result: any, failure: any;
      promise.then(value => { done = true; result = value; }, error => { done = true; failure = error; });
      for (let steps = 0; !done && steps < 100_000; steps++) {
        for (let i = 0; i < 30; i++) await Promise.resolve();
        if (done) break;
        const entry = [...timers].sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
        if (!entry) throw Error('Virtual renderer deadlocked.');
        timers.delete(entry[0]); now = entry[1].at; entry[1].fn();
      }
      if (!done) throw Error('Virtual renderer did not finish.');
      if (failure) throw failure;
      return result;
    },
  };
  return clock;
}

test('synthetic 5518-byte markdown fixture preserves multilingual structure and marker evidence', () => {
  expect(Buffer.byteLength(brief)).toBe(5518);
  for (const text of ['## Who we are', '| Prototype |', '- Attempt one', 'Tiếng Việt', '中文', '日本語']) expect(brief).toContain(text);
  expect(brief.split('## Long single paragraph\n')[1].split('\n\n')[0].length).toBeGreaterThan(2500);
  expect(safety.turnEvidence(flat(marker + '\n' + brief), brief, marker)).toBe('marker');
  expect(safety.turnEvidence(marker + '\n' + brief, brief, marker)).toBe('exact');
});

test('collapsed marker-less prefixes require 160 characters and 20 words, with English/Vietnamese labels', () => {
  const prefix = flat(brief).slice(0, 450);
  for (const label of ['You said', 'Bạn đã nói']) {
    expect(safety.turnEvidence(label + '\n' + marker + '\n' + brief, brief, marker)).toBe('exact');
    expect(safety.turnEvidence(label + ' ' + marker + '\n' + brief + '\n\n' + marker + '\n' + brief, brief, marker)).toBe('exact');
    for (const more of ['Show more', 'Xem thêm']) expect(safety.turnEvidence(label + ':\n' + prefix + '…\n' + more, brief, marker)).toBe('prefix');
  }
  expect(safety.turnEvidence(flat(brief), brief, marker)).toBe('prefix');
  expect(safety.turnEvidence(prefix.slice(0, 100), brief, marker)).toBeNull();
  expect(safety.turnEvidence('x'.repeat(200), 'x'.repeat(1000), marker)).toBeNull();
  expect(safety.turnEvidence('[ad:ffffffffffffffff]\n' + prefix, brief, marker)).toBeNull();
  expect(safety.turnEvidence('a foreign question ' + prefix, brief, marker)).toBeNull();
});

test('ownership refuses foreign, duplicate, multiple and rewritten history, even with a valid marker', () => {
  const own = { id: uid, text: marker + '\n' + brief }, old = { id: 'user-query-content-old', text: 'old' };
  expect(safety.ownedTurn([old], [old, own], brief, marker)).toEqual({ userId: uid, level: 'exact' });
  expect(safety.ownedTurn([], [], brief, marker)).toBeNull();
  expect(() => safety.ownedTurn([], [{ id: uid, text: 'foreign' }], brief, marker)).toThrow('ownership');
  expect(() => safety.ownedTurn([], [own, { ...own, id: 'second' }], brief, marker)).toThrow('multiple');
  expect(() => safety.ownedTurn([old], [own], brief, marker)).toThrow('history changed');
  expect(() => safety.ownedTurn([old], [old, old], brief, marker)).toThrow('history changed');
});

test('fake DOM snapshot uses visible query lines and ties each reply to its immediately preceding user', () => {
  const nodes = [
    { id: 'user-query-content-old', querySelectorAll: () => [{ innerText: 'old' }], compareDocumentPosition: () => 4 },
    { id: uid, querySelectorAll: () => [{ innerText: 'You said\n' }, { innerText: flat(marker + '\n' + brief) }], compareDocumentPosition: () => 4 },
  ];
  const reply = { id: rid, innerText: 'answer', getAttribute: () => 'false', closest: () => ({ querySelector: () => ({}) }) };
  const api = runtime({ location: { origin: 'https://gemini.google.com', href: url }, document: { querySelectorAll: (selector: string) =>
    selector === '[id^="user-query-content-"], [id^="model-response-message-content"]' ? [...nodes, reply] : [] } });
  const snap = api.pageCommand('snapshot', { userIds: [nodes[0].id], replyIds: [] });
  expect(snap.replies[0]).toMatchObject({ userId: uid, id: rid, complete: true });
  expect(safety.ownedTurn([], [snap.users[1]], brief, marker).level).toBe('marker');
});

test('snapshot does not force layout on historical action buttons', () => {
  let historicalReads = 0, controlReads = 0;
  const oldButtons = Array.from({ length: 1000 }, () => ({ textContent: 'Copy answer',
    getAttribute: () => null,
    get innerText() { historicalReads++; return 'Copy answer'; },
    getClientRects() { historicalReads++; return [1]; } }));
  const button = (text: string, shown = true) => ({ textContent: text, getAttribute: () => text,
    getClientRects() { controlReads++; return shown ? [1] : []; } });
  const api = runtime({ location: { origin: 'https://gemini.google.com', href: url }, document: {
    querySelectorAll: (selector: string) => selector === 'button' ? [...oldButtons,
      button('Open mode picker, currently Hidden', false), button('Open mode picker, currently Argon Cao'),
      button('Stop response', false), { textContent: 'hidden icon Send message hidden shortcut', innerText: 'Send message',
        getAttribute: () => null, getClientRects() { controlReads++; return [1]; } }] : [],
  } });
  const result = api.pageCommand('snapshot', { userIds: [], replyIds: [] });
  expect(result.model).toBe('Argon Cao'); expect(result.busy).toBe(false); expect(result.send).toBe(true);
  expect(historicalReads).toBe(0); expect(controlReads).toBe(4);
});

test('multiline drafts use text nodes under Trusted Types, with one input event and no HTML sink', () => {
  const calls: any[] = [], inputs: any[] = [];
  let fragment: any, replacements = 0;
  const node = (tag: string) => ({ tag, children: [] as any[], append(child: any) { this.children.push(child); } });
  const editor = { innerText: '', getClientRects: () => [1], focus() {},
    replaceChildren(value: any) { fragment = value; replacements++; }, dispatchEvent(event: any) { inputs.push(event); } };
  const api = runtime({ location: { origin: 'https://gemini.google.com' },
    InputEvent: class { constructor(public type: string, public options: any) {} }, document: {
    createDocumentFragment: () => node('fragment'), createElement: node, createTextNode: (text: string) => ({ text }),
    querySelectorAll: (selector: string) => selector.includes('contenteditable') ? [editor] : [],
    execCommand: (...args: any[]) => { if (args[0] === 'insertHTML') throw TypeError('TrustedHTML required'); calls.push(args); return true; },
  } });
  const prompt = 'Xin chào <script>&"\r\n\r\n  x\t= 2\n';
  api.pageCommand('draft', prompt);
  expect(replacements).toBe(1); expect(calls).toEqual([]);
  expect(fragment.children.map(p => p.children[0].text ?? p.children[0].tag)).toEqual(['Xin chào <script>&"', 'br', '  x\t= 2', 'br']);
  expect(inputs).toMatchObject([{ type: 'input', options: { bubbles: true, composed: true, inputType: 'insertFromPaste', data: prompt } }]);
  api.pageCommand('draft', 'single line <literal>');
  expect(calls).toEqual([['insertText', false, 'single line <literal>']]);
});

test('snapshot caches rendered text but rechecks mutations, completion, ownership and replaced nodes', () => {
  const observers = new Map<any, any>();
  class Observer {
    records: any[] = [];
    constructor(public callback: () => void) {}
    observe(node: any) { observers.set(node, this); }
    takeRecords() { return this.records.splice(0); }
  }
  let reads = 0, text = 'streaming', busy = 'true', complete = false;
  const user = { id: uid, querySelectorAll: () => [], get innerText() { reads++; return marker + '\n' + brief; } };
  const container = { querySelector: () => complete ? {} : null };
  const reply = { id: rid, get innerText() { reads++; return text; }, getAttribute: () => busy,
    closest: () => container };
  let nodes: any[] = [user, reply];
  const stop = { textContent: 'Stop response', getAttribute: () => 'Stop response', getClientRects: () => [1] };
  const api = runtime({ MutationObserver: Observer, location: { origin: 'https://gemini.google.com', href: url },
    document: { querySelectorAll: (selector: string) => selector === 'button' ? complete ? [] : [stop] :
      selector === '[id^="user-query-content-"], [id^="model-response-message-content"]' ? nodes : [] } });
  const snapshot = () => api.pageCommand('snapshot', { userIds: [], replyIds: [] });
  expect(snapshot().replies[0].text).toBe('streaming');
  for (let i = 0; i < 100; i++) expect(snapshot().users[0].text).toBe(marker + '\n' + brief);
  expect(reads).toBe(2);
  text = 'revised answer'; observers.get(container).records.push({ type: 'characterData' });
  expect(snapshot().replies[0].text).toBe(text); expect(reads).toBe(3);
  busy = 'false'; complete = true;
  text = 'fresh final text'; // Even a change outside the observed subtree must be read at completion.
  expect(snapshot().replies[0]).toMatchObject({ text, busy: 'false', complete: true, userId: uid });
  expect(reads).toBe(5);
  complete = false;
  nodes = [{ ...user, id: uid + '-rebound', innerText: marker + '\n' + brief }, reply];
  expect(snapshot().replies[0].userId).toBe(uid + '-rebound');
  text = 'callback revision'; observers.get(container).callback();
  expect(snapshot().replies[0].text).toBe(text);
  nodes = [nodes[0], { ...reply, innerText: 'replacement response' }];
  expect(snapshot().replies[0].text).toBe('replacement response');
});

function historyPage(count: number) {
  let textReads = 0, comparisons = 0;
  const nodes: any[] = [];
  const node = (id: string, text: string) => ({ id, get innerText() { textReads++; return text; },
    getAttribute: () => 'false', querySelectorAll: () => [], closest: () => ({ querySelector: () => ({}) }),
    compareDocumentPosition(other: any) { comparisons++; return nodes.indexOf(this) < nodes.indexOf(other) ? 4 : 2; } });
  for (let i = 0; i < count; i++) nodes.push(node('user-query-content-old' + i, 'old prompt '.repeat(2400)), node('model-response-message-contentold' + i, 'old answer '.repeat(2400)));
  const baseline = { userIds: nodes.filter(n => n.id.startsWith('user-')).map(n => n.id), replyIds: nodes.filter(n => n.id.startsWith('model-')).map(n => n.id) };
  nodes.push(node(uid, marker + '\n' + brief), node(rid, 'fresh answer'));
  const button = (label: string) => ({ getClientRects: () => [1], getAttribute: () => label, click() {} });
  const editor = { innerText: '', children: [], childNodes: [], getClientRects: () => [1], focus() {} };
  const api = runtime({ location: { origin: 'https://gemini.google.com', href: url }, document: {
    execCommand: () => true,
    createDocumentFragment: () => ({ append() {} }), createElement: () => ({ append() {} }), createTextNode: text => text,
    querySelectorAll: (selector: string) => selector === 'button' ? [button('Open mode picker, currently Argon Cao'), button('Send message')] :
      selector.includes('contenteditable') ? [editor] : selector === '[id^="user-query-content-"]' ? nodes.filter(n => n.id.startsWith('user-')) :
      selector === '[id^="model-response-message-content"]' ? nodes.filter(n => n.id.startsWith('model-')) :
      selector === '[id^="user-query-content-"], [id^="model-response-message-content"]' ? nodes : [],
  } });
  return { api, baseline, measure(action: string) {
    textReads = 0; comparisons = 0;
    const result = api.pageCommand(action, action === 'draft' ? 'synthetic draft' : baseline);
    const { users, replies, ...controls } = result;
    return { result, textReads, comparisons, bytes: Buffer.byteLength(JSON.stringify(result)),
      textBytes: Buffer.byteLength(JSON.stringify({ ...controls, users: users?.filter((u: any) => u.text != null), replies: replies?.filter((r: any) => r.text != null) })) };
  } };
}

test('polls read candidate text only and mutations never extract or return history', () => {
  const small = historyPage(2), large = historyPage(20);
  const a = small.measure('snapshot'), b = large.measure('snapshot');
  expect(a.textReads).toBe(2); expect(b.textReads).toBe(2);
  expect(a.comparisons).toBe(0); expect(b.comparisons).toBe(0);
  expect(a.textBytes).toBe(b.textBytes);
  expect(b.result.users).toHaveLength(21); expect(b.result.replies).toHaveLength(21);
  expect(b.result.users.at(-1).text).toBe(marker + '\n' + brief);
  expect(b.result.replies.at(-1)).toMatchObject({ userId: uid, text: 'fresh answer' });
  for (const action of ['draft', 'send', 'stop']) {
    const x = small.measure(action), y = large.measure(action);
    expect(x.textReads).toBe(0); expect(y.textReads).toBe(0);
    expect(x.bytes).toBe(y.bytes);
    expect(x.result.users).toBeUndefined(); expect(y.result.replies).toBeUndefined();
  }
});

test('long id skeleton still rejects changed history, duplicate ids, two new users and two fresh replies', async () => {
  const users = Array.from({ length: 20 }, (_, i) => ({ id: 'user-query-content-old' + i }));
  const replies = users.map((u, i) => ({ id: 'model-response-message-contentold' + i, userId: u.id }));
  for (const mode of ['changed', 'duplicate-user', 'two-users', 'two-replies', 'duplicate-reply']) {
    const result = await runFake(prompt => {
      const s: any = { ...answer(prompt), users: [...users, ...answer(prompt).users], replies: [...replies, ...answer(prompt).replies] };
      if (mode === 'changed') s.users[0] = { id: 'user-query-content-changed' };
      if (mode === 'duplicate-user') s.users[1] = s.users[0];
      if (mode === 'two-users') s.users.push({ id: 'user-query-content-other', text: prompt });
      if (mode === 'two-replies') s.replies.push({ ...s.replies.at(-1)!, id: 'model-response-message-contentother' });
      if (mode === 'duplicate-reply') s.replies[1] = s.replies[0];
      return s;
    }, { virtual: true, before: { users, replies } });
    expect(result.events.at(-1).event).toBe('error');
    expect(result.events.some(e => e.event === 'complete' || e.event === 'response')).toBe(false);
  }
});

async function runFake(render: (prompt: string, n: number) => any, options: any = {}) {
  const events: any[] = [], actions: string[] = [];
  let drafted = '', sent = false, polls = 0, run: any;
  const before = { url: 'https://gemini.google.com/app', model: selection.displayModel, users: [], replies: [], ready: true, hasDraft: false, busy: false, ...options.before };
  const clock = options.virtual ? virtualClock() : null;
  const wc = { isDestroyed: () => false, getURL: () => sent ? url : before.url, executeJavaScript: async (code: string) => {
    const [action, value] = JSON.parse('[' + code.slice(code.lastIndexOf('})(') + 3, -1) + ']'); actions.push(action);
    const override = options.command?.({ action, value, sent, polls, run, clock, before });
    if (override) { const result = await override; if (result !== undefined) return result; }
    if (action === 'draft') drafted = value;
    if (action === 'send') { sent = true; if (options.sendThrows) throw Error('send acknowledgement lost'); }
    if (action === 'snapshot' && sent) {
      const n = polls++;
      if (n === options.failSnapshotAt) throw Error('Synthetic snapshot transport failure.');
      if (n === options.cancelAt) run.cancel = true;
      return { ...before, url, ...render(drafted, n) };
    }
    return { ...before, draft: drafted, send: true };
  } };
  const api = runtime(clock ?? {}); api.setup(wc, before, selection, options.readiness);
  run = { request: { prompt: options.prompt ?? brief, model: '4 Argon', effort: 'high', timeoutSeconds: options.timeout ?? 3 },
    res: { destroyed: false, write: (line: string) => events.push(JSON.parse(line)), end() {} } };
  const running = api.runPrompt(run);
  if (clock) await clock.drive(running); else await running;
  return { events, actions, drafted, elapsedMs: clock?.Date.now() };
}
const answer = (prompt: string) => ({ users: [{ id: uid, text: prompt }], replies: [{ id: rid, userId: uid, text: 'verified answer', busy: 'false', complete: true }] });

test('readiness timeout names action, stage and elapsed time without submitting', async () => {
  const result = await runFake(answer, { virtual: true, readiness: true, timeout: 60,
    command: ({ action }: any) => action === 'snapshot' ? new Promise(() => {}) : null });
  expect(result.events.at(-1)).toMatchObject({ event: 'error', action: 'snapshot', stage: 'readiness', elapsedMs: 20_000, submitted: false });
  expect(result.events.at(-1).message).toContain('action=snapshot, stage=readiness, elapsedMs=20000');
  expect(result.actions).toEqual(['snapshot']);
  expect(result.events.filter(e => e.event === 'command').map(e => e.outcome)).toEqual(['read-grace', 'timeout']);
});

test('read grace respects a shorter turn deadline and expired commands issue no renderer work', async () => {
  const result = await runFake(answer, { virtual: true, readiness: true, timeout: 10,
    command: ({ action }: any) => action === 'snapshot' ? new Promise(() => {}) : null });
  expect(result.events.at(-1)).toMatchObject({ event: 'error', stage: 'readiness', elapsedMs: 10_000, submitted: false });
  const clock = virtualClock(), api = runtime(clock);
  let executions = 0;
  const wc = { isDestroyed: () => false, getURL: () => url, executeJavaScript: async () => { executions++; } };
  api.commandContexts.set(wc, { deadline: 0, stage: 'poll', res: { destroyed: false, write() {} } });
  const settled = await clock.drive(Promise.allSettled([api.command(wc, 'snapshot')]));
  expect(settled[0].status).toBe('rejected'); expect(executions).toBe(0);
});

test('a slow readiness read gets a bounded second chance on the same execution', async () => {
  let reads = 0;
  const result = await runFake(answer, { virtual: true, readiness: true, timeout: 60,
    command: ({ action, clock, before }: any) => action === 'snapshot' && reads++ === 0 ?
      new Promise(resolve => clock.setTimeout(() => resolve(before), 12_000)) : null });
  expect(result.events.at(-1).event).toBe('complete');
  expect(result.events.find(e => e.outcome === 'read-grace')).toMatchObject({ action: 'snapshot', stage: 'readiness', elapsedMs: 10_000 });
  expect(result.events.find(e => e.event === 'command' && e.stage === 'readiness' && e.outcome === 'ok').elapsedMs).toBe(12_000);
  expect(result.actions.filter(a => a === 'send')).toHaveLength(1);
});

test('a read that rejects during grace is retried once only after settling', async () => {
  let reads = 0, outstanding = 0, maxOutstanding = 0;
  const result = await runFake(answer, { virtual: true, readiness: true, timeout: 60,
    command: ({ action, clock }: any) => {
      if (action !== 'snapshot') return null;
      outstanding++; maxOutstanding = Math.max(maxOutstanding, outstanding);
      if (reads++ !== 0) { outstanding--; return null; }
      return new Promise((_, reject) => clock.setTimeout(() => { outstanding--; reject(Error('Synthetic late read failure.')); }, 11_000));
    } });
  expect(result.events.at(-1).event).toBe('complete');
  expect(result.events.filter(e => e.outcome === 'read-retry')).toHaveLength(1);
  expect(maxOutstanding).toBe(1); expect(outstanding).toBe(0);
  expect(result.actions.filter(a => a === 'send')).toHaveLength(1);
});

test('a timed-out send is never retried and keeps submission uncertainty', async () => {
  const result = await runFake(answer, { virtual: true, timeout: 60,
    command: ({ action }: any) => action === 'send' ? new Promise(() => {}) : null });
  expect(result.events.at(-1)).toMatchObject({ event: 'error', action: 'send', stage: 'send', elapsedMs: 10_000, submitted: true });
  expect(result.actions.filter(a => a === 'send')).toHaveLength(1);
  expect(result.events.some(e => e.action === 'send' && e.outcome === 'read-grace')).toBe(false);
});

test('a slow draft waits on its one execution, verifies it and sends exactly once', async () => {
  const result = await runFake(answer, { virtual: true, timeout: 90,
    command: ({ action, clock }: any) => action === 'draft' ? new Promise<void>(resolve => clock.setTimeout(resolve, 12_000)) : null });
  expect(result.events.at(-1).event).toBe('complete');
  expect(result.actions.filter(action => action === 'draft')).toHaveLength(1);
  expect(result.actions.filter(action => action === 'send')).toHaveLength(1);
  expect(result.events.find(event => event.action === 'draft' && event.outcome === 'ok').elapsedMs).toBe(12_000);
});

test('cancelling a stalled draft is confirmed before submission within the cancellation bound', async () => {
  const result = await runFake(answer, { virtual: true, timeout: 90,
    command: ({ action, clock, run }: any) => {
      if (action !== 'draft') return null;
      clock.setTimeout(() => { run.cancel = true; }, 1000);
      return new Promise(() => {});
    } });
  expect(result.events.at(-1)).toMatchObject({ event: 'cancelled', beforeSubmission: true });
  expect(result.actions.filter(action => action === 'send')).toHaveLength(0);
  expect(result.elapsedMs).toBeLessThanOrEqual(16_000);
});

test('deadline cleanup can stop a freshly reverified owned turn, never a foreign one', async () => {
  for (const foreign of [false, true]) {
    const result = await runFake(prompt => ({ ...answer(prompt), busy: true }), { virtual: true, timeout: 1,
      command: ({ action, run }: any) => foreign && action === 'snapshot' && run.stage === 'error-reconciliation' ?
        Promise.resolve({ url, model: selection.displayModel, busy: true, users: [{ id: uid, text: 'foreign turn' }], replies: [] }) : null });
    expect(result.events.at(-1).event).toBe('error');
    expect(result.events.some(event => event.event === 'complete')).toBe(false);
    expect(result.actions.filter(action => action === 'send')).toHaveLength(1);
    expect(result.actions.filter(action => action === 'stop')).toHaveLength(foreign ? 0 : 1);
    expect(result.elapsedMs).toBeLessThanOrEqual(11_000);
  }
});

test('two callers cannot overlap an unresolved expensive read', async () => {
  const clock = virtualClock(), api = runtime(clock);
  let executions = 0;
  const wc = { isDestroyed: () => false, getURL: () => url, executeJavaScript: () => { executions++; return new Promise(() => {}); } };
  await clock.drive(Promise.allSettled([api.command(wc, 'snapshot'), api.command(wc, 'snapshot')]));
  expect(executions).toBe(1);
  await clock.drive(Promise.allSettled([api.command(wc, 'snapshot')]));
  expect(executions).toBe(1);
});

test('post-stream timeouts keep the last full answer frame and identify the failing poll', async () => {
  const text = 'Synthetic consultation.\n'.repeat(2100);
  const result = await runFake(prompt => ({ ...answer(prompt), busy: true, replies: [{ ...answer(prompt).replies[0], text, complete: false }] }),
    { virtual: true, timeout: 60, command: ({ action, sent, polls }: any) =>
      action === 'snapshot' && sent && polls > 0 ? new Promise(() => {}) : null });
  expect(result.events.find(e => e.event === 'response').text).toBe(text);
  expect(result.events.at(-1)).toMatchObject({ event: 'error', action: 'snapshot', stage: 'poll', elapsedMs: 20_000, submitted: true });
  expect(result.events.some(e => e.event === 'complete')).toBe(false);
  // The reconciliation read joins the still-pending poll instead of duplicating it.
  expect(result.actions.filter(a => a === 'snapshot')).toHaveLength(5);
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'ad-late-timeout-'));
  const runDir = path.join(project, '.agent-dispatch', 'synthetic'); fs.mkdirSync(runDir, { recursive: true });
  const config = validateConfig({ workerKind: 'gemini', project, runDir, runId: 'synthetic', notify: false });
  const worker = startGemini(config, { prompt: brief }, { client: async () => new Response(result.events.map(e => JSON.stringify(e) + '\n').join(''),
    { headers: { 'content-type': 'application/x-ndjson' } }) });
  try {
    await new Promise(resolve => worker.child.once('close', resolve)); worker.finalize();
    const saved = JSON.parse(fs.readFileSync(path.join(runDir, 'result.json'), 'utf8'));
    expect(saved.response).toBeUndefined();
    expect(saved.recoveredResponse).toMatchObject({ text, completion: 'unconfirmed', bytes: Buffer.byteLength(text),
      failure: { action: 'snapshot', stage: 'poll', elapsedMs: 20_000 } });
    expect(finishResult(config, { exitCode: worker.child.exitCode, stopReason: null }).status).toBe('worker_failed');
    fs.writeFileSync(path.join(runDir, 'config.json'), JSON.stringify(config));
    const report = cli(['report', runDir]);
    expect(report.status).toBe(0); expect(report.stdout.startsWith('Recovered — completion unconfirmed\n')).toBe(true);
    expect(report.stdout).toContain(text); expect(report.stdout).toContain(sid);
  } finally { worker.finalize(); rmTree(project); }
});

test('a post-stream slow read that clears confirms completion only after fresh ownership checks', async () => {
  let slow = false, prompt = '';
  const result = await runFake((sent, n) => { prompt = sent; return { ...answer(sent), busy: n === 0 }; },
    { virtual: true, timeout: 60, command: ({ action, sent, polls, clock }: any) => {
      if (action === 'snapshot' && sent && polls === 1 && !slow) {
        slow = true; return new Promise(resolve => clock.setTimeout(() => resolve({ url, model: selection.displayModel, ...answer(prompt), busy: false }), 12_000));
      }
    } });
  expect(result.events.at(-1)).toMatchObject({ event: 'complete', response: 'verified answer', ownership: 'exact' });
  expect(result.events.some(e => e.stage === 'poll' && e.outcome === 'read-grace')).toBe(true);
  expect(result.actions.filter(a => a === 'send')).toHaveLength(1);
});

test('cancel during a slow read confirms within 15 seconds and never completes', async () => {
  let slow = false, prompt = '', cancelAt = 0;
  const result = await runFake((sent, n) => { prompt = sent; return { ...answer(sent), busy: n < 2 }; },
    { virtual: true, timeout: 60, command: ({ action, sent, polls, clock, run }: any) => {
      if (action === 'snapshot' && sent && polls === 1 && !slow) {
        slow = true;
        clock.setTimeout(() => { run.cancel = true; cancelAt = clock.Date.now(); }, 1000);
        return new Promise(resolve => clock.setTimeout(() => resolve({ url, model: selection.displayModel, ...answer(prompt), busy: true }), 12_000));
      }
    } });
  expect(result.events.at(-1)).toMatchObject({ event: 'cancelled' });
  expect(result.events.some(e => e.event === 'complete')).toBe(false);
  expect(result.actions.filter(a => a === 'stop')).toHaveLength(1);
  expect(cancelAt).toBeGreaterThan(0);
  expect(result.elapsedMs! - cancelAt).toBeLessThanOrEqual(15_000);
});

test('1000 changed polls coalesce full frames below 3 MB with byte-exact revisions and final/error flushes', async () => {
  const text = ('Synthetic answer.\n'.repeat(3000)).slice(0, 48_000);
  const results: any[] = [];
  for (const fail of [false, true]) {
    const result = await runFake((prompt, n) => {
      if (fail && n === 1000) throw Error('Synthetic mid-stream failure.');
      let current = text.slice(0, Math.max(1, Math.floor(Math.min(n + 1, 1000) * text.length / 1000)));
      if (n === 500) current = 'shrunk';
      if (n === 700) current = 'Revised non-append text. ' + current;
      return { ...answer(prompt), busy: n < 1000, replies: [{ ...answer(prompt).replies[0], text: current, complete: n >= 1000 }] };
    }, { virtual: true, timeout: 180 });
    const frames = result.events.filter(e => e.event === 'response');
    const bytes = Buffer.byteLength(result.events.map(e => JSON.stringify(e) + '\n').join(''));
    expect(bytes).toBeLessThan(3_000_000);
    expect(frames.length).toBeLessThanOrEqual(102);
    expect(frames.at(-1).text).toBe(text);
    expect(frames.some(e => e.text === 'shrunk')).toBe(true);
    expect(frames.some(e => e.text.startsWith('Revised non-append'))).toBe(true);
    expect(result.events.at(-1).event).toBe(fail ? 'error' : 'complete');
    if (!fail) expect(result.events.at(-1).response).toBe(text);
    results.push({ terminal: result.events.at(-1).event, answerBytes: Buffer.byteLength(text), changedPolls: 1000, responseFrames: frames.length, jsonlBytes: bytes });
  }
  console.log('Gemini volume metrics: ' + JSON.stringify(results));
});

test('pending user ID rebinds to the server ID when the first conversation URL arrives', async () => {
  const result = await runFake((prompt, n) => n === 0 ? {
    url: 'https://gemini.google.com/app', users: [{ id: 'user-query-content-pending', text: prompt }], replies: [],
  } : answer(prompt), { prompt: 'Reply with READY.\nNo preamble.' });
  expect(result.events.at(-1)).toMatchObject({ event: 'complete', sessionId: sid, ownership: 'exact', rebindCount: 1 });
  expect(result.events.filter(e => e.event === 'ownership').map(e => [e.userId, e.rebindCount])).toEqual([
    ['user-query-content-pending', 0], [uid, 1],
  ]);
  expect(result.events.filter(e => e.event !== 'command').map(e => e.event).slice(0, 4)).toEqual(['submitting', 'session', 'ownership', 'ownership']);
  expect(result.actions.filter(a => a === 'send')).toHaveLength(1);
});

const identifiedAnswer = (prompt: string, id: string) => ({
  users: [{ id, text: prompt }], replies: [{ id: rid, userId: id, text: 'verified answer', busy: 'false', complete: true }],
});

test('two user-element rerenders each emit a rebind even without a change of evidence level', async () => {
  const ids = ['user-query-content-pending', 'user-query-content-rerender', uid];
  const result = await runFake((prompt, n) => ({ ...identifiedAnswer(prompt, ids[Math.min(n, 2)]), busy: n < 2 }));
  expect(result.events.at(-1)).toMatchObject({ event: 'complete', rebindCount: 2 });
  expect(result.events.filter(e => e.event === 'ownership').map(e => [e.userId, e.rebindCount])).toEqual(ids.map((id, n) => [id, n]));
  expect(result.actions.filter(a => a === 'send')).toHaveLength(1);
});

test('multiple pre-session bindings are queued in order rather than losing the first binding', async () => {
  const ids = ['user-query-content-first', 'user-query-content-second', uid];
  const result = await runFake((prompt, n) => n < 2 ? { url: 'https://gemini.google.com/app', users: [{ id: ids[n], text: prompt }], replies: [] } : answer(prompt));
  expect(result.events.at(-1)).toMatchObject({ event: 'complete', rebindCount: 2 });
  expect(result.events.filter(e => e.event === 'ownership').map(e => e.userId)).toEqual(ids);
  expect(result.events.findIndex(e => e.event === 'session')).toBeLessThan(result.events.findIndex(e => e.event === 'ownership'));
});

test('collapsed synthetic long prompt rebinds with marker evidence', async () => {
  const result = await runFake((prompt, n) => ({ ...identifiedAnswer(flat(prompt), n === 0 ? 'user-query-content-pending' : uid), busy: n === 0 }));
  expect(result.events.at(-1)).toMatchObject({ event: 'complete', ownership: 'marker', rebindCount: 1 });
  expect(result.events.filter(e => e.event === 'ownership').map(e => e.ownership)).toEqual(['marker', 'marker']);
});

test('prefix rebinding requires identical normalized visible text; stronger proof can replace a prefix', () => {
  const prefix = flat(brief).slice(0, 450), row = (id: string, text: string) => [{ id, text }];
  const first = 'user-query-content-first';
  const tracker = safety.createOwnershipTracker([], brief, marker);
  tracker.update(row(first, 'You said\n' + prefix + '…\nShow more'), 0);
  expect(tracker.update(row(uid, 'Bạn đã nói\n' + prefix.replaceAll(' ', '\n') + '…\nXem thêm'), 10).transition)
    .toMatchObject({ ownership: 'prefix', previousUserId: first, sameVisibleText: true, rebindCount: 1 });
  expect(tracker.update(row('user-query-content-final', marker + '\n' + brief), 20).transition).toMatchObject({ ownership: 'exact', rebindCount: 2 });
  const changed = safety.createOwnershipTracker([], brief, marker);
  changed.update(row(first, prefix), 0);
  expect(() => changed.update(row(uid, flat(brief).slice(0, 500)), 10)).toThrow('visible text');
  expect(() => changed.update(row(uid, prefix), 20)).toThrow('already failed');
  const weaker = safety.createOwnershipTracker([], brief, marker);
  weaker.update(row(first, marker + '\n' + brief), 0);
  expect(() => weaker.update(row(uid, prefix), 10)).toThrow('visible text');
});

test('a qualifying user disappearing beyond one second fails even if it then reappears', () => {
  const tracker = safety.createOwnershipTracker([], brief, marker), users = [{ id: uid, text: marker + '\n' + brief }];
  tracker.update(users, 0);
  expect(tracker.update([], 10)).toBeNull();
  expect(tracker.update([], 1009)).toBeNull();
  expect(() => tracker.update(users, 1010)).toThrow('1000 ms grace');
});

test('a short disappearing/empty render gap permits rebind but cannot return a reply during the gap', async () => {
  const result = await runFake((prompt, n) => n === 0 ? { ...identifiedAnswer(prompt, 'user-query-content-pending'), busy: true } : n < 3 ? {
    users: n === 1 ? [] : [{ id: uid, text: '' }], replies: [{ id: rid, userId: 'foreign', text: 'UNOWNED GAP ANSWER', busy: 'false', complete: true }],
  } : answer(prompt));
  expect(result.events.at(-1)).toMatchObject({ event: 'complete', rebindCount: 1 });
  expect(JSON.stringify(result.events)).not.toContain('UNOWNED GAP ANSWER');
});

test('a permanently disappearing owned turn fails after grace with ID-only diagnostics', async () => {
  const result = await runFake((prompt, n) => n === 0 ? { ...answer(prompt), busy: true } : { users: [], replies: [] });
  expect(result.events.at(-1)).toMatchObject({ event: 'error', ownership: 'unverified', ownershipObservations: [[{ userId: uid, level: 'exact' }], []] });
  expect(result.events.at(-1).message).toContain('1000 ms grace');
  expect(result.events.some(e => e.event === 'complete')).toBe(false);
});

test('a genuinely second new turn fails closed after an earlier owned binding and records IDs/levels only', async () => {
  const initial = 'user-query-content-pending', foreign = 'user-query-content-foreign';
  const result = await runFake((prompt, n) => n === 0 ? { ...identifiedAnswer(prompt, initial), busy: true } : {
    ...answer(prompt), users: [{ id: uid, text: flat(prompt) }, { id: foreign, text: 'unrelated concurrent question' }], busy: true,
  });
  const error = result.events.at(-1);
  expect(error).toMatchObject({ event: 'error', ownership: 'unverified', rebindCount: 0, ownershipObservations: [
    [{ userId: initial, level: 'exact' }], [{ userId: uid, level: 'marker' }, { userId: foreign, level: 'unverified' }],
  ] });
  expect(Object.keys(error.ownershipObservations[0][0]).sort()).toEqual(['level', 'userId']);
  expect(JSON.stringify(error)).not.toContain('unrelated concurrent question');
  expect(JSON.stringify(error)).not.toContain(brief.slice(0, 60));
  expect(result.events.some(e => e.event === 'complete')).toBe(false);
  expect(result.actions).not.toContain('stop');
  expect(result.actions.filter(a => a === 'send')).toHaveLength(1);
});

test('rebinding cannot follow a changed conversation or read a reply attached to the old user ID', async () => {
  for (const mode of ['conversation', 'reply']) {
    const initial = 'user-query-content-pending';
    const result = await runFake((prompt, n) => n === 0 ? { ...identifiedAnswer(prompt, initial), busy: true } : {
      ...answer(prompt), ...(mode === 'conversation' ? { url: 'https://gemini.google.com/app/ffffffffffffffff' } :
        { replies: [{ ...answer(prompt).replies[0], userId: initial, text: 'UNOWNED OLD REPLY' }] }),
    });
    expect(result.events.at(-1).event).toBe('error');
    expect(result.events.at(-1).ownershipObservations.at(-1)).toEqual([{ userId: uid, level: 'exact' }]);
    expect(result.events.some(e => e.event === 'complete')).toBe(false);
    expect(JSON.stringify(result.events)).not.toContain('UNOWNED OLD REPLY');
    expect(result.actions).not.toContain('stop');
  }
});

test('explicit cancellation stops the currently rebound user turn exactly once', async () => {
  const result = await runFake((prompt, n) => {
    const snapshot = identifiedAnswer(prompt, n === 0 ? 'user-query-content-pending' : uid);
    snapshot.replies[0].complete = false;
    return { ...snapshot, busy: n < 2 };
  }, { cancelAt: 1 });
  expect(result.events.at(-1)).toMatchObject({ event: 'cancelled', rebindCount: 1 });
  expect(result.actions.filter(a => a === 'stop')).toHaveLength(1);
  expect(result.actions.filter(a => a === 'send')).toHaveLength(1);
});

test('error-path cancellation rebinds only with valid fresh evidence, not a concurrent foreign turn', async () => {
  for (const foreign of [false, true]) {
    const result = await runFake((prompt, n) => {
      const snapshot = identifiedAnswer(prompt, n === 0 ? 'user-query-content-pending' : uid);
      if (foreign && n > 0) snapshot.users.push({ id: 'user-query-content-foreign', text: 'unrelated' });
      return { ...snapshot, busy: true };
    }, { failSnapshotAt: 1 });
    expect(result.events.at(-1)).toMatchObject({ event: 'error', rebindCount: foreign ? 0 : 1, ownership: foreign ? 'unverified' : 'exact' });
    expect(result.actions.filter(a => a === 'stop')).toHaveLength(foreign ? 0 : 1);
    if (!foreign) expect(result.events.filter(e => e.event === 'ownership').at(-1)).toMatchObject({ userId: uid, rebindCount: 1 });
  }
});

test('full run sends exactly once and records exact, marker and prefix evidence through completion', async () => {
  for (const level of ['exact', 'marker', 'prefix']) {
    const result = await runFake(prompt => answer(level === 'exact' ? prompt : level === 'marker' ? flat(prompt) : flat(brief).slice(0, 450) + '…\nShow more'));
    expect(result.drafted).toMatch(/^\[ad:[a-f0-9]{16}\]\n/);
    expect(result.drafted.slice(result.drafted.indexOf('\n') + 1)).toBe(brief);
    expect(result.actions.filter(action => action === 'send')).toHaveLength(1);
    expect(result.events.find(e => e.event === 'ownership')?.ownership).toBe(level);
    expect(result.events.at(-1)).toMatchObject({ event: 'complete', ownership: level, sessionId: sid, response: 'verified answer' });
  }
});

test('foreign/concurrent turns fail without returning or stopping an unowned answer and retain recovery URL', async () => {
  for (const mode of ['foreign', 'two']) {
    const result = await runFake(prompt => ({ ...answer(prompt), users: mode === 'foreign' ? [{ id: uid, text: 'someone else' }] :
      [{ id: uid, text: prompt }, { id: 'user-query-content-foreign', text: 'someone else' }] }));
    expect(result.events.at(-1)).toMatchObject({ event: 'error', submitted: true, ownership: 'unverified', sessionId: sid, url });
    expect(result.events.some(e => e.event === 'response' || e.event === 'complete')).toBe(false);
    expect(result.actions.filter(action => action === 'send')).toHaveLength(1);
    expect(result.actions).not.toContain('stop');
  }
});

test('reply without matching preceding user is never returned, even when the marker is exact', async () => {
  const result = await runFake(prompt => ({ ...answer(prompt), replies: [{ ...answer(prompt).replies[0], userId: 'foreign' }] }));
  expect(result.events.at(-1).message).toContain('not tied');
  expect(result.events.some(e => e.event === 'response' || e.event === 'complete')).toBe(false);
});

test('lost send acknowledgement preserves recovery identity without a second send', async () => {
  const result = await runFake(answer, { sendThrows: true });
  expect(result.events.at(-1)).toMatchObject({ event: 'error', sessionId: sid, url, submitted: true });
  expect(result.events.some(e => e.event === 'response')).toBe(false);
  expect(result.actions.filter(action => action === 'send')).toHaveLength(1);
});

test('missing user render times out explicitly with a recoverable chat, not a stale answer', async () => {
  const result = await runFake(prompt => ({ ...answer(prompt), users: [] }), { timeout: 0.3 });
  expect(result.events.at(-1)).toMatchObject({ event: 'error', sessionId: sid, url, ownership: 'unverified' });
  expect(result.events.some(e => e.event === 'response')).toBe(false);
});

test('late second turn invalidates ownership rather than completing an earlier partial answer', async () => {
  const result = await runFake((prompt, n) => n === 0 ? { ...answer(prompt), busy: true } :
    { ...answer(prompt), users: [...answer(prompt).users, { id: 'user-query-content-late', text: 'foreign' }] });
  expect(result.events.at(-1)).toMatchObject({ event: 'error', ownership: 'unverified', sessionId: sid });
  expect(result.events.some(e => e.event === 'complete')).toBe(false);
});

test('temporarily empty visible text waits for hydration without returning an unowned reply', async () => {
  const result = await runFake((prompt, n) => n === 0 ? { ...answer(prompt), users: [{ id: uid, text: '' }] } : answer(prompt));
  expect(result.events.at(-1)).toMatchObject({ event: 'complete', ownership: 'exact' });
  expect(result.actions.filter(action => action === 'send')).toHaveLength(1);
});

test('a second turn disappearing during recovery must not be promoted to owned or stopped', async () => {
  const result = await runFake((prompt, n) => n === 0 ? { ...answer(prompt), busy: true, users: [...answer(prompt).users, { id: 'user-query-content-foreign', text: 'foreign' }] } :
    { ...answer(prompt), busy: true });
  expect(result.events.at(-1)).toMatchObject({ event: 'error', ownership: 'unverified' });
  expect(result.actions).not.toContain('stop');
});
