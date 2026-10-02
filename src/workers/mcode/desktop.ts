import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { home } from '../../core/paths.ts';
import { readJson, isAlive, spawnCaptured, sleep } from '../../core/fsutil.ts';

export const MCODE_API = '/minimax-desktop/api/v1';
export const isMcodeSession = (id: unknown) => typeof id === 'string' && /^mvs_[a-f0-9]{32}$/.test(id);
export const mcodePaths = (raw: any = {}) => ({
  mcodeExe: path.resolve(raw.mcodeExe ?? process.env.MCODE_DESKTOP_EXE ?? home('AppData/Local/Programs/MiniMax Code/MiniMax Code.exe')),
  mcodeManifest: path.resolve(raw.mcodeManifest ?? process.env.MCODE_DESKTOP_MANIFEST ?? home('.minimax/run/agent-dispatch-desktop.json')),
});

// Inspect the installed archive without importing app code or copying authentication.
export function desktopVersion(exe: string) {
  const fd = fs.openSync(path.join(path.dirname(exe), 'resources/app.asar'), 'r');
  try {
    const prefix = Buffer.alloc(16); fs.readSync(fd, prefix, 0, 16, 0);
    const length = prefix.readUInt32LE(12);
    if (length > 32_000_000) throw Error('Invalid MiniMax desktop archive header.');
    const header = Buffer.alloc(length); fs.readSync(fd, header, 0, length, 16);
    const entry = JSON.parse(header.toString()).files['package.json'];
    if (!entry || entry.size > 100_000) throw Error('Invalid MiniMax desktop package.');
    const data = Buffer.alloc(entry.size);
    fs.readSync(fd, data, 0, data.length, 8 + prefix.readUInt32LE(4) + Number(entry.offset));
    const pkg = JSON.parse(data.toString());
    if (pkg.name !== '@mmx-agent/electron') throw Error('The selected executable is not MiniMax Desktop.');
    return pkg.version as string;
  } finally { fs.closeSync(fd); }
}

async function windowsProcesses() {
  if (process.platform !== 'win32') throw Error('MiniMax Desktop bridge currently supports Windows only.');
  const result = await spawnCaptured(path.join(process.env.SystemRoot ?? 'C:/Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe'),
    ['-NoProfile', '-NonInteractive', '-Command', `Get-CimInstance Win32_Process -Filter "Name = 'MiniMax Code.exe'" | ForEach-Object { [PSCustomObject]@{pid=$_.ProcessId;exe=$_.ExecutablePath;startedAt=([DateTimeOffset]$_.CreationDate).ToUnixTimeMilliseconds()} } | ConvertTo-Json -Compress`], { timeoutMs: 15_000 });
  if (!result.ok) throw Error('Could not verify MiniMax Desktop process identity.');
  const value = result.stdout.trim() ? JSON.parse(result.stdout) : [];
  return Array.isArray(value) ? value : [value];
}

export async function readMcodeBridge(config: any, { processes = windowsProcesses }: any = {}) {
  const version = desktopVersion(config.mcodeExe);
  let manifest: any;
  try { manifest = readJson(config.mcodeManifest); } catch { throw Error('Desktop bridge is unavailable. Run agent-dispatch mcode setup; close the app normally first if it is already open without the bridge.'); }
  if (manifest.host !== '127.0.0.1' || manifest.owner !== 'electron' || manifest.mode !== 'diagnostic' ||
      !Number.isInteger(manifest.port) || manifest.port < 1 || manifest.port > 65535 ||
      !Number.isInteger(manifest.pid) || !isAlive(manifest.pid) ||
      typeof manifest.startupToken !== 'string' || !manifest.startupToken || !Number.isFinite(manifest.startedAtMs))
    throw Error('The MiniMax desktop bridge manifest is invalid or stale. Run agent-dispatch mcode setup.');
  const owner = (await processes()).find(p => p.pid === manifest.pid);
  if (!owner || path.resolve(owner.exe).toLowerCase() !== path.resolve(config.mcodeExe).toLowerCase() ||
      owner.startedAt > manifest.startedAtMs || manifest.startedAtMs - owner.startedAt > 180_000)
    throw Error('The bridge does not belong to the installed MiniMax desktop process.');
  return { version, pid: manifest.pid, origin: `http://127.0.0.1:${manifest.port}`, token: manifest.startupToken };
}

export function mcodeClient(bridge: any, fetchFn: typeof fetch = fetch) {
  const request = async (route: string, { body, signal, stream = false }: any = {}) => {
    if (!route.startsWith(MCODE_API + '/')) throw Error('Invalid MiniMax desktop route.');
    const response = await fetchFn(bridge.origin + route, { method: body === undefined ? 'GET' : 'POST',
      redirect: 'error', headers: { 'x-mavis-runtime-token': bridge.token, 'Content-Type': 'application/json' },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}), signal: signal ?? AbortSignal.timeout(15_000) });
    if (!response.ok) {
      // Never put headers, the bridge token, or arbitrary response bodies into saved errors.
      let value: any; try { value = await response.json(); } catch {}
      throw Error(`MiniMax Desktop HTTP ${response.status}${typeof value?.key === 'string' ? ` (${value.key})` : ''}.`);
    }
    if (stream) {
      if (!response.headers.get('content-type')?.includes('text/event-stream') || !response.body) throw Error('MiniMax Desktop did not return an event stream.');
      return response;
    }
    return response.json();
  };
  return { request };
}

