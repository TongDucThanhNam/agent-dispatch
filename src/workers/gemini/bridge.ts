import fs from 'node:fs';
import path from 'node:path';
import { asset, home } from '../../core/paths.ts';
import { isAlive, spawnCaptured } from '../../core/fsutil.ts';
import { digest, inspectGeminiInstall, patchArchive, readArchive } from './archive.ts';
import ts from 'typescript';

export const GEMINI_BRIDGE_HOME = home('.agent-dispatch/gemini-bridge');
export const GEMINI_BRIDGE_MANIFEST = path.join(GEMINI_BRIDGE_HOME, 'runtime.json');
const marker = '\n;/* agent-dispatch:gemini-bridge:v1 */';
const quietStartup = '!process.argv.includes("--hide")/*agent-dispatch:quiet-start*/';

/** Honor Gemini's existing --hide flag before creating its primary native window. */
export function patchGeminiQuietStartup(main: string) {
  const source = ts.createSourceFile('main.js', main, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const matches: ts.Expression[] = [];
  const walk = (node: ts.Node) => {
    if (ts.isNewExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === 'BaseWindow') {
      const options = node.arguments?.[0];
      if (options && ts.isObjectLiteralExpression(options)) {
        const field = (name: string) => options.properties.find(p => ts.isPropertyAssignment(p) && p.name.getText(source) === name) as ts.PropertyAssignment | undefined;
        if (field('title')?.initializer.getText(source) === '"Gemini"' && field('show')) matches.push(field('show')!.initializer);
      }
    }
    ts.forEachChild(node, walk);
  };
  walk(source);
  if (matches.length !== 1 || !['!0', 'true'].includes(matches[0].getText(source))) throw Error('Unsupported Gemini primary window; quiet startup patch not applied.');
  const node = matches[0];
  return main.slice(0, node.getStart(source)) + quietStartup + main.slice(node.end);
}

export async function geminiProcesses() {
  if (process.platform !== 'win32') throw Error('Gemini Desktop bridge currently supports Windows only.');
  const r = await spawnCaptured(path.join(process.env.SystemRoot ?? 'C:/Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe'),
    ['-NoProfile', '-NonInteractive', '-Command', `Get-CimInstance Win32_Process -Filter "Name = 'Gemini.exe' OR Name = 'GeminiAppLauncher.exe'" | ForEach-Object { [PSCustomObject]@{pid=$_.ProcessId;exe=$_.ExecutablePath;startedAt=([DateTimeOffset]$_.CreationDate).ToUnixTimeMilliseconds()} } | ConvertTo-Json -Compress`], { timeoutMs: 15_000 });
  if (!r.ok) throw Error('Could not verify Gemini process identity.');
  const value = r.stdout.trim() ? JSON.parse(r.stdout) : [];
  return Array.isArray(value) ? value : [value];
}

/** Prepare and verify bytes before touching the installed archive. No fuse or EXE patching. */
export function prepareGeminiBridge(exe: string) {
  const install = inspectGeminiInstall(exe), main = readArchive(install.data).read('src/main.js').toString('utf8');
  const bridge = fs.readFileSync(asset('node', 'gemini-bridge.cjs'));
  const safety = fs.readFileSync(asset('node', 'gemini-safety.cjs'));
  const backupDir = path.join(GEMINI_BRIDGE_HOME, 'backups', install.version + '-' + install.hash.slice(0, 16));
  const existing = main.includes(marker);
  if (existing) {
    const embedded = readArchive(install.data).read('src/agent_dispatch_bridge.cjs');
    if (!embedded.equals(bridge) || !readArchive(install.data).read('src/gemini-safety.cjs').equals(safety)) throw Error('A different Gemini bridge is installed. Restore it before installing this revision.');
    if (!main.includes(quietStartup)) throw Error('Gemini quiet startup is missing. Restore and reinstall the bridge.');
    const root = path.join(GEMINI_BRIDGE_HOME, 'backups');
    const record = fs.existsSync(root) && fs.readdirSync(root).map(n => {
      const dir = path.join(root, n);
      try { return { dir, data: JSON.parse(fs.readFileSync(path.join(dir, 'patch.json'), 'utf8')) }; } catch { return null; }
    }).find(e => e?.data.archive === install.archivePath && e.data.patchedHash === install.hash);
    if (!record) throw Error('Installed Gemini bridge has no matching rollback record.');
    if (digest(fs.readFileSync(path.join(record.dir, 'app.asar'))) !== record.data.originalHash) throw Error('Gemini original backup failed verification.');
    return { ...install, originalHash: record.data.originalHash, patched: install.data, patchedHash: install.hash, backupDir: record.dir, unchanged: true };
  }
  if (install.version !== '1.18.0' || !main.includes('gemini:notify-turn-lifecycle') || !main.includes('gemini.google.com')) throw Error('This Gemini version has not been validated for the bridge; no patch applied.');
  const patched = patchArchive(install.data, { 'src/main.js': patchGeminiQuietStartup(main) + marker + '\ntry { require("./agent_dispatch_bridge.cjs"); } catch {}\n',
    'src/agent_dispatch_bridge.cjs': bridge, 'src/gemini-safety.cjs': safety });
  return { ...install, originalHash: install.hash, patched, patchedHash: digest(patched), backupDir, unchanged: false };
}

export async function installGeminiBridge(exe: string, dryRun = false) {
  const plan = prepareGeminiBridge(exe);
  const result = { worker: 'gemini', backend: 'desktop-bridge', version: plan.version, archive: plan.archivePath,
    originalHash: plan.originalHash, patchedHash: plan.patchedHash, backup: plan.backupDir, unchanged: plan.unchanged, dryRun };
  if (dryRun || plan.unchanged) return result;
  const running = (await geminiProcesses()).filter(p => p.exe && path.dirname(p.exe).toLowerCase() === path.dirname(plan.exe).toLowerCase());
  if (running.length) throw Error('Close Gemini before installing its bridge. Setup never kills the app or an active turn.');
  fs.mkdirSync(plan.backupDir, { recursive: true });
  const backup = path.join(plan.backupDir, 'app.asar'), metadata = path.join(plan.backupDir, 'patch.json');
  if (fs.existsSync(backup)) {
    if (digest(fs.readFileSync(backup)) !== plan.hash) throw Error('Gemini backup hash mismatch.');
  } else fs.writeFileSync(backup, plan.data, { flag: 'wx' });
  fs.writeFileSync(metadata, JSON.stringify({ ...result, exe: plan.exe, createdAt: new Date().toISOString() }, null, 2));
  const staged = plan.archivePath + '.agent-dispatch-pending';
  if (digest(fs.readFileSync(plan.archivePath)) !== plan.hash) throw Error('Gemini updated during preparation. No patch applied.');
  fs.writeFileSync(staged, plan.patched, { flag: 'wx' });
  try {
    if (digest(fs.readFileSync(staged)) !== plan.patchedHash || digest(fs.readFileSync(plan.archivePath)) !== plan.hash) throw Error('Gemini patch verification failed.');
    fs.renameSync(staged, plan.archivePath);
  } finally { if (fs.existsSync(staged)) fs.unlinkSync(staged); }
  return result;
}

export async function restoreGeminiBridge(exe: string, dryRun = false) {
  const install = inspectGeminiInstall(exe), root = path.join(GEMINI_BRIDGE_HOME, 'backups');
  const entries = fs.existsSync(root) ? fs.readdirSync(root) : [];
  const found = entries.map(n => path.join(root, n)).map(dir => {
    try { return { dir, data: JSON.parse(fs.readFileSync(path.join(dir, 'patch.json'), 'utf8')) }; } catch { return null; }
  }).find(e => e?.data.archive === install.archivePath && e.data.patchedHash === install.hash);
  if (!found) throw Error('No exact matching Gemini bridge backup. An app update or foreign change will not be overwritten.');
  const original = fs.readFileSync(path.join(found.dir, 'app.asar'));
  if (digest(original) !== found.data.originalHash) throw Error('Gemini original backup failed verification.');
  if (!dryRun) {
    if ((await geminiProcesses()).some(p => p.exe && path.dirname(p.exe).toLowerCase() === path.dirname(install.exe).toLowerCase())) throw Error('Close Gemini before restoring its archive.');
    const staged = install.archivePath + '.agent-dispatch-restore';
    fs.writeFileSync(staged, original, { flag: 'wx' });
    try {
      if (digest(fs.readFileSync(install.archivePath)) !== install.hash) throw Error('Gemini changed during restore.');
      fs.renameSync(staged, install.archivePath);
    } finally { if (fs.existsSync(staged)) fs.unlinkSync(staged); }
  }
  return { restored: !dryRun, dryRun, version: install.version, archive: install.archivePath, backup: found.dir };
}

export async function readGeminiBridge(exe: string) {
  let value: any;
  try { value = JSON.parse(fs.readFileSync(GEMINI_BRIDGE_MANIFEST, 'utf8')); } catch { throw Error('Gemini bridge is not running. Install it with gemini setup --bridge, then open Gemini.'); }
  const install = inspectGeminiInstall(exe);
  if (value.protocol !== 1 || value.owner !== 'gemini-electron' || value.host !== '127.0.0.1' || !Number.isInteger(value.port) || value.port < 1 || value.port > 65535 ||
      !/^[a-f0-9]{64}$/.test(value.token) || !Number.isInteger(value.pid) || !isAlive(value.pid) || value.exe?.toLowerCase() !== install.exe.toLowerCase() || value.version !== install.version)
    throw Error('Gemini bridge manifest is invalid or stale.');
  const owner = (await geminiProcesses()).find(p => p.pid === value.pid);
  if (!owner || owner.exe?.toLowerCase() !== install.exe.toLowerCase() || owner.startedAt > value.startedAt || value.startedAt - owner.startedAt > 180_000)
    throw Error('Gemini bridge does not belong to the installed app process.');
  return { origin: `http://127.0.0.1:${value.port}`, token: value.token, pid: value.pid, version: value.version };
}

export function geminiBridgeClient(bridge: any) {
  return async (route: '/status' | '/run' | '/stop' | '/selection', body?: any, signal?: AbortSignal) => {
    const response = await fetch(bridge.origin + route, { method: body === undefined ? 'GET' : 'POST', redirect: 'error',
      headers: { 'x-agent-dispatch-token': bridge.token, 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: signal ?? AbortSignal.timeout(15_000) });
    if (!response.ok) {
      let value: any; try { value = await response.json(); } catch {}
      throw Error(`Gemini bridge HTTP ${response.status}: ${typeof value?.error === 'string' ? value.error : 'request failed'}`);
    }
    return response;
  };
}
