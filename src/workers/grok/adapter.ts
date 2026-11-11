import fs from 'node:fs';
import path from 'node:path';
import { spawnCaptured } from '../../core/fsutil.ts';
import { createMessagesProjection, startMessagesWorker, type MessagesProfile } from '../messages.ts';

export const GROK_EFFORTS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const;

/** Probe capabilities, not a model request; older CLIs without Messages output are rejected. */
export async function readGrokRuntime(exe) {
  const results = await Promise.allSettled([
    spawnCaptured(exe, ['--version'], { timeoutMs: 10_000 }),
    spawnCaptured(exe, ['--help'], { timeoutMs: 10_000 }),
  ]);
  const [versionResult, helpResult] = results.map(result => result.status === 'fulfilled' ? result.value : null);
  const version = versionResult?.stdout.match(/^grok (\d+\.\d+\.\d+)\b/m)?.[1] ?? null;
  const supported = ['streaming-messages-json', '--prompt-file', '--include-partial-messages', '--permission-mode', '--resume']
    .every(flag => helpResult?.stdout.includes(flag));
  const ok = !!version && !!versionResult?.ok && !!helpResult?.ok && supported;
  return { ok, version, ...(ok ? {} : { error: 'Grok Build with streaming-messages-json, prompt-file and exact-session resume is required. Update the native grok CLI.' }) };
}

export function grokEnv(config, base = process.env) {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(base)) {
    if (/^(?:CODEX_(?:THREAD_ID|CI|SANDBOX\w*|INTERNAL_\w*|TURN_\w*|SESSION_\w*)|CLAUDECODE|CLAUDE_CODE_CHILD_SESSION)$/i.test(key)) continue;
    env[key] = value;
  }
  env.GROK_HOME = config.grokHome;
  return env;
}

/** Native account catalog only; never reads or returns credential files. */
export async function readGrokModels(config) {
  const result = await spawnCaptured(config.grokExe, ['models'], { timeoutMs: 30_000, cwd: config.project, env: grokEnv(config) });
  if (!result.ok) throw new Error('Grok model catalog is unavailable. Run grok models to check authentication and model access.');
  const output = result.stdout.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '');
  const model = output.match(/^Default model:\s*([A-Za-z0-9][A-Za-z0-9._/-]{0,100})\s*$/m)?.[1] ?? null;
  const models = [...output.matchAll(/^\s*[*-]\s+([A-Za-z0-9][A-Za-z0-9._/-]{0,100})(?:\s+\(default\))?\s*$/gm)].map(match => match[1]);
  if (!model || !models.includes(model)) throw new Error('Grok returned an unrecognized model catalog. Inspect grok models; no selection was changed.');
  return { model, models };
}

export function buildGrokArgs(config) {
  const args = ['--prompt-file', path.join(config.runDir, 'grok-prompt.md'), '--cwd', config.project,
    '--output-format', 'streaming-messages-json', '--include-partial-messages',
    '--permission-mode', config.mode === 'plan' ? 'plan' : 'bypassPermissions'];
  const model = config.grokResolvedModel ?? config.grokModel;
  if (model) args.push('--model', model);
  if (config.grokEffort) args.push('--reasoning-effort', config.grokEffort);
  if (config.resumeSessionId) args.push('--resume', config.resumeSessionId);
  // Do not filter tools: X search, web search and native/project MCP settings stay available.
  return args;
}

export function grokError(raw, code: string | null = null) {
  const value = raw && typeof raw === 'object' ? raw : { message: typeof raw === 'string' ? raw : 'Grok reported an error.' };
  const message = typeof value.message === 'string' ? value.message : 'Grok reported an error.';
  const category = code ?? value.code;
  const mapped = ({ authentication_error: 'UNAUTHENTICATED', authentication_failed: 'UNAUTHENTICATED',
    invalid_api_key: 'UNAUTHENTICATED', rate_limit_error: 'RESOURCE_EXHAUSTED', billing_error: 'insufficient_quota' } as any)[category];
  const status = value.httpStatus ?? value.api_error_status ?? Number(message.match(/\b(401|403|429|529)\b/)?.[1]);
  return { ...value, message, ...(mapped || category ? { code: mapped ?? category } : {}), ...(status ? { httpStatus: status } : {}) };
}

const profile: MessagesProfile = { kind: 'grok', label: 'Grok Build', errorOf: grokError };
export const createGrokProjection = (config, options: any = {}) => createMessagesProjection(config, profile, options);

export function startGrok(config, options, deps: any = {}) {
  const promptFile = path.join(config.runDir, 'grok-prompt.md');
  fs.writeFileSync(promptFile, options.prompt, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
  return startMessagesWorker(config, profile, { command: config.grokExe, args: buildGrokArgs(config), env: grokEnv(config), promptFile }, options, deps);
}
