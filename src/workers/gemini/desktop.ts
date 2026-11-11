import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { asset, home } from '../../core/paths.ts';
import { spawnCaptured } from '../../core/fsutil.ts';
import { spawn } from 'node:child_process';
import { geminiBridgeClient, installGeminiBridge, readGeminiBridge, prepareGeminiBridge, geminiProcesses, GEMINI_BRIDGE_MANIFEST } from './bridge.ts';

export const GEMINI_SCRIPT = asset('python', 'gemini_uia.py');
export const GEMINI_DEFAULT_MODEL = '4 Argon';
export const GEMINI_DEFAULT_EFFORT = 'high';
export const geminiModelLabel = (label: string) => /^(?:gemini[ -]*)?(?:4[ -]*)?argon$/i.test(label.trim()) ? '4 Argon' : label.trim();
export const isGeminiSession = (id: unknown) => typeof id === 'string' && /^gemini_[a-f0-9]{16}$/.test(id);
export const geminiModelId = (label: string) => label.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-|-$/g, '');
export const geminiPaths = (raw: any = {}) => ({
  geminiBackend: raw.geminiBackend ?? 'bridge',
  geminiExe: path.resolve(raw.geminiExe ?? process.env.GEMINI_DESKTOP_EXE ?? home('AppData/Local/Google/Gemini/Gemini.exe')),
  geminiPython: path.resolve(raw.geminiPython ?? process.env.GEMINI_DESKTOP_PYTHON ?? home('.agent-dispatch/gemini-runtime/Scripts/python.exe')),
});

export async function selectGemini(raw: any = {}) {
  const config = geminiPaths(raw);
  if (config.geminiBackend !== 'bridge') throw Error('Automatic model/thinking selection requires the Gemini bridge.');
  const model = geminiModelLabel(raw.geminiModel ?? raw.model ?? GEMINI_DEFAULT_MODEL);
  const effort = raw.geminiEffort ?? raw.effort ?? GEMINI_DEFAULT_EFFORT;
  if (!['low', 'medium', 'high'].includes(effort)) throw Error('Invalid Gemini thinking level.');
  const client = geminiBridgeClient(await readGeminiBridge(config.geminiExe));
  const state = await (await client('/status')).json();
  if (!state.capabilities?.includes('non-activating-window')) throw Error('Update the Gemini bridge before using background selection.');
  return (await client('/selection', { model, effort }, AbortSignal.timeout(45_000))).json();
}