export async function probeMcode(config: any, deps: any = {}) {
  const bridge = await readMcodeBridge(config, deps), client = mcodeClient(bridge, deps.fetchFn);
  const [roster, agents, source] = await Promise.all([
    client.request(MCODE_API + '/models/list'), client.request(MCODE_API + '/agent'),
    client.request(MCODE_API + '/model-providers/minimax-source'),
  ]);
  if (!Array.isArray(roster.models) || !Array.isArray(agents.agents)) throw Error('Unsupported MiniMax Desktop response contract.');
  return { bridge, client, models: roster.models, agents: agents.agents, source: source.active_source };
}

export function resolveMcodeSelection(config: any, runtime: any) {
  const requested = config.mcodeModel;
  const model = runtime.models.find(m => m.enabled !== false && (requested
    ? `${m.provider_id}/${m.model_id}` === requested : m.selected === true));
  if (!model) throw Error('Requested MiniMax desktop model is unavailable; list it with agent-dispatch models --worker mcode.');
  // This worker intentionally stays on the desktop's managed product path.
  if (model.provider_kind !== 'minimax-managed' || model.provider_id !== 'minimax' || runtime.source !== 'token_plan')
    throw Error('mcode requires the desktop managed Token Plan route. Select it in MiniMax Desktop; no API-key or CLI fallback is used.');
  if (!runtime.agents.some(a => a.name === config.mcodeAgent)) throw Error('The requested MiniMax desktop agent is unavailable.');
  const variant = config.mcodeVariant ?? model.variant;
  if (config.mcodeVariant != null && !model.supported_variants?.includes(variant) && variant !== model.variant) throw Error('MiniMax desktop model variant is unavailable.');
  const effort = config.mcodeEffort ?? model.thinking?.effort ?? null;
  if (effort && !model.effort_options?.includes(effort)) throw Error('MiniMax desktop model does not support the selected effort.');
  if (effort && !variant) throw Error('Reasoning effort cannot be applied to a thinking-off MiniMax variant.');
  config.expectedProvider = model.provider_id; config.expectedModel = model.model_id;
  config.mcodeModel = `${model.provider_id}/${model.model_id}`; config.mcodeVariant = variant ?? null; config.mcodeEffort = effort;
  return model;
}

export function verifyMcodeSession(config: any, session: any, id?: string) {
  if (!isMcodeSession(session?.session_id) || (id && session.session_id !== id) || session.agent_name !== config.mcodeAgent ||
      session.archived || session.parent_session_id || !session.workspace_dir ||
      fs.realpathSync(session.workspace_dir).toLowerCase() !== fs.realpathSync(config.project).toLowerCase())
    throw Error('MiniMax desktop session does not belong to this worker and project.');
  if (session.model?.provider_id !== config.expectedProvider || session.model?.model_id !== config.expectedModel ||
      (session.model?.variant ?? null) !== config.mcodeVariant ||
      (config.mcodeEffort && session.model?.thinking?.effort !== config.mcodeEffort))
    throw Error('MiniMax desktop session model, variant or effort differs from the pinned selection.');
  if (session.interaction_mode !== 0) throw Error('This desktop worker requires a normal coding session, not an interactive plan/goal session.');
}

export async function setupMcode(raw: any = {}) {
  const config = mcodePaths(raw);
  const version = desktopVersion(config.mcodeExe);
  try { const runtime = await probeMcode(config); return { worker: 'mcode', backend: 'desktop', version, pid: runtime.bridge.pid, connected: true, modelSource: runtime.source, manifest: config.mcodeManifest }; } catch {}
  if ((await windowsProcesses()).length) throw Error('MiniMax Desktop is already running without a usable bridge. Close it normally, then run agent-dispatch mcode setup. It will not be forcibly restarted.');
  fs.mkdirSync(path.dirname(config.mcodeManifest), { recursive: true });
  // Remove only an expired bridge manifest, never leases, sessions or auth files.
  if (fs.existsSync(config.mcodeManifest)) fs.unlinkSync(config.mcodeManifest);
  const env: NodeJS.ProcessEnv = { ...process.env, MAVIS_ELECTRON_ENABLE_DIAGNOSTIC_SIDECAR: '1', MAVIS_ELECTRON_DIAGNOSTIC_MANIFEST: config.mcodeManifest };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(config.mcodeExe, [], { env, shell: false, windowsHide: true, detached: true, stdio: 'ignore' });
  let error: any; child.once('error', e => { error = e; }); child.unref();
  for (let i = 0; i < 90; i++) {
    if (error) throw Error('MiniMax Desktop could not be started.');
    if (fs.existsSync(config.mcodeManifest)) {
      try { const runtime = await probeMcode(config); return { worker: 'mcode', backend: 'desktop', version, pid: runtime.bridge.pid, connected: true, modelSource: runtime.source, manifest: config.mcodeManifest }; } catch {}
    }
    await sleep(500);
  }
  throw Error('MiniMax Desktop bridge startup is unconfirmed. Inspect the app; do not launch a second owner.');
}
