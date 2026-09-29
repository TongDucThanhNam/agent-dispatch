#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { asset, CLI_ENTRY } from '../core/paths.ts';
import { shortRef } from '../core/config.ts';
import { openTelemetry, clean } from './monitor-core.ts';
import { writeFileAtomic } from '../core/fsutil.ts';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { readEventContent, readEventPreviews, readToolCallId } from './event-content.ts';
import { readToolImage } from './event-images.ts';
import { loadRunForExport, sessionExportEntries, sessionLogZipFilename, zipStream } from './session-export.ts';

// The page is the Vite build of web/ (`bun run build:web`): index.html plus content-hashed files under assets/.
const DIST = asset('web', 'dashboard');
export const dashboardBuilt = (dir = DIST) => fs.existsSync(path.join(dir, 'index.html'));
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.woff2': 'font/woff2',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };
const MISSING_PAGE = '<!doctype html><meta charset="utf-8"><title>Agent Dispatch</title><body style="font:14px system-ui;margin:3rem;color:#ccc;background:#15161a">'
  + '<h1 style="font-size:18px">The dashboard has not been built</h1><p>Run <code>bun run build:web</code> in the agent-dispatch folder, then reload. Run data is still served.</p>';
/** Only index.html and flat files under assets/ with a known type; anything else is not part of the page. */
const pageFile = (dir, route) => route === '' ? path.join(dir, 'index.html')
  : /^assets\/[\w-]+(\.[\w-]+)*$/.test(route) && Object.hasOwn(TYPES, path.extname(route)) ? path.join(dir, route) : null;
