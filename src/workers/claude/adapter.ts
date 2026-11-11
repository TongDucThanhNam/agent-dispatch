import fs from 'node:fs';
import path from 'node:path';
import { spawnCaptured } from '../../core/fsutil.ts';

import { createMessagesProjection, startMessagesWorker, type MessagesProfile } from '../messages.ts';

export const CLAUDE_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
export const CLAUDE_ALIASES = ['default', 'best', 'fable', 'opus', 'sonnet', 'haiku'] as const;
const modelName = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9:._/-]{0,199}(?:\[1m\])?$/.test(value);
const baseModel = value => String(value ?? '').replace(/\[1m\]$/, '');
const json = value => JSON.stringify(value);
/** Advisory only: managed/account defaults and alias resolution are owned by the CLI. */
export function readClaudeSelection(home, project = process.cwd(), env = process.env) {
  let settings: any = {}, variables: any = { ...env };
  for (const file of [path.join(home, 'settings.json'), path.join(project, '.claude', 'settings.json'), path.join(project, '.claude', 'settings.local.json')]) {
    let value: any; try { value = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')); } catch { continue; }
    if (!value || typeof value !== 'object') continue;
    settings = { ...settings, ...value }; variables = { ...variables, ...value.env };
  }
  const model = variables.ANTHROPIC_MODEL || settings.model || variables.ANTHROPIC_DEFAULT_MODEL || null;
  const effort = variables.CLAUDE_CODE_EFFORT_LEVEL || settings.effortLevel || null;
  return { model: modelName(model) ? model : null, effort: CLAUDE_EFFORTS.includes(effort) ? effort : null };
}

export async function readClaudeRuntime(exe) {
  const result = await spawnCaptured(exe, ['--version'], { timeoutMs: 10_000 });
  const match = result.stdout.match(/^(\d+)\.(\d+)\.(\d+)\s+\(Claude Code\)/m);
  const version = match ? match.slice(1, 4).join('.') : null;
  // --permission-prompts none was added in 2.1.259.
  const supported = !!match && (+match[1] > 2 || (+match[1] === 2 && (+match[2] > 1 || (+match[2] === 1 && +match[3] >= 259))));
  return { ok: result.ok && supported, version, ...(result.ok && supported ? {} : { error: result.error || result.stderr.trim() || 'Claude Code 2.1.259 or later is required.' }) };
}

export function buildClaudeArgs(config) {
  const args = ['--print', '--output-format', 'stream-json', '--verbose', '--include-partial-messages', '--forward-subagent-text',
    '--permission-mode', config.mode === 'plan' ? 'plan' : 'bypassPermissions', '--permission-prompts', 'none'];
  let model = config.claudeResolvedModel ?? config.claudeModel;
  if (model && config.claudeModel?.endsWith('[1m]') && !model.endsWith('[1m]')) model += '[1m]';
  if (model) args.push('--model', model);
  if (config.claudeEffort) args.push('--effort', config.claudeEffort, '--settings', json({ env: { CLAUDE_CODE_EFFORT_LEVEL: config.claudeEffort } }));
  if (config.resumeSessionId) args.push('--resume', config.resumeSessionId);
  return args;
}

export function claudeEnv(config, base = process.env) {
  const env: any = {};
  for (const [key, value] of Object.entries(base)) if (!/^CODEX_(?:THREAD_ID|CI|SANDBOX\w*|INTERNAL_\w*|TURN_\w*|SESSION_\w*)$/i.test(key)) env[key] = value;
  env.CLAUDE_CONFIG_DIR = config.claudeHome;
  if (config.claudeEffort) env.CLAUDE_CODE_EFFORT_LEVEL = config.claudeEffort;
  // Keep Claude's child-session markers: current -p sessions persist even when nested.
  return env;
}

export function claudeError(raw, code: string | null = null) {
  const value = raw && typeof raw === 'object' ? raw : { message: typeof raw === 'string' ? raw : 'Claude reported an error.' };
  const message = typeof value.message === 'string' ? value.message : 'Claude reported an error.';
  const category = code ?? value.code;
  const mapped = ({ authentication_failed: 'UNAUTHENTICATED', cloud_credential_error: 'UNAUTHENTICATED',
    oauth_org_not_allowed: 'PERMISSION_DENIED', billing_error: 'insufficient_quota', rate_limit: 'RESOURCE_EXHAUSTED' } as any)[category];
  const status = value.httpStatus ?? value.api_error_status ?? (category === 'account_on_hold' ? 403 : Number(message.match(/\b(?:status\s*)?(401|403|429|529)\b/)?.[1]));
  return { ...value, message, ...(mapped || category ? { code: mapped ?? category } : {}),
    ...(status ? { httpStatus: status } : {}), ...(message.match(/(?:try again|resets?) (?:at|in) [^.\n]{1,80}/i)?.[0]
      ? { resetAt: message.match(/(?:try again|resets?) (?:at|in) [^.\n]{1,80}/i)![0] } : {}) };
}

const profile: MessagesProfile = { kind: 'claude', label: 'Claude', aliases: CLAUDE_ALIASES, normalizeModel: baseModel, errorOf: claudeError };

export const createClaudeProjection = (config, options: any = {}) => createMessagesProjection(config, profile, options);
export const startClaude = (config, options, deps: any = {}) => startMessagesWorker(config, profile,
  { command: config.claudeExe, args: buildClaudeArgs(config), env: claudeEnv(config) }, options, deps);
