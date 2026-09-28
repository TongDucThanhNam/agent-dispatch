import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { readTrajectory } from './trajectory.ts';

// Numeric codes are ZCode's; the named ones are Codex/OpenAI usage-limit codes.
export const QUOTA_CODES = new Set(['1304', '1308', '1310', '1316', '1317', '1318', '1319', '1320', '1321', 'usage_limit_reached', 'insufficient_quota']);
const ACCOUNT_CODES = new Set(['1110', '1111', '1112', '1113', '1121', '1309', '1311', '1313', '1314', '1315']);
const AUTH_CODES = new Set(['1000', '1001', '1002', '1003', '1004', '1005']);
const RATE_CODES = new Set(['1302', '1303', '1305', '1312']);

export function clean(value, limit = 240) {
  return String(value ?? '')
    .replace(/\u001b\[[0-9;]*[A-Za-z]/g, '')
    .replace(/\bBearer\s+[^\s"'<>]+/gi, 'Bearer [redacted]')
    .replace(/\bsk-[A-Za-z0-9_-]{8,}/g, '[redacted]')
    .replace(/((?:api[_-]?key|token|password|secret|authorization)\s*[=:]\s*["']?)[^\s"',}&<>]+/gi, '$1[redacted]')
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, '')
    .slice(0, limit);
}

function json(value, fallback = null) {
  try { return typeof value === 'string' ? JSON.parse(value) : value ?? fallback; }
  catch { return fallback; }
}

// Only call this on provider/runtime error fields, never prompt or tool-output text.
export function classifyError(raw) {
  const root = json(raw) ?? (typeof raw === 'string' ? { message: raw } : {});
  const nodes = [root];
  for (let i = 0; i < nodes.length && i < 12; i++) {
    const node = nodes[i];
    if (!node || typeof node !== 'object') continue;
    for (const key of ['error', 'data', 'responseBody', 'body', 'cause']) {
      const next = json(node[key]);
      if (next && typeof next === 'object' && !nodes.includes(next)) nodes.push(next);
    }
  }
  const objects = nodes.filter(x => x && typeof x === 'object');
  const messages = objects.map(x => x.message ?? x.error_message).filter(x => typeof x === 'string');
  const message = messages.at(-1) ?? '';
  const codes = objects.map(x => x.code ?? x.error_code).filter(x => x !== undefined && x !== null).map(String);
  const code: any = codes.find(x => QUOTA_CODES.has(x) || ACCOUNT_CODES.has(x) || AUTH_CODES.has(x) || RATE_CODES.has(x))
    ?? codes.at(-1) ?? message.match(/\[(1\d{3})\]/)?.[1] ?? null;
  const httpStatus = objects.map(x => x.statusCode ?? x.httpStatus ?? x.status).find(x => /^\d{3}$/.test(String(x)));
  let kind = 'provider_error';
  if (QUOTA_CODES.has(code)) kind = 'quota';
  else if (ACCOUNT_CODES.has(code)) kind = 'account';
  else if (AUTH_CODES.has(code) || Number(httpStatus) === 401) kind = 'auth';
  else if (RATE_CODES.has(code) || Number(httpStatus) === 429) kind = 'rate_limit';
  else if (Number(httpStatus) === 403) kind = 'account';
  else if (/no permission client|permission (?:denied|required)|approval required/i.test(message)) kind = 'permission';
  else if (/ECONNRESET|ECONNREFUSED|ETIMEDOUT|network error|fetch failed|connection (?:closed|reset)/i.test(message)) kind = 'network';
  else if (code === 'UNAUTHENTICATED' || /authentication required|not (?:signed|logged) in|login required/i.test(message)) kind = 'auth';
  else if (code === 'PERMISSION_DENIED') kind = 'permission';
  else if (code === 'RESOURCE_EXHAUSTED' || /rate limit(?:ed| reached| exceeded)|too many requests/i.test(message)) kind = 'rate_limit';
  // A provider error may omit its code. An explicit exhaustion message is still evidence.
  if ((!code || ![QUOTA_CODES,ACCOUNT_CODES,AUTH_CODES,RATE_CODES].some(codes=>codes.has(code))) &&
    /(?:quota|usage limit|weekly limit|monthly limit|credit balance).{0,60}(?:exhausted|reached|exceeded)|(?:exhausted|exceeded).{0,50}(?:quota|capacity|credits|usage limit)|hit (?:your|the) usage limit|insufficient quota|out of (?:quota|credits)/i.test(message)) kind = 'quota';
  const resetField = objects.map(x => x.next_flush_time ?? x.reset_at ?? x.resetAt).find(x => x != null);
  const resetHint = clean(resetField ?? message.match(/(?:will reset at|resets? at)\s+([^\n}]+)/i)?.[1] ?? '', 140) || null;
  return { kind, code, httpStatus: httpStatus ? Number(httpStatus) : null, message: clean(message, 600), resetHint,
    stop: ['quota', 'account', 'auth', 'permission'].includes(kind) };
}

function normalizedDirectory(value) { return path.resolve(value).replaceAll('\\', '/').replace(/\/$/, '').toLowerCase(); }

// Read-only, narrow projections: no prompt, reasoning text, tool output or credentials leave this reader.
export function openTelemetry(dbPath) {
  if (!fs.existsSync(dbPath)) return { read: () => ({ available: false, reason: 'Session database is not available yet.' }), close() {} };
  const db = new DatabaseSync(dbPath, { readOnly: true });
  db.exec('PRAGMA query_only=ON; PRAGMA busy_timeout=500');
  const tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(x => x.name));
  let boundSession: any = null;
  const all = (sql, ...args) => db.prepare(sql).all(...args);
  return {
    close() { db.close(); },
    read({ sessionId, project, startedAt, runId, includeTrajectory = false }) {
      try {
        if (!tables.has('session') || !tables.has('message') || !tables.has('part')) return { available: false, reason: 'Unsupported session database schema.' };
        if (sessionId) boundSession = sessionId;
        if (!boundSession) {
          const marker = `Dispatch run: ${runId}\n`;
          const candidates = all('SELECT id,directory FROM session WHERE parent_id IS NULL AND time_created>=? ORDER BY time_created DESC LIMIT 100', startedAt - 2000)
            .filter(x => normalizedDirectory(x.directory) === normalizedDirectory(project));
          const matches = candidates.filter(candidate => all(`SELECT p.id FROM part p JOIN message m ON m.id=p.message_id
            WHERE p.session_id=? AND m.time_created>=? AND json_valid(m.data) AND json_valid(p.data)
            AND json_extract(m.data,'$.role')='user' AND json_extract(p.data,'$.type')='text'
            AND substr(json_extract(p.data,'$.text'),1,?)=? LIMIT 1`, candidate.id, startedAt - 2000, marker.length, marker).length);
          if (matches.length > 1) return { available: false, reason: 'Ambiguous session association; no session has been selected.' };
          boundSession = matches[0]?.id ?? null;
        }
        if (!boundSession) return { available: true, sessionId: null, lastActivityAt: startedAt, errors: [], tools: [], todos: [] };
        const session = db.prepare('SELECT id,directory,time_created,time_updated FROM session WHERE id=?').get(boundSession);
        if (!session || normalizedDirectory(session.directory) !== normalizedDirectory(project)) throw new Error('Session belongs to a different project.');
        const messageMeta = all(`SELECT id,time_updated,json_extract(data,'$.role') role,json_extract(data,'$.modelID') model,
          json_extract(data,'$.providerID') provider,json_extract(data,'$.error') error FROM message
          WHERE session_id=? AND time_created>=? AND json_valid(data) ORDER BY time_created DESC LIMIT 50`, boundSession, startedAt - 2000);
        const parts = all(`SELECT id,time_updated,json_extract(data,'$.type') type,json_extract(data,'$.tool') tool,
          json_extract(data,'$.state.status') status,json_extract(data,'$.state.time.start') started,
          json_extract(data,'$.state.time.end') ended,json_extract(data,'$.state.error') tool_error,
          CASE WHEN json_extract(data,'$.type')='retry' THEN json_extract(data,'$.error') END retry_error
          FROM part WHERE session_id=? AND time_updated>=? AND json_valid(data) ORDER BY time_updated DESC LIMIT 80`, boundSession, startedAt - 2000);
        const messageErrors = messageMeta.filter(x => x.error).map(x => ({ id: x.id, at: x.time_updated, ...classifyError(x.error) }));
        const retryErrors = parts.filter(x => x.retry_error).map(x => ({ id: x.id, at: x.time_updated, ...classifyError(x.retry_error) }));
        let errors = retryErrors.length ? retryErrors : messageErrors;
        let usage: any = null;
        let latestSuccessAt = 0;
        let currentModel: any = null;
        if (tables.has('model_usage')) {
          const rows = all(`SELECT id,logical_request_id,attempt_index,status,provider_id,model_id,started_at,completed_at,
            input_tokens,output_tokens,cache_read_input_tokens,retry_count,error_code,error_message
            FROM model_usage WHERE session_id=? AND started_at>=? ORDER BY started_at DESC`, boundSession, startedAt - 2000);
          const sum = key => rows.reduce((n, x) => n + (Number(x[key]) || 0), 0);
          if (rows.length) usage = { modelCalls: rows.length, inputTokens: sum('input_tokens'), outputTokens: sum('output_tokens'),
            cacheReadTokens: sum('cache_read_input_tokens'), retries: sum('retry_count') };
          currentModel = rows[0] ? { model: rows[0].model_id, provider: rows[0].provider_id, status: rows[0].status, startedAt: rows[0].started_at } : null;
          latestSuccessAt = Math.max(0, ...rows.filter(x => ['completed', 'success', 'succeeded'].includes(x.status) && !x.error_code).map(x => x.completed_at ?? 0));
          const usageErrors = rows.filter(x => x.error_code || x.error_message).map(x => ({ id: x.id, at: x.completed_at ?? x.started_at,
            requestId: x.logical_request_id, attempts: Math.max((x.attempt_index ?? 0) + 1, (x.retry_count ?? 0) + 1),
            ...classifyError({ code: x.error_code, message: x.error_message }) }));
          // The same failure is often persisted in usage, retry and message records.
          // Use one source, otherwise one attempt can appear to consume the retry budget three times.
          if (usageErrors.length) errors = usageErrors;
        }
        const todos = tables.has('todo') ? all('SELECT content,status,position FROM todo WHERE session_id=? ORDER BY position LIMIT 20', boundSession)
          .map(x => ({ content: clean(x.content, 160), status: clean(x.status, 30) })) : [];
        const tools = parts.filter(x => x.type === 'tool').map(x => ({ id: x.id, name: clean(x.tool, 60), status: clean(x.status, 40),
          startedAt: x.started ?? x.time_updated, updatedAt: x.time_updated, endedAt: x.ended, error: x.tool_error ? clean(x.tool_error, 300) : null }));
        const lastActivityAt = Math.max(startedAt, ...messageMeta.map(x => x.time_updated), ...parts.map(x => x.time_updated), currentModel?.startedAt ?? 0, latestSuccessAt);
        const assistant = messageMeta.find(x => x.role === 'assistant');
        return { available: true, sessionId: boundSession, lastActivityAt, latestSuccessAt, usage, tools, todos,
          model: currentModel?.model ?? assistant?.model ?? null, provider: currentModel?.provider ?? assistant?.provider ?? null,
          modelStatus: currentModel?.status ?? null, errors: errors.filter(x => x.at >= startedAt - 2000 && x.at > latestSuccessAt).sort((a, b) => b.at - a.at),
          lastPartType: parts[0]?.type ?? null,
          ...(includeTrajectory ? { trajectory: readTrajectory(db, { sessionId: boundSession, startedAt }) } : {}) };
      } catch (error) { return { available: false, reason: clean(error.message, 180), sessionId: boundSession }; }
    }
  };
}

export function assess(telemetry, { now, startedAt, quietMs = 180_000, stallMs = 600_000, maxRetries = 3 }) {
  if (!telemetry.available) return { phase: 'monitor_limited', alert: now - startedAt >= stallMs ? { key: 'telemetry', kind: 'monitor_unavailable', message: 'Local activity cannot be read. The worker may still be running.' } : null };
  const errors = telemetry.errors ?? [];
  const hard = errors.find(x => x.stop);
  if (hard) return { phase: `${hard.kind}_blocked`, stop: hard, alert: { key: 'terminal', kind: hard.kind, message: hard.message, resetHint: hard.resetHint } };
  const temporary = errors.filter(x => ['rate_limit', 'network'].includes(x.kind));
  const attempts = Math.max(temporary.length, ...temporary.map(x => x.attempts ?? 1), 0);
  if (attempts >= maxRetries) return { phase: 'retry_exhausted', stop: { kind: 'retry_exhausted', message: `Observed ${attempts} failed provider attempts without a later successful request.` },
    alert: { key: 'terminal', kind: 'retry_exhausted', message: `Provider retries reached the configured limit (${maxRetries}).` } };
  const quietFor = now - (telemetry.lastActivityAt ?? startedAt);
  if (temporary.length) return { phase: 'waiting_retry', retryAttempts: attempts,
    alert: quietFor >= stallMs ? { key: 'provider_wait', kind: 'possibly_stalled', message: 'The provider has not recovered and there is no recent recorded activity. The worker has not been stopped.' } : null };
  const runningTool = telemetry.tools?.find(x => ['running', 'pending'].includes(x.status));
  if (quietFor >= stallMs) return { phase: 'possibly_stalled', alert: { key: 'inactivity', kind: 'possibly_stalled',
    message: `No recorded activity for ${Math.floor(quietFor / 60_000)} minutes${runningTool ? `; ${runningTool.name} is ${runningTool.status}` : ''}. Silence alone does not prove a hang. The worker has not been stopped.` } };
  const failedTools = (telemetry.tools ?? []).filter(x => x.status === 'error' && x.error && now - x.updatedAt < stallMs);
  for (const tool of failedTools) {
    const same = failedTools.filter(x => x.name === tool.name && x.error === tool.error);
    const recovered = telemetry.tools.some(x => x.name === tool.name && x.status === 'completed' && x.updatedAt > tool.updatedAt);
    if (same.length >= 3 && !recovered) return { phase: 'repeated_tool_error', alert: { key: `tool:${tool.name}`, kind: 'repeated_tool_error',
      message: `The same ${tool.name} error occurred ${same.length} times. The worker has not been stopped.` } };
  }
  return { phase: quietFor >= quietMs ? 'quiet' : runningTool ? 'using_tool' : telemetry.sessionId ? 'working' : 'starting', alert: null };
}