const pageCache = new Map<string, Buffer | null>();
const readPage = (file, dev) => {
  if (!dev && pageCache.has(file)) return pageCache.get(file);
  let data: Buffer | null = null;
  try { data = fs.readFileSync(file); } catch { /* not built */ }
  if (!dev && data) pageCache.set(file, data);
  return data;
};
export const defaultRoot = () => path.resolve(process.env.ZCODE_DASHBOARD_ROOT ?? path.join(os.homedir(), '.zcode', 'monitor'));
const read = file => JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
const save = (file, data) => writeFileAtomic(file, JSON.stringify(data, null, 2) + '\n');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const readReport = file => { try { return fs.statSync(file).size <= 65_536 ? clean(fs.readFileSync(file, 'utf8'), 65_536) : null; } catch { return null; } };
export const isAlive = pid => { if (!Number.isInteger(pid) || pid < 1) return false; try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
const terminal = new Set(['blocked', 'cancelled', 'worker_failed', 'missing_report', 'ready_for_review', 'complete', 'changes_required']);
const keyFor = dir => crypto.createHash('sha256').update(process.platform === 'win32' ? dir.toLowerCase() : dir).digest('hex').slice(0, 24);
const labelOf = config => ({ agy: 'AGY', codex: 'Codex' })[config.workerKind] ?? 'ZCode';
const keyOf = dir => { try { return keyFor(fs.realpathSync(dir)); } catch { return keyFor(path.resolve(dir)); } };
// The brief's first heading names the task ("# Run 4: Simple mode …"). The saved assignment never changes once written.
const tasks = new Map<string, string | null>();
const taskOf = runDir => {
  if (tasks.has(runDir)) return tasks.get(runDir);
  let text;
  try { const fd = fs.openSync(path.join(runDir, 'assignment.md'), 'r'); try { const buffer = Buffer.alloc(4096); text = buffer.toString('utf8', 0, fs.readSync(fd, buffer, 0, 4096, 0)); } finally { fs.closeSync(fd); } }
  catch { return null; }
  const task = clean(/^#{1,3}[ 	]+(.+?)[ 	#]*$/m.exec(text)?.[1]?.replace(/[*_`]/g, ''), 160) || null;
  tasks.set(runDir, task);
  return task;
};
// What an active run is doing right now: its latest recorded event.
const activityOf = events => { const last = events?.at(-1); return last ? { kind: last.kind, label: last.label, status: last.status, startedAt: last.startedAt, endedAt: last.endedAt ?? null } : null; };

export function registerRun(runDir, root = defaultRoot()) {
  const resolved = fs.realpathSync(runDir), config = read(path.join(resolved, 'config.json'));
  if (fs.realpathSync(config.runDir) !== resolved || !config.project || !config.runId) throw new Error('Invalid managed run configuration.');
  const relative = path.relative(fs.realpathSync(config.project), resolved);
  if (!relative || relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) throw new Error('Run is outside its project.');
  const key = keyFor(resolved), registry = path.join(root, 'runs');
  fs.mkdirSync(registry, { recursive: true });
  save(path.join(registry, key + '.json'), { key, runDir: resolved, registeredAt: Date.now() });
  return key;
}

export function readRun(entry, { now = Date.now(), alive = isAlive, telemetry = true, observeInactive = false } = {}) {
  const config = read(path.join(entry.runDir, 'config.json')), state = read(path.join(entry.runDir, 'status.json'));
  if (state.runId !== config.runId || path.resolve(config.runDir) !== path.resolve(entry.runDir)) throw new Error('Run record identity differs.');
  const runnerAlive = alive(state.runnerPid), workerAlive = alive(state.workerPid);
  const active = !state.workerExited && !terminal.has(state.status) && (workerAlive || runnerAlive);
  const stale = active && (!runnerAlive || now - state.updatedAt > Math.max(60_000, (config.pollMs ?? 5000) * 3));
  let observed: any = null;
  // Finished ZCode runs are observed once on demand (see catalog.hydrate); the shared database can be large.
  // AGY and Codex runs have small per-run projections.
  if ((active || ['agy', 'codex'].includes(config.workerKind) || observeInactive) && telemetry) {
    let reader;
    try { reader = openTelemetry(config.dbPath); observed = reader.read({ project: config.project, sessionId: state.sessionId,
      runId: state.runId, startedAt: state.startedAt, includeTrajectory: true }); }
    catch { observed = { available: false, reason: 'Local events are temporarily unavailable.' }; }
    finally { reader?.close(); }
  }
  const names = config.project.replaceAll('\\', '/').split('/').filter(Boolean);
  let review: any = null; try { review = read(path.join(entry.runDir, 'review.json')); } catch {}
  const status = stale ? 'unconfirmed' : review ? review.verdict === 'accepted' ? 'complete' : 'changes_required'
    : !active && !state.workerExited ? 'monitor_offline' : state.status;
  const events = observed?.trajectory?.events ?? (state.tools ?? []).map(tool => ({ id: `part:${tool.id}`, kind: 'tool', label: clean(tool.name),
    status: tool.status, startedAt: tool.startedAt, endedAt: tool.endedAt, source: 'saved monitor', recordId: tool.id })).reverse();
  return { key: entry.key, runId: state.runId, ref: shortRef(state.runId), title: names.slice(-2).join(' / '), task: taskOf(entry.runDir), project: config.project,
    discoveryKey: config.discoveryRunDir ? keyOf(config.discoveryRunDir) : null,
    workerKind:config.workerKind ?? 'zcode',workerLabel:labelOf(config),stage:config.stage ?? null,
    active, status, phase: stale ? 'monitor_offline' : state.phase, startedAt: state.startedAt, endedAt: state.endedAt,
    updatedAt: state.updatedAt, model: observed?.model ?? state.model ?? config.expectedModel,
    lastActivityAt: observed?.lastActivityAt ?? state.lastActivityAt,
    usage: observed?.usage ?? state.usage, todos: observed?.todos ?? state.todos ?? [],
    trajectory: observed?.trajectory ?? { events, turns: null, toolCalls: null, truncated: true },
    telemetryAvailable: observed?.available ?? state.telemetryAvailable,
    telemetryReason: observed?.reason ?? state.telemetryReason,
    report: state.workerExited ? readReport(path.join(entry.runDir, review ? 'review.md' : 'worker-report.md')) : null,
    alert: stale ? 'The run monitor is offline; worker state needs checking.' : clean(state.alert?.message ?? state.error?.message, 600),
    notifications: Object.values<any>(state.notifications ?? {}).map(x => ({ kind: x.kind, state: x.state })),
    canStop: active && !stale && Boolean(state.url), canRetryNotification: runnerAlive && Object.values<any>(state.notifications ?? {}).some(x => ['failed', 'unconfirmed'].includes(x.state)),
    // Control URL stays server-side. The browser never supplies a PID or filesystem path.
    controlUrl: state.url ?? null, sessionId: observed?.sessionId ?? state.sessionId ?? null,
    contentSource: { dbPath: config.dbPath, project: config.project, startedAt: state.startedAt, runDir: entry.runDir, workerLabel: labelOf(config) } };
}

export function createCatalog(root, options: any = {}) {
  let records: Map<any, any> = new Map<any, any>();
  return {
    refresh() {
      const next = new Map<any, any>();
      let files: any[] = []; try { files = fs.readdirSync(path.join(root, 'runs')).filter(x => /^[a-f0-9]{24}\.json$/.test(x)); } catch {}
      for (const file of files) {
        try {
          const entry = read(path.join(root, 'runs', file));
          if (entry.key !== file.slice(0, -5) || keyFor(entry.runDir) !== entry.key) continue;
          const run = readRun(entry, options);
          const previous = records.get(run.key);
          if (!run.active && previous?.hydrated) Object.assign(run, { trajectory: previous.trajectory, usage: previous.usage, model: previous.model, hydrated: true });
          else if (!run.active && previous?.trajectory?.events?.length) run.trajectory = previous.trajectory;
          next.set(run.key, run);
        } catch { /* An atomic record write can race a read. Retain no false running entry. */ }
      }
      records = next;
    },
    get: key => records.get(key),
    // Read a finished run's full trajectory once, when someone opens it.
    hydrate(key) {
      const run = records.get(key);
      if (!run || run.active || run.hydrated || options.telemetry === false) return run;
      try { const fresh: any = readRun({ key, runDir: run.contentSource.runDir }, { ...options, observeInactive: true }); fresh.hydrated = true; records.set(key, fresh); return fresh; }
      catch { run.hydrated = true; return run; }
    },
    snapshot(selectedKey) {
      const all = [...records.values()], active = all.filter(x => x.active).sort((a, b) => b.startedAt - a.startedAt);
      const selected = records.get(selectedKey) ? this.hydrate(selectedKey) : active[0] ?? null;
      const item = run => run && ({ key: run.key, ref: run.ref, title: run.title, task: run.task, project: run.project, runId: run.runId, model: run.model, status: run.status,
        phase: run.phase, active: run.active, startedAt: run.startedAt, endedAt: run.endedAt, lastActivityAt: run.lastActivityAt, workerLabel: run.workerLabel,
        stage: run.stage, discoveryKey: run.discoveryKey, alert: Boolean(run.alert), activity: run.active ? activityOf(run.trajectory?.events) : null });
      const recent = all.filter(x => !x.active).sort((a, b) => (b.endedAt ?? b.updatedAt ?? 0) - (a.endedAt ?? a.updatedAt ?? 0)).slice(0, 30).map(item);
      // The two-stage flow: the discovery run an execution came from, and the executions a discovery led to.
      const lineage = selected && { discovery: item(records.get(selected.discoveryKey)) ?? null,
        executions: all.filter(x => x.discoveryKey === selected.key).sort((a, b) => a.startedAt - b.startedAt).map(item) };
      return { at: Date.now(), runs: active.map(item), recent, selected: selected && { ...publicRun(selected), lineage } };
    }
  };
}

export const publicRun = value => { if (!value) return null; const { controlUrl, contentSource, hydrated, ...rest } = value; return rest; };

export async function proxyAction(run, action) {
  if (!run || !['stop', 'retry-notification'].includes(action)) throw new Error('Unknown action.');
  if (action === 'stop' && !run.canStop || action === 'retry-notification' && !run.canRetryNotification) throw new Error('The original run monitor is unavailable for this action.');
  const url = new URL(run.controlUrl);
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !/^\/[a-f0-9]{48}\/$/.test(url.pathname) || url.username || url.password || url.search || url.hash) throw new Error('Invalid run monitor address.');
  const check = await fetch(new URL('status', url), { signal: AbortSignal.timeout(3000), redirect: 'error' });
  if (!check.ok || (await check.json()).runId !== run.runId) throw new Error('Run monitor identity does not match.');
  const response = await fetch(new URL(action, url), { method: 'POST', signal: AbortSignal.timeout(20_000), redirect: 'error' });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error ?? 'Action failed.');
  return { message: clean(result.message, 500) };
}

