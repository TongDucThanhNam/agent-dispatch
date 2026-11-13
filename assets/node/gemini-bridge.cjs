'use strict';
// Loaded in Gemini's main process. No remote debugger, arbitrary-eval route or cookie export.
const { app, BaseWindow, WebContentsView, webContents, ipcMain } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const { normalized, matchesUserTurn, createOwnershipTracker, assertSafePrompt } = require('./gemini-safety.cjs');
const HOME = path.join(require('node:os').homedir(), '.agent-dispatch', 'gemini-bridge');
const manifestPath = path.join(HOME, 'runtime.json');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function bounded(promise, ms, message, context) {
  let timer;
  const deadline = Math.min(Date.now() + ms, context?.deadline ?? Infinity);
  try { return await Promise.race([promise, new Promise((_, reject) => {
    const poll = () => {
      if (context?.cancel) { reject(Error('Gemini preparation cancelled.')); return; }
      const remaining = deadline - Date.now();
      if (remaining <= 0) { reject(Object.assign(Error(message), { timeout: true })); return; }
      timer = setTimeout(poll, Math.min(100, remaining));
    };
    poll();
  })]); }
  finally { clearTimeout(timer); }
}
const origin = 'https://gemini.google.com';
const chatId = url => /^https:\/\/gemini\.google\.com\/app\/([a-f0-9]{16})(?:[?#]|$)/.exec(url)?.[1];
const trusted = url => { try { return new URL(url).origin === origin; } catch { return false; } };
let active = null, worker = null, server = null, selecting = false;
let cleanupWarnings = 0, lastCleanupMs = 0;
const seen = new Set();
const token = crypto.randomBytes(32).toString('hex');

// This function is serialized into the renderer, never supplied by a caller.
function pageCommand(action, value) {
  if (location.origin !== 'https://gemini.google.com') throw Error('Gemini login is required.');
  const visible = e => !!e && e.getClientRects().length > 0;
  const buttons = [...document.querySelectorAll('button')];
  const label = e => e.getAttribute('aria-label') || e.innerText || '';
  // Do not force layout for every historical copy/source/action button. Only
  // controls with a matching accessible label/text need a visibility check.
  const find = re => {
    // Hidden descendants can prefix/suffix textContent; keep the exact match
    // against the rendered label, using an unanchored prefilter only.
    const candidate = new RegExp(re.source.replace(/^\^|\$$/g, ''), re.flags);
    return buttons.find(e => candidate.test(e.getAttribute('aria-label') || e.textContent || '') && visible(e) && re.test(label(e).trim()));
  };
  const editor = [...document.querySelectorAll('[contenteditable="true"][role="textbox"], rich-textarea [contenteditable="true"], .ql-editor[contenteditable="true"]')].find(visible);
  const editorText = e => {
    if (!e) return '';
    const blocks = [...e.children];
    return blocks.length && [...e.childNodes].every(n => n.nodeType !== 3 || !n.textContent.trim()) && blocks.every(n => ['P', 'DIV'].includes(n.tagName))
      ? blocks.map(n => n.innerText.replace(/\n$/, '')).join('\n') : e.innerText;
  };
  const mode = find(/Mở công cụ chọn chế độ|Open mode picker|Open model picker/i);
  const modeLabel = mode ? label(mode).replace(/^.*?(?:hiện tại là|currently|current model(?: is)?)[,: ]*/i, '').trim() : '';
  const stop = find(/^(?:Ngừng tạo câu trả lời|Dừng|Stop response|Stop generating)/i);
  const send = find(/^(?:Gửi tin nhắn|Send message|Send)$/i);
  if (action.startsWith('menu-')) {
    if (!mode || stop || editor?.innerText.trim()) throw Error('Gemini must be idle with an empty draft before changing selection.');
    const items = () => [...document.querySelectorAll('[role="menuitem"], [role="menuitemradio"], [role="option"], .mat-mdc-menu-item, .cdk-overlay-container button')].filter(visible);
    const matches = (e, text) => [e.getAttribute('aria-label'), ...e.innerText.split('\n'), ...[...e.querySelectorAll('span')].map(n => n.innerText)]
      .some(s => typeof s === 'string' && s.trim() === text);
    const selected = e => e.getAttribute('aria-checked') === 'true' || e.getAttribute('aria-selected') === 'true' ||
      [...e.querySelectorAll('mat-icon, .material-icons, .material-symbols-outlined, .lumi-symbols')].some(n =>
        ['check', 'done', 'checkmark'].includes(n.textContent.trim()) && visible(n) && getComputedStyle(n).visibility !== 'hidden' && getComputedStyle(n).opacity !== '0');
    const describe = e => ({ text: e.innerText.trim(), label: e.getAttribute('aria-label'), role: e.getAttribute('role'), selected: selected(e),
      disabled: !!e.disabled || e.getAttribute('aria-disabled') === 'true', html: e.outerHTML });
    if (action === 'menu-open') {
      if (!items().length) mode.click();
    } else if (action === 'menu-click') {
      const found = items().filter(e => matches(e, value));
      if (found.length !== 1 || describe(found[0]).disabled) throw Error('Gemini selection item unavailable or ambiguous: ' + value);
      found[0].click();
    } else if (action === 'menu-close') {
      const backdrop = [...document.querySelectorAll('.cdk-overlay-backdrop')].find(visible);
      if (backdrop) backdrop.click(); else if (items().length) mode.click();
    } else if (action !== 'menu-read') throw Error('Invalid Gemini selection operation.');
    return { displayModel: modeLabel, items: items().map(describe) };
  }
  if (action === 'status') return { url: location.href, model: modeLabel, ready: !!editor && !!modeLabel, hasDraft: !!editor?.innerText.trim(), busy: !!stop };
  if (action === 'draft') {
    if (!editor || editor.innerText.trim() || stop) throw Error('Gemini editor is not empty and idle.');
    editor.focus({ preventScroll: true }); // DOM focus in our offscreen view, never native window focus.
    // Multiline insertText is extremely slow; insertHTML is blocked by Trusted
    // Types. Build text nodes in one fragment instead. The editor's mutation
    // observer/input path sees one replacement; caller markup is never parsed.
    if (value.includes('\n')) {
      const fragment = document.createDocumentFragment();
      for (const line of value.replace(/\r\n/g, '\n').split('\n')) {
        const p = document.createElement('p');
        p.append(line ? document.createTextNode(line) : document.createElement('br'));
        fragment.append(p);
      }
      editor.replaceChildren(fragment);
      editor.dispatchEvent(new InputEvent('input', { bubbles: true, composed: true, inputType: 'insertFromPaste', data: value }));
    } else if (!document.execCommand('insertText', false, value)) throw Error('Gemini editor rejected the prompt.');
  } else if (action === 'send') {
    if (!send || send.disabled || stop) throw Error('Gemini Send is unavailable.');
    send.click();
  } else if (action === 'stop') {
    if (stop) stop.click();
  } else if (action !== 'snapshot') throw Error('Invalid renderer operation.');
  if (action !== 'snapshot') return {};
  const oldUsers = new Set(value?.userIds), oldReplies = new Set(value?.replyIds);
  // Reading innerText forces layout, especially costly while Gemini renders
  // long markdown/math answers. Reuse streaming text until that element changes;
  // once Stop disappears, always read fresh text for ownership and completion.
  // takeRecords also sees mutations made before an observer callback can run.
  const cacheKey = Symbol.for('agent-dispatch.gemini.rendered-text');
  const cache = globalThis[cacheKey] ??= new WeakMap();
  const renderedText = (e, read = () => e.innerText) => {
    if (typeof MutationObserver !== 'function') return read();
    let entry = cache.get(e);
    if (!entry) {
      entry = { dirty: true, text: '', observer: new MutationObserver(() => { entry.dirty = true; }) };
      entry.observer.observe(e.closest?.('model-response') || e, { subtree: true, childList: true, characterData: true, attributes: true });
      cache.set(e, entry);
    }
    if (entry.observer.takeRecords().length) entry.dirty = true;
    if (!stop) entry.dirty = true;
    if (entry.dirty) { entry.text = read(); entry.dirty = false; }
    return entry.text;
  };
  const users = [], replies = [];
  let userId = null;
  // querySelectorAll returns document order: one pass associates replies without
  // U x R comparisons. Read no historical text, including during readiness.
  for (const e of document.querySelectorAll('[id^="user-query-content-"], [id^="model-response-message-content"]')) {
    if (e.id.startsWith('user-query-content-')) {
      userId = e.id;
      const user = { id: e.id };
      if (value && !oldUsers.has(e.id)) {
        user.text = renderedText(e, () => {
          const lines = [...e.querySelectorAll('.query-text-line')];
          return lines.length ? lines.map(line => line.innerText.replace(/\n$/, '')).join('\n') : e.innerText;
        });
      }
      users.push(user);
    } else {
      const reply = { id: e.id, userId };
      if (value && !oldReplies.has(e.id)) {
        reply.text = renderedText(e);
        reply.busy = e.getAttribute('aria-busy');
        reply.complete = !!e.closest('model-response')?.querySelector('.response-footer.complete');
      }
      replies.push(reply);
    }
  }
  return { url: location.href, model: modeLabel, ready: !!editor && !!modeLabel, hasDraft: !!editor?.innerText.trim(),
    draft: editorText(editor), busy: !!stop, users, replies, send: !!send && !send.disabled };
}
const commandContexts = new WeakMap(), pendingReads = new WeakMap();
const readActions = new Set(['status', 'snapshot', 'menu-read']);
const command = async (wc, action, value) => {
  if (wc.isDestroyed() || !trusted(wc.getURL())) throw Error('Gemini renderer is unavailable or signed out.');
  const context = commandContexts.get(wc), stage = context?.stage ?? action, started = Date.now();
  const diagnostic = outcome => ({ action, stage, elapsedMs: Date.now() - started, outcome });
  const record = outcome => {
    const detail = diagnostic(outcome);
    if (context) context.lastCommand = { action, stage, elapsedMs: detail.elapsedMs };
    if (context && !context.res.destroyed) emit(context, { event: 'command', ...detail });
  };
  // A timeout does not cancel executeJavaScript. A read's second chance waits on
  // that SAME execution, and a later caller must also join it, never overlap it.
  let reads = pendingReads.get(wc);
  if (!reads) { reads = new Map(); pendingReads.set(wc, reads); }
  const start = () => {
    const pending = readActions.has(action) && reads.get(action);
    if (pending) return pending;
    const execution = Promise.resolve().then(() => wc.executeJavaScript(`(${pageCommand.toString()})(${JSON.stringify(action)},${JSON.stringify(value ?? null)})`, true));
    if (readActions.has(action)) {
      reads.set(action, execution);
      const clear = () => { if (reads.get(action) === execution) reads.delete(action); };
      execution.then(clear, clear);
    }
    return execution;
  };
  let execution;
  // Draft insertion may be large, but still gets exactly one execution. Sending
  // keeps its short bound and is NEVER retried. Turn/cancel deadlines win below.
  const limit = action === 'draft' ? 60_000 : readActions.has(action) ? 20_000 : 10_000;
  let warned = false, retried = false;
  try {
    // Small waits notice cancellation without cancelling the underlying renderer.
    while (true) {
      if (context?.cancel) context.cancelDeadline ??= Date.now() + 15_000;
      const remaining = Math.min(started + limit, context?.deadline ?? Infinity, context?.cancelDeadline ?? Infinity) - Date.now();
      if (remaining <= 0) {
        const detail = diagnostic('timeout');
        throw Object.assign(Error(`Gemini renderer timeout: action=${action}, stage=${stage}, elapsedMs=${detail.elapsedMs}.`), detail);
      }
      execution ??= start();
      const waiting = Symbol();
      let timer;
      let result;
      try {
        result = await Promise.race([execution, new Promise(resolve => { timer = setTimeout(() => resolve(waiting), Math.min(100, remaining)); })])
          .finally(() => clearTimeout(timer));
      } catch (error) {
        // Only a settled execution may be repeated. Keep the original total
        // budget; an immediate non-timeout renderer error is not retried.
        if (!warned || retried || !readActions.has(action)) throw error;
        retried = true; record('read-retry'); execution = null; continue;
      }
      if (result !== waiting) { record('ok'); return result; }
      if (!warned && Date.now() - started >= 10_000 && readActions.has(action)) { warned = true; record('read-grace'); }
    }
  } catch (error) { record(error.outcome === 'timeout' ? 'timeout' : 'error'); throw error; }
};
const mainContent = () => {
  const items = webContents.getAllWebContents().filter(wc => !wc.isDestroyed() && wc !== worker?.webContents && trusted(wc.getURL()) && wc.getURL().startsWith(origin + '/app'));
  if (items.length !== 1) throw Error('Expected exactly one signed-in Gemini app view.');
  return items[0];
};
async function status() {
  const wc = mainContent(), s = await command(wc, 'status');
  return { event: 'status', worker: 'gemini', backend: 'desktop-bridge', version: app.getVersion(), pid: process.pid,
    ready: s.ready, model: s.model, url: s.url, hasDraft: s.hasDraft, busy: !!active || selecting, userBusy: s.busy,
    backgroundOnly: true,
    resources: { workerOpen: !!worker, workerIdle: !!worker?.idle, cachedTurns: worker?.turns ?? 0,
      frameRate: 5, cleanupWarnings, lastCleanupMs },
    capabilities: ['offscreen-renderer', 'non-activating-window', 'owned-response-completion', 'turn-ownership-v2', 'model-selection', 'thinking-level-selection', 'stream', 'resume', 'cancel'] };
}
async function inspectSelection(wc) {
  await command(wc, 'menu-open');
  for (let i = 0; i < 30; i++) {
    const menu = await command(wc, 'menu-read');
    if (menu.items.length) return menu;
    await sleep(100);
  }
  throw Error('Gemini model menu did not open.');
}
function menuItem(menu, title) {
  const items = menu.items.filter(item => item.label === title || item.text.split('\n').some(line => line.trim() === title));
  if (items.length !== 1) throw Error('Gemini selection item unavailable or ambiguous: ' + title);
  return items[0];
}
async function selectModel(wc, model, effort) {
  const labels = { low: ['Thấp', 'Low'], medium: ['Trung bình', 'Medium'], high: ['Cao', 'High'] }[effort];
  if (!labels || typeof model !== 'string' || !model.trim()) throw Error('Invalid Gemini model or thinking level.');
  try {
    let menu = await inspectSelection(wc);
    if (!menuItem(menu, model).selected) { await command(wc, 'menu-click', model); await sleep(200); }
    menu = await inspectSelection(wc);
    if (!menuItem(menu, model).selected) throw Error('Gemini did not confirm the requested model.');
    const thinking = ['Cấp độ tư duy', 'Thinking level', 'Thinking depth'].find(label => menu.items.some(item => item.text.split('\n').some(line => line.trim() === label)));
    if (!thinking) throw Error('Gemini thinking-level menu is unavailable.');
    await command(wc, 'menu-click', thinking); await sleep(200);
    let levels = await command(wc, 'menu-read');
    const desired = labels.find(label => levels.items.some(item => item.text.split('\n').some(line => line.trim() === label)));
    if (!desired) throw Error('Gemini requested thinking level is unavailable.');
    if (!menuItem(levels, desired).selected) {
      await command(wc, 'menu-click', desired); await sleep(200);
      menu = await inspectSelection(wc);
      if (!menuItem(menu, model).selected) throw Error('Gemini model changed while selecting thinking level.');
      await command(wc, 'menu-click', thinking); await sleep(200);
      levels = await command(wc, 'menu-read');
    }
    if (!menuItem(levels, desired).selected) throw Error('Gemini did not confirm the requested thinking level.');
    await command(wc, 'menu-close');
    const state = await command(wc, 'status');
    return { model, effort, effortLabel: desired, displayModel: state.model, verified: true };
  } finally {
    // A lost close acknowledgement is ambiguous too: inspect before repeating.
    try { if ((await command(wc, 'menu-read')).items.length) await command(wc, 'menu-close'); } catch {}
  }
}
async function createWorker(url, context) {
  if (context?.cancel) throw Error('Gemini preparation cancelled.');
  if (worker) {
    const cached = worker, wc = cached.webContents;
    clearTimeout(cached.idleTimer);
    if (cached.idle && cached.turns < 32 && !cached.isDestroyed() && !wc.isDestroyed() &&
        chatId(url) && chatId(url) === cached.sessionId && chatId(wc.getURL()) === cached.sessionId) {
      cached.idle = false;
      if (context) commandContexts.set(wc, context);
      wc.startPainting();
      const snapshot = await command(wc, 'snapshot');
      if (!snapshot.ready || snapshot.busy || snapshot.hasDraft || chatId(snapshot.url) !== cached.sessionId)
        throw Error('Cached Gemini conversation is not idle and ready.');
      return { wc, snapshot };
    }
    await disposeWorker();
  }
  const source = mainContent(), prefs = source.getLastWebPreferences();
  // Gemini redirects every BrowserWindow popup into its main chat. A dedicated
  // BaseWindow + WebContentsView avoids that popup flow without removing guards.
  const win = new BaseWindow({ show: false, focusable: false, skipTaskbar: true, width: 1200, height: 900 });
  if (win.isFocusable() || win.isVisible()) { win.destroy(); throw Error('Gemini worker window must remain hidden and non-focusable.'); }
  const view = new WebContentsView({ webPreferences: { session: source.session, preload: prefs.preload,
    nodeIntegration: false, contextIsolation: true, sandbox: true, backgroundThrottling: false, offscreen:true } });
  const wc = view.webContents;
  if (context) commandContexts.set(wc, context);
  win.contentView.addChildView(view); view.setBounds({ x: 0, y: 0, width: 1200, height: 900 });
  const owned = worker = { webContents: wc, window: win, idle: false, turns: 0, retiring: false,
    isDestroyed: () => win.isDestroyed(), destroy: () => {
    try { if (!wc.isDestroyed()) wc.close(); } finally { if (!win.isDestroyed()) win.destroy(); }
  } };
  wc.setUserAgent(source.getUserAgent());
  wc.setWindowOpenHandler(() => ({ action: 'deny' }));
  let blocked = null, rendererFailure = null;
  const guard = (event, target) => {
    if (owned.retiring && target === 'about:blank') return;
    if (!trusted(target)) {
      try {
        const host = new URL(target).hostname;
        blocked = host === 'accounts.google.com' ? 'authentication' : host === 'consent.google.com' ? 'consent' :
          ['google.com', 'www.google.com'].includes(host) && new URL(target).pathname.startsWith('/sorry') ? 'challenge' : 'external';
      } catch { blocked = 'external'; }
      event.preventDefault();
    }
  };
  wc.on('will-navigate', guard); wc.on('will-redirect', guard);
  wc.on('render-process-gone', (_event, detail) => { rendererFailure = /^[a-z-]{1,32}$/.test(detail?.reason) ? detail.reason : 'unknown'; });
  const navigationStarted = Date.now();
  const recordNavigation = outcome => {
    const detail = { action: 'navigate', stage: context?.stage ?? 'readiness', elapsedMs: Date.now() - navigationStarted };
    if (context) { context.lastCommand = detail; if (!context.res.destroyed) emit(context, { event: 'command', ...detail, outcome }); }
    return detail;
  };
  for (let attempt = 0; ; attempt++) {
    try {
      if (context?.cancel) throw Error('Gemini preparation cancelled.');
      if (Date.now() >= (context?.deadline ?? Infinity)) throw Object.assign(Error('Gemini background load timed out.'), { timeout: true });
      await bounded(wc.loadURL(url), 20_000, 'Gemini background load timed out.', context);
      recordNavigation('ok'); break;
    } catch (error) {
      const code = error.code ?? /^(ERR_[A-Z_]+) \(-?\d+\) loading/.exec(error.message)?.[1];
      // Only a settled, transient navigation failure can be repeated, and only
      // before any draft/send. Never retry timed-out outstanding loads or auth redirects.
      if (!attempt && !blocked && !rendererFailure && !context?.cancel && Date.now() + 300 < (context?.deadline ?? Infinity) &&
          ['ERR_FAILED', 'ERR_CONNECTION_RESET', 'ERR_CONNECTION_CLOSED', 'ERR_CONNECTION_ABORTED', 'ERR_INTERNET_DISCONNECTED', 'ERR_TIMED_OUT', 'ERR_NAME_NOT_RESOLVED'].includes(code)) {
        recordNavigation('read-retry'); await sleep(300); continue;
      }
      const detail = recordNavigation(error.timeout ? 'timeout' : 'error');
      throw Object.assign(Error(blocked ? 'Gemini background navigation left the trusted origin (' + blocked + '); inspect the app manually.' :
        rendererFailure ? 'Gemini background renderer exited (' + rendererFailure + ').' :
        context?.cancel ? 'Gemini preparation cancelled.' : 'Gemini background navigation failed' + (code ? ' (' + code + ')' : '') + '.'), detail);
    }
  }
  wc.debugger.attach('1.3');
  await bounded(wc.debugger.sendCommand('Emulation.setFocusEmulationEnabled', { enabled: true }), 5000, 'Gemini renderer activation failed.', context);
  if (!wc.isOffscreen()) throw Error('Gemini did not create an offscreen renderer.');
  wc.setFrameRate(5); wc.startPainting();
  for (let i = 0; i < 120; i++) {
    const s = await command(wc, 'snapshot');
    // A timed-out/refused turn may have a user message but no assistant node.
    // Waiting for a reply here makes that otherwise idle conversation unusable.
    if (s.ready && (!chatId(url) || chatId(s.url) === chatId(url) && s.users.length)) {
      context = null; // Event listeners must not retain a completed run/HTTP response.
      return { wc, snapshot: s };
    }
    await sleep(250);
  }
  throw Error('The background Gemini renderer did not become ready.');
}
async function disposeWorker() {
  if (worker) await cleanWorker(worker, true);
}
async function cleanWorker(owned, discard) {
  const started = Date.now();
  if (!owned) return;
  clearTimeout(owned.idleTimer);
  owned.idle = false;
  commandContexts.delete(owned.webContents);
  pendingReads.delete(owned.webContents);
  let failed = false;
  try {
    const wc = owned.webContents;
    if (!discard && (wc.isDestroyed() || owned.isDestroyed())) throw Error('Gemini worker disappeared before retention.');
    if (!wc.isDestroyed()) {
      wc.stopPainting();
      if (discard) {
        owned.retiring = true;
        await bounded(wc.loadURL('about:blank'), 1000, 'Gemini worker blanking timed out.');
      }
      if (wc.debugger.isAttached?.() !== false)
        await bounded(wc.debugger.sendCommand('HeapProfiler.collectGarbage'), 3000, 'Gemini worker collection timed out.');
    }
  } catch { failed = true; cleanupWarnings++; }
  finally {
    if (discard || failed) {
      try { owned.destroy(); } catch { cleanupWarnings++; }
      if (worker === owned) worker = null;
    }
    lastCleanupMs = Date.now() - started;
  }
  return !discard && !failed;
}
async function retainWorker(sessionId) {
  const owned = worker;
  if (!owned) return;
  if (!/^gemini_[a-f0-9]{16}$/.test(sessionId)) { await disposeWorker(); return; }
  if (!await cleanWorker(owned, false)) return;
  owned.sessionId = sessionId.slice(7); owned.turns++; owned.idle = true;
  owned.idleTimer = setTimeout(() => {
    if (worker !== owned || !owned.idle || active || selecting) return;
    selecting = true; // Serialize idle retirement with new requests.
    void disposeWorker().finally(() => { selecting = false; });
  }, 30_000);
  owned.idleTimer.unref?.();
}
const completedReply = reply => !!reply?.text.trim() && reply.busy === 'false' && reply.complete === true;
function emit(run, frame) {
  if (run.res.destroyed) throw Error('Dispatcher disconnected; completion is unconfirmed.');
  run.res.write(JSON.stringify(frame) + '\n');
}
async function runPrompt(run) {
  const req = run.request, deadline = Date.now() + req.timeoutSeconds * 1000;
  run.deadline = deadline; run.stage = 'readiness';
  const target = req.sessionId ? origin + '/app/' + req.sessionId.slice(7) : origin + '/app';
  // 64 random bits, first line: survives most collapsed renderings. Never reuse on resume.
  let marker;
  do { marker = '[ad:' + crypto.randomBytes(8).toString('hex') + ']'; } while (req.prompt.includes(marker));
  const sentPrompt = marker + '\n' + req.prompt;
  let before, selection, ownershipTracker, skeleton;
  let pendingResponse = null, emittedAt = -Infinity;
  const flushResponse = () => {
    if (!pendingResponse || run.res.destroyed) return;
    emit(run, pendingResponse); pendingResponse = null; emittedAt = Date.now();
  };
  const snapshot = wc => command(wc, 'snapshot', skeleton);
  const checkReplies = s => {
    if (new Set(s.replies.map(r => r.id)).size !== s.replies.length) throw Error('Gemini response history has duplicate IDs.');
  };
  const pendingOwnership = [];
  const flushOwnership = () => {
    while (run.sessionId && pendingOwnership.length) {
      emit(run, { event: 'ownership', sessionId: run.sessionId, ...pendingOwnership[0] });
      pendingOwnership.shift();
    }
  };
  const bind = users => {
    run.ownership = null;
    const owned = ownershipTracker.update(users);
    if (owned) {
      run.userId = owned.userId; run.ownership = owned.level;
      if (owned.transition) { flushResponse(); pendingOwnership.push(owned.transition); }
      flushOwnership();
    }
    return owned;
  };
  const rememberConversation = url => {
    const id = chatId(url);
    if (req.sessionId && id !== req.sessionId.slice(7) || run.sessionId && id !== run.sessionId.slice(7)) throw Error('Gemini changed conversation during the turn.');
    if (!id) return;
    if (!run.sessionId) {
      run.sessionId = 'gemini_' + id; run.url = origin + '/app/' + id;
      emit(run, { event: 'session', sessionId: run.sessionId, url: run.url, ownership: 'unverified', model: selection.model, effort: selection.effort, selection });
      flushOwnership(); // Includes the first binding, even if it preceded the session URL.
    }
  };
  try {
    assertSafePrompt(req.prompt, req.allowEmails);
    const created = await createWorker(target, run), wc = created.wc;
    commandContexts.set(wc, run);
    before = created.snapshot; run.wc = wc;
    checkReplies(before);
    skeleton = { userIds: before.users.map(u => u.id), replyIds: before.replies.map(r => r.id) };
    ownershipTracker = createOwnershipTracker(before.users, req.prompt, marker);
    if (before.hasDraft || before.busy || (req.sessionId && chatId(before.url) !== req.sessionId.slice(7))) throw Error('Background conversation is not the requested idle chat.');
    if (run.cancel) { emit(run, { event: 'cancelled', beforeSubmission: true, sessionId: null }); return; }
    run.stage = 'selection';
    selection = await selectModel(wc, req.model, req.effort);
    const oldReplies = new Set(before.replies.map(r => r.id));
    run.stage = 'draft';
    await command(wc, 'draft', sentPrompt);
    await sleep(100);
    run.stage = 'draft-verification';
    const drafted = await snapshot(wc);
    if (normalized(drafted.draft) !== normalized(sentPrompt)) throw Error('Gemini prompt verification failed before sending.');
    for (let i = 0; i < 40; i++) {
      if ((await snapshot(wc)).send) break;
      await sleep(100);
    }
    if (run.cancel) { emit(run, { event: 'cancelled', beforeSubmission: true, sessionId: null }); return; }
    // Recheck immediately before the one and only send; do not submit into a changed chat.
    run.stage = 'pre-send';
    const presend = await snapshot(wc);
    checkReplies(presend);
    if (presend.users.length !== before.users.length || before.users.some((u, i) => presend.users[i]?.id !== u.id) || presend.busy || presend.url !== before.url) {
      ownershipTracker.observe(presend.users);
      throw Error('Gemini conversation changed before delivery.');
    }
    if (normalized(presend.draft) !== normalized(sentPrompt)) throw Error('Gemini prompt changed before sending.');
    if (presend.model !== selection.displayModel) throw Error('Gemini selection changed before delivery.');
    if (run.cancel) { emit(run, { event: 'cancelled', beforeSubmission: true, sessionId: null }); return; }
    emit(run, { event: 'submitting', marker, ownership: 'unverified', model: selection.model, effort: selection.effort, selection });
    run.submitted = true; // No send retry, even if the renderer call fails.
    run.stage = 'send';
    await command(wc, 'send');
    let response = '', responseId = null, changedAt = Date.now(), stopAt = 0;
    while (Date.now() < deadline) {
      run.stage = run.cancel ? 'cancel-confirmation' : 'poll';
      const s = await snapshot(wc), id = chatId(s.url);
      run.ownership = null; // A failed identity/selection check must not reuse an earlier poll's proof.
      checkReplies(s);
      ownershipTracker.observe(s.users);
      if (s.model !== selection.displayModel) throw Error('Gemini model or thinking level changed during the turn.');
      // Recovery identity is recorded before any ownership decision, even on failure.
      rememberConversation(s.url);
      const owned = bind(s.users);
      if (run.sessionId && owned) {
        const fresh = s.replies.filter(r => !oldReplies.has(r.id));
        if (fresh.length > 1) throw Error('Gemini returned multiple unowned responses.');
        if (fresh[0] && fresh[0].userId !== owned.userId) throw Error('Gemini response is not tied to the owned user turn.');
        if (fresh[0]?.text.trim()) {
          if (responseId && fresh[0].id !== responseId) throw Error('Gemini changed assistant turn.');
          responseId = fresh[0].id;
          if (fresh[0].text !== response) {
            response = fresh[0].text; changedAt = Date.now();
            pendingResponse = { event: 'response', sessionId: run.sessionId, ownership: run.ownership, responseId, text: response };
            if (Date.now() - emittedAt >= 1000) flushResponse();
          }
        }
        if (!run.cancel && completedReply(fresh[0]) && response && !s.busy && Date.now() - changedAt >= 300) {
          flushResponse();
          run.retainWorker = true;
          emit(run, { event: 'complete', sessionId: run.sessionId, ownership: run.ownership, rebindCount: ownershipTracker.rebindCount, responseId, response, url: s.url, model: selection.model, effort: selection.effort, selection,
            completionSource: run.completed === 'c_' + id ? 'native-turn-lifecycle-and-dom' : 'owned-response-dom' }); return;
        }
        if (run.cancel) {
          if (!stopAt && s.busy) { await command(wc, 'stop'); stopAt = Date.now(); }
          if (!s.busy) { run.retainWorker = true; flushResponse(); emit(run, { event: 'cancelled', sessionId: run.sessionId, rebindCount: ownershipTracker.rebindCount }); return; }
          if (stopAt && Date.now() - stopAt > 15_000) throw Error('Gemini cancellation is unconfirmed.');
        }
      }
      await sleep(100);
    }
    throw Error('Gemini completion is unconfirmed: response deadline exceeded. Do not resend automatically.');
  } catch (error) {
    run.retainWorker = false;
    if (run.cancel && !run.submitted) {
      if (!run.res.destroyed) emit(run, { event: 'cancelled', beforeSubmission: true, sessionId: null });
      return; // A pending draft execution cannot submit; finally destroys its view.
    }
    flushResponse(); // Keep the last checked text/proof ahead of reconciliation transitions.
    const failure = error.action ? { action: error.action, stage: error.stage, elapsedMs: error.elapsedMs } : run.lastCommand;
    // Never stop another view. This renderer is leased exclusively to this run.
    const wasOwned = !!run.ownership;
    run.ownership = null;
    run.stage = 'error-reconciliation';
    // The expired turn deadline must not forbid cleanup itself. Allow a short,
    // separate read/stop budget, still bounded by an existing cancellation
    // deadline. No completion or send is possible on this error-only path.
    run.deadline = Math.min(Date.now() + 10_000, run.cancelDeadline ?? Infinity);
    if (run.submitted && run.wc && !run.wc.isDestroyed()) {
      try {
        const s = await snapshot(run.wc);
        checkReplies(s);
        ownershipTracker?.observe(s.users);
        rememberConversation(s.url);
        // The same evidence rules permit a renderer rebind on cancellation, never an ambiguous turn.
        const owned = wasOwned && ownershipTracker && bind(s.users);
        const fresh = s.replies.filter(reply => !before.replies.some(old => old.id === reply.id));
        if (owned && fresh.length <= 1 && fresh.every(reply => reply.userId === owned.userId) && s.busy) await command(run.wc, 'stop');
      } catch {}
    }
    if (run.submitted && !run.sessionId && run.wc && !run.wc.isDestroyed()) {
      try { rememberConversation(run.wc.getURL()); } catch {}
    }
    if (!run.res.destroyed) emit(run, { event: 'error', message: error.message + (run.submitted ? ' Submission may have happened; do not resend automatically.' : ''),
      ...failure,
      sessionId: run.sessionId ?? req.sessionId ?? null, url: run.url ?? (req.sessionId ? target : null),
      submitted: !!run.submitted, ownership: run.ownership ?? 'unverified', rebindCount: ownershipTracker?.rebindCount ?? 0,
      ownershipObservations: ownershipTracker?.observations ?? [] });
  } finally {
    // Do not release the transport/turn lock until the worker has been cleaned.
    try {
      if (run.retainWorker && !run.res.destroyed) await retainWorker(run.sessionId);
      else await disposeWorker();
    } finally { active = null; run.res.end(); }
  }
}

ipcMain.on('gemini:notify-turn-lifecycle', (event, value) => {
  if (!active || event.sender !== worker?.webContents || !trusted(event.senderFrame?.url || '') || !/^c_[a-f0-9]{16}$/.test(value?.conversationId)) return;
  if (value.phase === 'start') active.started = value.conversationId;
  if (value.phase === 'complete' && active.submitted) active.completed = value.conversationId;
});
async function body(req) {
  const chunks = []; let size = 0;
  for await (const chunk of req) { size += chunk.length; if (size > 2_000_000) throw Error('Request too large.'); chunks.push(chunk); }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}
async function handle(req, res) {
  const json = (code, value) => { res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(value)); };
  const supplied = req.headers['x-agent-dispatch-token'];
  if (req.headers.origin || req.headers.host !== `127.0.0.1:${server.address().port}` || typeof supplied !== 'string' || Buffer.byteLength(supplied) !== token.length ||
      !crypto.timingSafeEqual(Buffer.from(supplied), Buffer.from(token))) { json(403, { error: 'Forbidden.' }); return; }
  try {
    if (req.method === 'GET' && req.url === '/status') { json(200, await status()); return; }
    if (req.url === '/selection' && ['GET', 'POST'].includes(req.method)) {
      if (active || selecting) { json(409, { error: 'Gemini bridge is busy.' }); return; }
      const value = req.method === 'POST' ? await body(req) : null;
      if (active || selecting) { json(409, { error: 'Gemini bridge is busy.' }); return; }
      selecting = true;
      let wc, selectionResult;
      try {
        ({ wc } = await createWorker(origin + '/app'));
        selectionResult = { ...(value ? await selectModel(wc, value.model, value.effort) : await inspectSelection(wc)), background: true };
      } finally {
        try { if (wc) await command(wc, 'menu-close'); } catch {}
        try { await disposeWorker(); } finally { selecting = false; }
      }
      json(200, selectionResult);
      return;
    }
    if (req.method === 'POST' && req.url === '/run') {
      if (active || selecting) { json(409, { error: 'Gemini bridge already owns a turn or selection.' }); return; }
      const value = await body(req);
      if (active || selecting) { json(409, { error: 'Gemini bridge already owns a turn or selection.' }); return; }
      if (!/^[a-f0-9]{32}$/.test(value.requestId) || typeof value.prompt !== 'string' || !value.prompt.trim() || typeof value.model !== 'string' ||
          (value.sessionId != null && !/^gemini_[a-f0-9]{16}$/.test(value.sessionId)) || !Number.isInteger(value.timeoutSeconds) || value.timeoutSeconds < 10 || value.timeoutSeconds > 3600) throw Error('Invalid Gemini run request.');
      if (seen.has(value.requestId)) { json(409, { error: 'Request already accepted; it will not be sent again.' }); return; }
      if (!['low', 'medium', 'high'].includes(value.effort)) throw Error('Invalid Gemini thinking level.');
      assertSafePrompt(value.prompt, value.allowEmails);
      seen.add(value.requestId);
      res.writeHead(200, { 'Content-Type': 'application/x-ndjson', 'Cache-Control': 'no-store' });
      res.flushHeaders();
      active = { request: value, res, cancel: false, submitted: false, sessionId: null };
      const owned = active;
      res.on('close', () => { if (active === owned) owned.cancel = true; });
      void runPrompt(owned); return;
    }
    if (req.method === 'POST' && req.url === '/stop') {
      const value = await body(req);
      if (!active || active.request.requestId !== value.requestId) { json(409, { error: 'No matching owned turn.' }); return; }
      active.cancel = true; json(200, { stopping: true }); return;
    }
    json(404, { error: 'Unknown bridge operation.' });
  } catch (error) { json(400, { error: error.message }); }
}
app.whenReady().then(() => {
  if (!app.hasSingleInstanceLock()) return; // A secondary launcher must never replace the primary bridge manifest.
  fs.mkdirSync(HOME, { recursive: true });
  server = http.createServer((req, res) => { void handle(req, res); });
  server.requestTimeout = 15_000;
  server.on('error', () => {}); // A bridge failure must never terminate Gemini.
  server.listen(0, '127.0.0.1', () => {
    fs.writeFileSync(manifestPath, JSON.stringify({ protocol: 1, owner: 'gemini-electron', pid: process.pid, exe: process.execPath,
      version: app.getVersion(), host: '127.0.0.1', port: server.address().port, token, startedAt: Date.now() }), { mode: 0o600 });
  });
});
app.on('will-quit', () => {
  server?.close();
  try { if (JSON.parse(fs.readFileSync(manifestPath, 'utf8')).pid === process.pid) fs.unlinkSync(manifestPath); } catch {}
});