/** Reuse a running bridge. Never launch a second instance just to activate its UI. */
export async function startGeminiBackground(raw: any = {}, deps: any = {}) {
  const config = geminiPaths(raw);
  if (config.geminiBackend !== 'bridge') throw Error('Quiet startup requires the Gemini bridge.');
  const probe = deps.probe ?? probeGemini;
  const ready = state => state.ready && state.capabilities?.includes('non-activating-window');
  try { const state = await probe(config); if (ready(state)) return { ...state, started: false }; } catch {}
  const plan = (deps.prepare ?? prepareGeminiBridge)(config.geminiExe);
  if (!plan.unchanged) throw Error('Install the Gemini bridge before using quiet startup.');
  if ((await (deps.processes ?? geminiProcesses)()).some(p => p.exe && path.resolve(p.exe).toLowerCase() === path.resolve(plan.exe).toLowerCase()))
    throw Error('Gemini is already running without a ready bridge. It will not be relaunched or focused.');
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const child = (deps.spawn ?? spawn)(plan.exe, ['--hide'], { env, shell: false, windowsHide: true, detached: true, stdio: 'ignore' });
  let failure: any; child.once('error', e => { failure = e; }); child.unref();
  for (let i = 0; i < 60; i++) {
    if (failure) throw Error('Could not start Gemini in the background.');
    try {
      const manifest = (deps.readManifest ?? (() => JSON.parse(fs.readFileSync(GEMINI_BRIDGE_MANIFEST, 'utf8'))))();
      if (manifest.pid === child.pid) { const state = await probe(config); if (ready(state)) return { ...state, started: true }; }
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  throw Error('Gemini background startup is unconfirmed. It was not brought to the foreground.');
}

export function geminiRequest(config: any, prompt?: string) {
  return { action: prompt === undefined ? 'status' : 'run', executable: config.geminiExe,
    ...(prompt === undefined ? {} : { prompt, sessionId: config.resumeSessionId ?? null, model: config.geminiModel,
      timeoutSeconds: config.geminiTimeoutSeconds ?? 300, stopFile: path.join(config.runDir, 'gemini-stop') }) };
}

export async function probeGemini(raw: any = {}) {
  if (process.platform !== 'win32') throw Error('Gemini Desktop automation currently supports Windows only.');
  const config = { ...raw, ...geminiPaths(raw) };
  if (!fs.existsSync(config.geminiExe)) throw Error('Gemini Desktop executable is missing.');
  if (config.geminiBackend === 'bridge') {
    const bridge = await readGeminiBridge(config.geminiExe);
    const status: any = await (await geminiBridgeClient(bridge)('/status')).json();
    if (status.event !== 'status' || status.backend !== 'desktop-bridge' || status.pid !== bridge.pid) throw Error('Unexpected Gemini bridge status.');
    return status;
  }
  if (!fs.existsSync(config.geminiPython)) throw Error('Gemini automation runtime is missing. Run agent-dispatch gemini setup.');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ad-gemini-status-')), file = path.join(dir, 'request.json');
  try {
    fs.writeFileSync(file, JSON.stringify(geminiRequest(config)), { flag: 'wx', mode: 0o600 });
    const result = await spawnCaptured(config.geminiPython, ['-I', '-u', GEMINI_SCRIPT, file], { timeoutMs: 20_000 });
    let status: any;
    try { status = JSON.parse(result.stdout.trim()); } catch {}
    if (!result.ok || status?.event !== 'status') throw Error(status?.message ?? result.error ?? 'Gemini automation status is unavailable. Run gemini setup and open the app.');
    return { worker: 'gemini', backend: 'desktop-uia', ...status };
  } finally { fs.unlinkSync(file); fs.rmdirSync(dir); }
}

/** Bridge installation is reversible; the legacy UIA runtime is opt-in only. */
export async function setupGemini(raw: any = {}) {
  if (process.platform !== 'win32') throw Error('Gemini Desktop automation currently supports Windows only.');
  const config = geminiPaths(raw);
  if (!fs.existsSync(config.geminiExe)) throw Error('Gemini Desktop executable is missing.');
  if (config.geminiBackend === 'bridge') return installGeminiBridge(config.geminiExe, !!raw.dryRun);
  const managed = home('.agent-dispatch/gemini-runtime');
  if (config.geminiPython !== path.join(managed, 'Scripts/python.exe')) {
    return probeGemini(config); // User-selected Python is never modified.
  }
  if (!fs.existsSync(config.geminiPython)) {
    const python = Bun.which('python');
    if (!python) throw Error('Python 3.10+ is required for the Windows UIA helper.');
    const created = await spawnCaptured(python, ['-m', 'venv', managed], { timeoutMs: 120_000 });
    if (!created.ok) throw Error('Could not create the isolated Gemini Python runtime: ' + (created.stderr || created.error));
  }
  const check = await spawnCaptured(config.geminiPython, ['-I', '-c', 'import comtypes; assert comtypes.__version__ == "1.4.17"'], { timeoutMs: 15_000 });
  if (!check.ok) {
    const installed = await spawnCaptured(config.geminiPython, ['-I', '-m', 'pip', 'install', '--disable-pip-version-check', 'comtypes==1.4.17'], { timeoutMs: 120_000 });
    if (!installed.ok) throw Error('Could not install the Gemini UIA dependency: ' + (installed.stderr || installed.error));
  }
  return probeGemini(config);
}