/** `dev` re-reads the built page on every request, so a rebuild shows on reload. */
export async function serveDashboard({ root = defaultRoot(), port = 0, token = crypto.randomBytes(24).toString('hex'), pollMs = 2000, catalog = createCatalog(root), action = proxyAction, dev = false, pageDir = DIST } = {}) {
  if (!/^[a-f0-9]{48}$/.test(token)) throw new Error('Invalid dashboard token.');
  const clients = new Set<any>(), downloads = new Set<any>();
  catalog.refresh();
  let actualPort;
  const server = http.createServer(async (req, res) => {
    const host = `127.0.0.1:${actualPort}`, origin = `http://${host}`, base = `/${token}/`;
    res.setHeader('Cache-Control', 'no-store'); res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer'); res.setHeader('X-Frame-Options', 'SAMEORIGIN');
    res.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'self'");
    const send = (code, data) => { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(data)); };
    if (req.headers.host !== host || req.headers.origin && req.headers.origin !== origin) return send(403, { error: 'Invalid origin.' });
    const url = new URL(req.url!, origin);
    if (!url.pathname.startsWith(base)) return send(404, { error: 'Unknown dashboard.' });
    const route = url.pathname.slice(base.length);
    const file = req.method === 'GET' || req.method === 'HEAD' ? pageFile(pageDir, route) : null;
    if (file) {
      const data = readPage(file, dev);
      if (!data && route === '') { res.writeHead(503, { 'Content-Type': TYPES['.html'] }); return res.end(MISSING_PAGE); }
      if (!data) return send(404, { error: 'Unknown dashboard file.' });
      // Built assets are content-hashed, so the browser may keep them.
      if (route !== '' && !dev) res.setHeader('Cache-Control', 'private, max-age=31536000, immutable');
      res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)], 'Content-Length': data.length });
      return res.end(req.method === 'HEAD' ? undefined : data);
    }
    if (req.method === 'GET' && route === 'health') return send(200, { service: 'zcode-dashboard', version: 4, pid: process.pid });
    if (req.method === 'GET' && route === 'snapshot') return send(200, catalog.snapshot(url.searchParams.get('run')));
    if (req.method === 'GET' && /^runs\/[a-f0-9]{24}\/content$/.test(route)) {
      const run = catalog.get(route.split('/')[1]);
      if (!run) return send(404, { error: 'Unknown run.' });
      try {
        const content = readEventContent(run.contentSource.dbPath, { ...run.contentSource, sessionId: run.sessionId,
          eventId: url.searchParams.get('event'), field: url.searchParams.get('field'),
          offset: Number(url.searchParams.get('offset') ?? 0), limit: Number(url.searchParams.get('limit') ?? 32768) });
        return send(200, content);
      } catch (error) { return send(400, { error: clean(error.message, 200) }); }
    }
    if (req.method === 'GET' && /^runs\/[a-f0-9]{24}\/previews$/.test(route)) {
      const run = catalog.get(route.split('/')[1]);
      if (!run) return send(404, { error: 'Unknown run.' });
      try {
        const ids = (url.searchParams.get('ids') ?? '').split(',').filter(Boolean);
        return send(200, readEventPreviews(run.contentSource.dbPath, { ...run.contentSource, sessionId: run.sessionId, ids }));
      } catch (error) { return send(400, { error: clean(error.message, 200) }); }
    }
    // An image a tool returned to the model, as the model saw it. Only Codex runs keep these bytes (in their rollout copy).
    if ((req.method === 'GET' || req.method === 'HEAD') && /^runs\/[a-f0-9]{24}\/image$/.test(route)) {
      const run = catalog.get(route.split('/')[1]);
      if (!run) return send(404, { error: 'Unknown run.' });
      let image;
      try {
        const callId = readToolCallId(run.contentSource.dbPath, { ...run.contentSource, sessionId: run.sessionId, eventId: url.searchParams.get('event') });
        image = callId && run.workerLabel === 'Codex' ? readToolImage(run.contentSource.runDir, callId, Number(url.searchParams.get('index') ?? 0)) : null;
      } catch (error) { return send(400, { error: clean(error.message, 200) }); }
      if (!image) return send(404, { error: 'This run did not keep the image.' });
      // A recorded tool result never changes, so the browser may keep it for the session.
      res.writeHead(200, { 'Content-Type': image.type, 'Content-Length': image.data.length, 'Cache-Control': 'private, max-age=3600' });
      return res.end(req.method === 'HEAD' ? undefined : image.data);
    }
    // Session-log download (DSH-style): HEAD is the preflight, GET streams the ZIP straight to the browser.
    if ((req.method === 'GET' || req.method === 'HEAD') && /^runs\/[a-f0-9]{24}\/export$/.test(route)) {
      const key = route.split('/')[1], run = catalog.hydrate(key);
      if (!run) return send(404, { error: 'Unknown run.' });
      let prepared;
      try { prepared = sessionExportEntries({ ...loadRunForExport(run.contentSource.runDir), trajectory: publicRun(run) }); }
      catch (error) { return send(409, { error: clean(error.message, 300) }); }
      res.writeHead(200, { 'Content-Type': 'application/zip', 'Content-Disposition': `attachment; filename="${sessionLogZipFilename(run.runId)}"` });
      if (req.method === 'HEAD') { prepared.close(); return res.end(); }
      downloads.add(prepared);
      pipeline(Readable.from(zipStream(prepared.entries)), res).catch(() => res.destroy()).finally(() => { prepared.close(); downloads.delete(prepared); });
      return;
    }
    if (req.method === 'GET' && route === 'events') {
      if (clients.size >= 30) return send(429, { error: 'Too many local dashboard connections.' });
      res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', Connection: 'keep-alive' });
      const client = { res, key: url.searchParams.get('run') };
      clients.add(client); res.write(`data: ${JSON.stringify(catalog.snapshot(client.key))}\n\n`);
      req.on('close', () => clients.delete(client)); return;
    }
    if (req.method === 'POST' && /^runs\/[a-f0-9]{24}\/(stop|retry-notification)$/.test(route)) {
      req.resume(); const [, key, name] = route.split('/');
      try { catalog.refresh(); return send(200, await action(catalog.get(key), name)); }
      catch (error) { return send(409, { error: clean(error.message, 500) }); }
    }
    return send(405, { error: 'Method not allowed.' });
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', () => resolve(undefined)); });
  actualPort = (server.address() as any).port;
  const timer = setInterval(() => {
    try { catalog.refresh(); } catch {}
    for (const client of clients) {
      if (client.res.writableLength > 2_000_000) { client.res.destroy(); clients.delete(client); continue; }
      client.res.write(`data: ${JSON.stringify(catalog.snapshot(client.key))}\n\n`);
    }
  }, pollMs);
  return { url: `http://127.0.0.1:${actualPort}/${token}/`, port: actualPort, token,
    close: async () => { clearInterval(timer); for (const client of clients) client.res.end(); for (const item of downloads) item.close(); server.closeAllConnections?.(); await new Promise(resolve => server.close(resolve)); } };
}

export async function healthy(record) {
  if (!record?.url || !isAlive(record.pid)) return false;
  try {
    const url = new URL(record.url);
    if (url.hostname !== '127.0.0.1' || url.protocol !== 'http:' || url.port !== String(record.port) || url.pathname !== `/${record.token}/` || !/^[a-f0-9]{48}$/.test(record.token)) return false;
    const response = await fetch(new URL('health', url), { signal: AbortSignal.timeout(1000), redirect: 'error' });
    const body = await response.json(); return response.ok && body.service === 'zcode-dashboard' && body.pid === record.pid;
  } catch { return false; }
}

export async function ensureDashboard(root = defaultRoot()) {
  fs.mkdirSync(root, { recursive: true });
  const recordPath = path.join(root, 'hub.json'), lockPath = path.join(root, 'startup.lock');
  let record; try { record = read(recordPath); } catch {}
  if (await healthy(record)) return record;
  let acquired = false;
  for (let i = 0; i < 60; i++) {
    try { fs.writeFileSync(lockPath, JSON.stringify({ pid: process.pid, at: Date.now() }), { flag: 'wx' }); acquired = true; break; }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      try { const owner = read(lockPath); if (!isAlive(owner.pid) && Date.now() - owner.at > 5000) fs.unlinkSync(lockPath); } catch {}
      await sleep(200); try { record = read(recordPath); } catch {}
      if (await healthy(record)) return record;
    }
  }
  if (!acquired) throw new Error('Dashboard startup is already in progress. Try opening it again shortly.');
  try {
    try { record = read(recordPath); } catch {}
    if (await healthy(record)) return record;
    if (record && isAlive(record.pid)) throw new Error('The dashboard process is alive but not responding. Its state needs checking before replacement.');
    const out = fs.openSync(path.join(root, 'hub.log'), 'a'), err = fs.openSync(path.join(root, 'hub-stderr.log'), 'a');
    const child = spawn(process.execPath, [CLI_ENTRY, 'hub', 'serve', '--root', root], { detached: true, windowsHide: true, shell: false, stdio: ['ignore', out, err] });
    let spawnError; child.once('error', error => { spawnError = error; }); child.unref(); fs.closeSync(out); fs.closeSync(err);
    for (let i = 0; i < 60; i++) {
      if (spawnError) throw spawnError;
      await sleep(100); try { record = read(recordPath); } catch {}
      if (await healthy(record)) return record;
      if (child.exitCode != null) throw new Error('The dashboard did not start. Inspect its local startup log.');
    }
    throw new Error('Dashboard startup is unconfirmed. Worker state is unchanged.');
  } finally { if (acquired) { try { if (read(lockPath).pid === process.pid) fs.unlinkSync(lockPath); } catch {} } }
}

/** Runs the shared hub in this process (the detached `hub serve` child); reuses the previous port and token. */
export async function serveHub(root = defaultRoot()) {
  let previous; try { previous = read(path.join(root, 'hub.json')); } catch {}
  const panel = await serveDashboard({ root, port: previous?.port ?? 0, token: previous?.token });
  save(path.join(root, 'hub.json'), { pid: process.pid, startedAt: Date.now(), url: panel.url, port: panel.port, token: panel.token });
  return panel;
}
