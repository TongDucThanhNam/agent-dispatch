import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { StringDecoder } from 'node:string_decoder';
import { fileURLToPath } from 'node:url';
import { writeFileAtomic } from '../../core/fsutil.ts';

export const EFFORTS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh'];
export const isThreadId = value => /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value ?? '');
const json = value => JSON.stringify(value);
const finite = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
const MAX_TEXT = 1_000_000;
const bounded = (value, size) => { const text = typeof value === 'string' ? value : value == null ? '' : json(value);
  return text.length > size ? `${text.slice(0, size)}\n… [${text.length - size} more characters not recorded]` : text; };
const safeId = value => String(value ?? '').replace(/[^A-Za-z0-9_.:-]/g, '').slice(0, 120);
const firstLine = value => String(value ?? '').split(/\r?\n/).map(x => x.trim()).find(Boolean)?.slice(0, 200) ?? '';
const realOrNull = file => { try { return fs.realpathSync(file); } catch { return null; } };
const inside = (root, file) => { const rel = path.relative(root, file); return Boolean(rel) && !rel.startsWith('..') && !path.isAbsolute(rel); };
const fatal = message => Object.assign(new Error(message), { fatal: true });

// Codex reports paths as plain, \\?\-prefixed or file:// URIs.
function localPath(value) {
  if (typeof value !== 'string' || !value) return null;
  let file = value.replace(/^\\\\\?\\/, '');
  if (/^file:/i.test(file)) { try { file = fileURLToPath(file); } catch { return null; } }
  return file;
}
function directory(value) {
  const file = localPath(value); if (!file) return null;
  const resolved = (realOrNull(file) ?? path.resolve(file)).replace(/(?<=[^\\/:])[\\/]+$/, '');
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

// Reads only the default selection keys; the CLI still applies the full config itself.
export function readCodexSelection(home) {
  let text = ''; try { text = fs.readFileSync(path.join(home, 'config.toml'), 'utf8').replace(/^\uFEFF/, ''); } catch {}
  const tables: any = { '': {} }; let table = '', multiline = false;
  for (const line of text.split(/\r?\n/)) {
    const quotes = (line.match(/"""|'''/g) ?? []).length;
    if (multiline) { if (quotes % 2) multiline = false; continue; }
    if (quotes % 2) { multiline = true; continue; }
    const header = line.match(/^\s*\[\s*([^[\]]+?)\s*\]\s*(?:#.*)?$/);
    if (header) { table = header[1].replace(/["']/g, ''); tables[table] ??= {}; continue; }
    if (/^\s*\[\[/.test(line)) { table = '\0array'; continue; }
    const pair = line.match(/^\s*([A-Za-z0-9_-]+)\s*=\s*(?:"([^"\\]*)"|'([^']*)')\s*(?:#.*)?$/);
    if (pair) (tables[table] ??= {})[pair[1]] = pair[2] ?? pair[3];
  }
  const top = tables[''], profile = top.profile ? tables[`profiles.${top.profile}`] ?? {} : {};
  const pick = key => profile[key] ?? top[key] ?? null;
  const model = pick('model'), effort = pick('model_reasoning_effort'), provider = pick('model_provider') ?? 'openai';
  return { model: /^[A-Za-z0-9][A-Za-z0-9._/-]{0,100}$/.test(model ?? '') ? model : null, effort: EFFORTS.includes(effort) ? effort : null,
    provider: /^[A-Za-z0-9][A-Za-z0-9._-]{0,60}$/.test(provider) ? provider : null };
}

export function buildCodexArgs(config) {
  const args = ['--json', '--skip-git-repo-check', '-m', config.codexModel, '-c', `model_provider="${config.codexProvider}"`,
    '-c', `sandbox_mode="${config.mode === 'plan' ? 'read-only' : 'danger-full-access'}"`, '-c', 'approval_policy="never"'];
  if (config.codexEffort) args.push('-c', `model_reasoning_effort="${config.codexEffort}"`);
  args.push('-o', path.join(config.runDir, 'last-message.txt'));
  // The prompt is written to stdin ("-"), never to the command line.
  return config.resumeSessionId ? ['exec', 'resume', ...args, config.resumeSessionId, '-'] : ['exec', '-C', config.project, ...args, '-'];
}

// A worker launched from inside a Codex task must start its own thread, not inherit the caller's.
export function codexEnv(config, base = process.env) {
  const env: any = {};
  for (const [key, value] of Object.entries<any>(base)) if (!/^CODEX_(?:THREAD_ID|CI|SANDBOX\w*|INTERNAL_\w*|TURN_\w*|SESSION_\w*)$/i.test(key)) env[key] = value;
  env.CODEX_HOME = config.codexHome;
  return env;
}

// Codex error events are plain messages; add the fields the shared classifier understands.
export function codexError(raw, rateLimits: any = null) {
  const source = raw && typeof raw === 'object' ? raw : { message: String(raw ?? '') };
  const message = typeof source.message === 'string' && source.message.trim() ? source.message : 'Codex reported an error.';
  const status = Number(message.match(/\bstatus(?:\s+code)?\s*:?\s*(\d{3})\b/i)?.[1] ?? message.match(/^\s*(\d{3})\s+[A-Z]/)?.[1]);
  const quota = /\b(?:hit|reached|exceeded)\s+(?:your|the)\s+usage limit|usage limit (?:has been )?(?:reached|exceeded)/i.test(message);
  const code = source.code ?? (quota ? 'usage_limit_reached' : null);
  const resetAt = message.match(/try again (?:at|in) [^.\n]{1,80}/i)?.[0] ?? (quota ? rateLimits?.primary?.resetsAt : null) ?? null;
  return { message: bounded(message, 4000), ...(code ? { code: String(code) } : {}), ...(status >= 400 && status < 600 ? { httpStatus: status } : {}),
    ...(resetAt ? { resetAt } : {}) };
}

const limitsOf = value => { const window = x => x && typeof x === 'object' ? { usedPercent: finite(x.used_percent), windowMinutes: finite(x.window_minutes),
  resetsAt: finite(x.resets_at) ? new Date(x.resets_at * 1000).toISOString() : null } : null;
  return { primary: window(value?.primary), secondary: window(value?.secondary) }; };

// Rollouts live under CODEX_HOME/sessions/YYYY/MM/DD/rollout-<time>-<thread>.jsonl; the state DB indexes them.
export function locateRollout(home, id, { deep = false, now = Date.now() } = {}) {
  if (!isThreadId(id)) return null;
  const root = realOrNull(path.join(home, 'sessions')); if (!root) return null;
  const suffix = `-${id.toLowerCase()}.jsonl`;
  const accept = file => { const resolved = typeof file === 'string' && file ? realOrNull(localPath(file)) : null;
    return resolved && inside(root, resolved) && path.basename(resolved).toLowerCase().endsWith(suffix) ? resolved : null; };
  let states: any[] = []; try { states = fs.readdirSync(home).filter(x => /^state_\d+\.sqlite$/.test(x)).sort((a, b) => Number(b.match(/\d+/)![0]) - Number(a.match(/\d+/)![0])); } catch {}
  for (const name of states) {
    let db; try { db = new DatabaseSync(path.join(home, name), { readOnly: true }); db.exec('PRAGMA busy_timeout=200');
      const hit = accept(db.prepare('SELECT rollout_path FROM threads WHERE id=?').get(id)?.rollout_path); if (hit) return hit; }
    catch {} finally { try { db?.close(); } catch {} }
  }
  const search = (dir, depth) => {
    let entries; try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return null; }
    for (const entry of entries) if (entry.isFile() && entry.name.toLowerCase().endsWith(suffix)) { const hit = accept(path.join(dir, entry.name)); if (hit) return hit; }
    if (depth > 0) for (const entry of entries.filter(x => x.isDirectory()).sort((a, b) => b.name.localeCompare(a.name))) { const hit = search(path.join(dir, entry.name), depth - 1); if (hit) return hit; }
    return null;
  };
  const pad = n => String(n).padStart(2, '0');
  for (const days of [0, -1, 1]) { const date = new Date(now + days * 86_400_000);
    const hit = search(path.join(root, String(date.getFullYear()), pad(date.getMonth() + 1), pad(date.getDate())), 0); if (hit) return hit; }
  return deep ? search(root, 3) : null;
}

function readFirstRecord(file, max = 8 << 20) {
  let fd; try { fd = fs.openSync(file, 'r'); const buffer = Buffer.alloc(Math.min(max, fs.fstatSync(fd).size));
    const text = buffer.subarray(0, fs.readSync(fd, buffer, 0, buffer.length, 0)).toString('utf8'), end = text.indexOf('\n');
    return end < 0 ? null : JSON.parse(text.slice(0, end)); } catch { return null; } finally { if (fd != null) fs.closeSync(fd); }
}
function readBounded(file, max = 8_000_000) { try { return fs.statSync(file).size > max ? null : fs.readFileSync(file, 'utf8'); } catch { return null; } }

const CONTEXT_LABELS = { permissions: 'permissions', collaboration_mode: 'collaboration mode', agents_md: 'AGENTS.md', environments: 'environment',
  generic: 'instructions', host_skills: 'skills', goal: 'goal', images: 'image notice', model_switch: 'model switch', multi_agent: 'multi-agent' };
const contextLabel = (kinds, role) => { const names = [...new Set(kinds.map(kind => kind === 'generic.turn_aborted' ? 'turn aborted'
  : CONTEXT_LABELS[kind.split('.')[0]] ?? kind.split('.')[0]))]; return names.length ? names.join(' + ') : role === 'developer' ? 'developer instructions' : 'injected context'; };
const ACTION_TOOLS = { CommandExecution: 'Shell', FileChange: 'Edit', ImageView: 'ViewImage', WebSearch: 'WebSearch', McpToolCall: 'MCP' };
const NOT_ACTIONS = new Set(['UserMessage', 'AgentMessage', 'Reasoning', 'ContextCompaction', 'Plan', 'HookPrompt', 'Error', 'Warning']);
const textOf = content => (Array.isArray(content) ? content : []).map(x => typeof x === 'string' ? x : typeof x?.text === 'string' ? x.text : '').filter(Boolean);
function outputText(output) {
  if (typeof output === 'string') return output;
  if (Array.isArray(output)) return output.map(x => typeof x === 'string' ? x : typeof x?.text === 'string' ? x.text : String(x?.type ?? '').includes('image') ? '[image]' : '').filter(Boolean).join('\n');
  if (output && typeof output === 'object') return typeof output.content === 'string' ? output.content : Array.isArray(output.content) ? outputText(output.content) : json(output);
  return '';
}
function scalars(item, skip) {
  const out: any = {};
  for (const [key, value] of Object.entries<any>(item)) if (!['id', 'type', ...skip].includes(key) && ['string', 'number', 'boolean'].includes(typeof value))
    out[key] = typeof value === 'string' ? bounded(value, 500) : value;
  return out;
}
function describeAction(item, begin, end) {
  const base = { tool: ACTION_TOOLS[item.type] ?? item.type, status: typeof item.status === 'string' ? item.status : 'completed', startedAt: begin, endedAt: end };
  if (item.type === 'CommandExecution') {
    const parsed = (item.parsed_cmd ?? []).map(x => x?.cmd).filter(x => typeof x === 'string');
    const command = parsed.length ? parsed.join(' ; ') : Array.isArray(item.command) ? String(item.command.at(-1) ?? '') : String(item.command ?? '');
    const exitCode = Number.isInteger(item.exit_code) ? item.exit_code : null;
    return { ...base, command: bounded(command, 4000), cwd: localPath(item.cwd), exitCode, status: item.status ?? (exitCode === 0 ? 'completed' : 'failed') };
  }
  if (item.type === 'FileChange') {
    const changes = Object.entries<any>(item.changes ?? {}), diff = changes.map(([file, change]) => change?.unified_diff ? `--- ${file}\n${change.unified_diff}`
      : change?.type === 'add' ? `+++ ${file} (new file)\n${change.content ?? ''}` : `*** ${file} (${change?.type ?? 'changed'})`).join('\n');
    return { ...base, path: changes[0]?.[0] ?? null, paths: changes.slice(0, 50).map(([file]) => file),
      kinds: [...new Set(changes.map(([, change]) => change?.type).filter(Boolean))], diff: bounded(diff, 20_000) };
  }
  if (item.type === 'ImageView') return { ...base, path: localPath(item.path) };
  if (item.type === 'WebSearch') return { ...base, query: typeof item.query === 'string' ? item.query : item.action?.query ?? null };
  // Extension results can be large binary payloads (image generation); keep scalar metadata only.
  if (item.type === 'Extension') return { ...base, ...scalars(item, ['kind', 'result', 'status']), tool: item.kind ? String(item.kind).slice(0, 60) : 'Extension' };
  return { ...base, ...scalars(item, ['status']) };
}
const actionOutput = item => item.type === 'CommandExecution' ? item.aggregated_output ?? item.formatted_output ?? item.stdout ?? ''
  : item.type === 'FileChange' ? describeAction(item, 0, 0).diff : '';

// A per-run projection lets Codex use the shared read-only dashboard/content reader.
// Codex's own rollout and state database are read, never written.
export function createCodexProjection(config, { prompt, startedAt = Date.now(), now = Date.now, onSession = (_id?: any) => {} }: any = {}) {
  if (path.resolve(config.dbPath) !== path.join(config.runDir, 'codex-events.sqlite')) throw new Error('Codex telemetry must be inside its run directory.');
  if (fs.existsSync(config.dbPath)) throw new Error('Codex telemetry already exists; inspect the run instead of duplicating it.');
  const db = new DatabaseSync(config.dbPath);
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=500;
    CREATE TABLE session(id TEXT PRIMARY KEY,directory TEXT,parent_id TEXT,time_created INTEGER,time_updated INTEGER);
    CREATE TABLE message(id TEXT PRIMARY KEY,session_id TEXT,time_created INTEGER,time_updated INTEGER,data TEXT);
    CREATE INDEX message_session ON message(session_id,time_created);
    CREATE TABLE part(id TEXT PRIMARY KEY,message_id TEXT,session_id TEXT,time_created INTEGER,time_updated INTEGER,data TEXT);
    CREATE INDEX part_session ON part(session_id,time_created);
    CREATE INDEX part_message ON part(message_id);
    CREATE TABLE todo(session_id TEXT,content TEXT,status TEXT,position INTEGER);
    CREATE TABLE model_usage(id TEXT PRIMARY KEY,logical_request_id TEXT,attempt_index INTEGER,status TEXT,provider_id TEXT,model_id TEXT,
      started_at INTEGER,completed_at INTEGER,input_tokens INTEGER,output_tokens INTEGER,cache_read_input_tokens INTEGER,retry_count INTEGER,
      error_code TEXT,error_message TEXT,session_id TEXT,assistant_message_id TEXT,reasoning_tokens INTEGER,first_token_at INTEGER,duration_ms INTEGER,
      cache_creation_input_tokens INTEGER,finish_reason TEXT,tool_call_count INTEGER,turn_id TEXT,query_source TEXT);`);
  const USAGE = ['id', 'logical_request_id', 'attempt_index', 'status', 'provider_id', 'model_id', 'started_at', 'completed_at', 'input_tokens', 'output_tokens',
    'cache_read_input_tokens', 'retry_count', 'error_code', 'error_message', 'session_id', 'assistant_message_id', 'reasoning_tokens', 'first_token_at',
    'duration_ms', 'cache_creation_input_tokens', 'finish_reason', 'tool_call_count', 'turn_id', 'query_source'];
  const putUsage = db.prepare(`INSERT OR REPLACE INTO model_usage(${USAGE}) VALUES(${USAGE.map(() => '?')})`);
  const putMessage = db.prepare(`INSERT INTO message VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET time_updated=excluded.time_updated,data=excluded.data`);
  const putPart = db.prepare(`INSERT INTO part VALUES(?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET time_updated=excluded.time_updated,data=excluded.data`);
  const touchSession = db.prepare('UPDATE session SET time_updated=max(time_updated,?) WHERE id=?');
  const projectDir = directory(config.project), expectedSandbox = config.mode === 'plan' ? 'read-only' : 'danger-full-access';
  let sessionId: any = null, terminal: any = null, closed = false, metaSeen = false, provider: any = null, model = config.codexModel ?? null, turnId: any = null;
  let lastInputAt = startedAt, request: any = null, lastRequest: any = null, requests = 0, sequence = 0, retries = 0, inputSeen = false, cancelled = false;
  let streamText: any = null, finalText: any = null, lastText: any = null, lastError: any = null, rateLimits: any = null, usage: any = null, compactionTokens: any = null, warnings = 0, lastWarning: any = null;
  let openCalls: any[] = [], usageRecords = false;
  const calls = new Map<any, any>();
  const transaction = work => { db.exec('BEGIN'); try { work(); db.exec('COMMIT'); } catch (error) { db.exec('ROLLBACK'); throw error; } };

  function initialize(id, at) {
    if (!isThreadId(id)) throw fatal('Codex returned an invalid thread ID.');
    if (config.resumeSessionId && id.toLowerCase() !== config.resumeSessionId.toLowerCase()) throw fatal('Codex resumed a different thread.');
    if (sessionId) { if (sessionId !== id) throw fatal('Codex changed thread during this run.'); return; }
    sessionId = id;
    db.prepare('INSERT INTO session VALUES(?,?,?,?,?)').run(id, config.project, null, startedAt, at);
    putMessage.run('codex-input', id, startedAt, at, json({ role: 'user', time: { created: startedAt } }));
    putPart.run('codex-input-text', 'codex-input', id, startedAt, at, json({ type: 'text', text: prompt }));
    onSession(id);
  }
  function putError(error, at) {
    const id = `codex-error-${++sequence}`;
    putMessage.run(id, sessionId, at, at, json({ role: 'assistant', modelID: model, providerID: provider, error, time: { created: at, completed: at } }));
  }
  function writeUsage(req, patch) {
    req.row = { ...req.row, ...patch };
    putUsage.run(...USAGE.map(key => req.row[key] ?? null));
  }
  function open(at) {
    if (request) return request;
    const id = `codex-req-${++requests}`, start = Math.min(lastInputAt, at);
    request = { id, start, firstTokenAt: null, calls: 0, parts: 0, model, provider };
    putMessage.run(id, sessionId, start, at, json({ role: 'assistant', modelID: model, providerID: provider, time: { created: start } }));
    writeUsage(request, { id, logical_request_id: id, attempt_index: 0, status: 'running', provider_id: provider, model_id: model, started_at: start,
      retry_count: 0, session_id: sessionId, assistant_message_id: id, turn_id: turnId, tool_call_count: 0 });
    return request;
  }
  function firstToken(req, at) { if (req.firstTokenAt == null || at < req.firstTokenAt) { req.firstTokenAt = at; writeUsage(req, { first_token_at: at }); } }

  function saveCall(call, at) {
    const names = [...new Set(call.actions.map(x => x.tool))], summary: any = {};
    const shell = call.actions.filter(x => x.tool === 'Shell' && x.command);
    if (shell.length) summary.command = bounded(shell.map(x => x.command).join(' ; '), 2000);
    const file = call.actions.find(x => x.path); if (file) summary.path = file.path;
    const search = call.actions.find(x => x.query); if (search) summary.query = search.query;
    if (!Object.keys(summary).length && call.input.code) summary.description = firstLine(call.input.code);
    const input = { ...summary, ...call.input, ...(call.actions.length ? { actions: call.actions } : {}) };
    putPart.run(call.id, call.messageId, sessionId, call.start, at, json({ type: 'tool', tool: names.length === 1 ? names[0] : call.name, callID: call.callId,
      state: { status: call.status, input, ...(call.output != null ? { output: call.output } : {}), ...(call.error ? { error: call.error } : {}),
        time: { start: call.start, ...(call.end ? { end: call.end } : {}) } } }));
  }
  function startCall(p, at) {
    const req = open(at), callId = safeId(p.call_id);
    let input;
    if (p.type === 'custom_tool_call') input = { code: bounded(p.input, 200_000) };
    else if (typeof p.arguments === 'string') { try { input = JSON.parse(p.arguments); } catch { input = { arguments: bounded(p.arguments, 200_000) }; } }
    else input = p.arguments ?? p.action ?? {};
    if (!input || typeof input !== 'object' || Array.isArray(input)) input = { value: input };
    const call = { id: `codex-call-${callId}`, callId, messageId: req.id, start: at, name: String(p.name ?? p.type.replace(/_call$/, '')).slice(0, 60),
      input, actions: [], status: 'running' };
    calls.set(callId, call); openCalls.push(call); req.calls++;
    if (call.name === 'update_plan' && Array.isArray(input.plan)) {
      db.prepare('DELETE FROM todo WHERE session_id=?').run(sessionId);
      input.plan.slice(0, 50).forEach((entry, index) => db.prepare('INSERT INTO todo VALUES(?,?,?,?)')
        .run(sessionId, bounded(entry?.step ?? entry?.content ?? '', 500), String(entry?.status ?? 'pending').slice(0, 30), index));
    }
    saveCall(call, at); writeUsage(req, { tool_call_count: req.calls });
  }
  function finishCall(p, at) {
    const call = calls.get(safeId(p.call_id));
    if (!call) { warnings++; return; }
    const text = outputText(p.output);
    const scriptError = /^Script failed\b/.test(text) ? text.match(/Script error:\s*([\s\S]*)/)?.[1] ?? text : null;
    const functionError = p.output && typeof p.output === 'object' && !Array.isArray(p.output) && p.output.success === false ? text : null;
    const failed = call.actions.find(x => x.status === 'failed');
    call.end = at; call.output = bounded(text, MAX_TEXT);
    call.error = scriptError ?? functionError ? bounded(String(scriptError ?? functionError).trim(), 4000)
      : failed ? `${failed.tool} failed${failed.exitCode != null ? ` (exit ${failed.exitCode})` : ''}: ${failed.command ?? failed.path ?? ''}`.slice(0, 1000) : null;
    call.status = call.error ? 'error' : 'completed';
    openCalls = openCalls.filter(x => x !== call);
    saveCall(call, at); lastInputAt = Math.max(lastInputAt, at);
  }
  // Actions run inside the open tool call (exec scripts); unmatched items are recorded on their own.
  function action(item, begin, end, at) {
    const summary = describeAction(item, begin, end);
    const call = openCalls.find(x => x.callId === safeId(item.id)) ?? [...openCalls].reverse().find(x => x.start <= begin + 5) ?? openCalls.at(-1);
    if (call) { if (call.actions.length < 50) call.actions.push(summary); saveCall(call, at); return; }
    const failed = summary.status === 'failed', { diff, tool, status, startedAt, endedAt, ...input } = summary;
    putPart.run(`codex-item-${safeId(item.id) || ++sequence}`, (request ?? lastRequest)?.id ?? 'codex-items', sessionId, begin, at, json({ type: 'tool', tool: summary.tool,
      state: { status: failed ? 'error' : 'completed', input, output: bounded(actionOutput(item), MAX_TEXT),
        ...(failed ? { error: `${summary.tool} failed${summary.exitCode != null ? ` (exit ${summary.exitCode})` : ''}` } : {}), time: { start: begin, end } } }));
  }
  function item(p, at) {
    const value = p.item ?? {}, begin = finite(p.started_at_ms) ?? at, end = finite(p.completed_at_ms) ?? at;
    if (typeof p.turn_id === 'string') turnId = p.turn_id;
    if (value.type === 'UserMessage') {
      const text = textOf(value.content).join('\n'), id = inputSeen ? `codex-user-${safeId(value.id) || ++sequence}` : 'codex-input';
      putMessage.run(id, sessionId, begin, end, json({ role: 'user', time: { created: begin }, anchor: { turnId } }));
      if (inputSeen) putPart.run(`${id}-text`, id, sessionId, begin, end, json({ type: 'text', text: bounded(text, MAX_TEXT) }));
      inputSeen = true; lastInputAt = Math.max(lastInputAt, end);
    } else if (value.type === 'AgentMessage' || value.type === 'Reasoning') {
      const req = open(begin), reasoning = value.type === 'Reasoning';
      const text = reasoning ? [...(value.summary_text ?? []), ...(value.raw_content ?? [])].filter(x => typeof x === 'string').join('\n\n') : textOf(value.content).join('');
      firstToken(req, begin);
      if (text.trim()) putPart.run(`${req.id}-${reasoning ? 'reasoning' : 'text'}-${++req.parts}`, req.id, sessionId, begin, end,
        json({ type: reasoning ? 'reasoning' : 'text', text: bounded(text, MAX_TEXT), ...(value.phase ? { phase: value.phase } : {}) }));
      if (!reasoning && text) lastText = text;
    } else if (value.type === 'ContextCompaction') {
      const id = `codex-compaction-${safeId(value.id) || ++sequence}`;
      putMessage.run(`${id}-message`, sessionId, begin, end, json({ role: 'system', time: { created: begin, completed: end } }));
      putPart.run(id, `${id}-message`, sessionId, begin, end, json({ type: 'compaction', trigger: 'auto',
        ...(compactionTokens != null ? { preCompactTokenCount: compactionTokens } : {}), time: { start: begin, end } }));
      compactionTokens = null;
    } else if (value.type && !NOT_ACTIONS.has(value.type)) action(value, begin, end, at);
  }
  function tokenUsage(p, at) {
    const req = open(at), u = p.usage ?? {};
    // input_tokens already includes cached_input_tokens for the Responses API.
    writeUsage(req, { status: 'completed', completed_at: at, logical_request_id: typeof p.response_id === 'string' ? p.response_id : req.id,
      input_tokens: finite(u.input_tokens), output_tokens: finite(u.output_tokens), cache_read_input_tokens: finite(u.cached_input_tokens),
      cache_creation_input_tokens: finite(u.cache_write_input_tokens), reasoning_tokens: finite(u.reasoning_output_tokens), duration_ms: at - req.start,
      finish_reason: req.calls ? 'tool_calls' : 'stop', tool_call_count: req.calls, turn_id: p.turn_id ?? req.row.turn_id });
    putMessage.run(req.id, sessionId, req.start, at, json({ role: 'assistant', modelID: req.model, providerID: req.provider, time: { created: req.start, completed: at } }));
    lastRequest = req; request = null; lastInputAt = Math.max(lastInputAt, at);
  }
  function context(p, at) {
    const kinds = (p.internal_chat_message_metadata_passthrough?.content_item_kinds ?? []).filter(x => typeof x === 'string');
    if (!['developer', 'user', 'system'].includes(p.role) || (p.role === 'user' && (!kinds.length || kinds.every(x => x.startsWith('user.'))))) return;
    const id = `codex-context-${safeId(p.id) || ++sequence}`, text = (Array.isArray(p.content) ? p.content : [])
      .map(x => typeof x?.text === 'string' ? x.text : String(x?.type ?? '').includes('image') ? '[image]' : '').filter(Boolean).join('\n\n');
    putMessage.run(id, sessionId, at, at, json({ role: 'user', synthetic: true, source: p.role, semantics: { kind: contextLabel(kinds, p.role), origin: 'system' },
      anchor: { turnId }, time: { created: at } }));
    putPart.run(`${id}-text`, id, sessionId, at, at, json({ type: 'text', text: bounded(text, MAX_TEXT), synthetic: true }));
  }
  function verifyContext(p) {
    if (p.cwd && directory(p.cwd) !== projectDir) throw fatal('Codex reported a different working directory.');
    const sandbox = p.sandbox_policy?.type ?? p.sandbox_policy?.mode;
    if (sandbox && sandbox !== expectedSandbox) throw fatal(`Codex applied the ${sandbox} sandbox instead of ${expectedSandbox}.`);
    if (p.approval_policy && p.approval_policy !== 'never') throw fatal('Codex did not apply the requested approval policy.');
    if (typeof p.model === 'string' && p.model) model = p.model;
    if (typeof p.turn_id === 'string') turnId = p.turn_id;
  }

  return {
    get sessionId() { return sessionId; },
    get terminal() { return terminal; },
    warn(message) { warnings++; lastWarning = String(message ?? '').slice(0, 300); },
    // codex exec --json stdout: thread identity, terminal state and errors.
    ingestEvent(record) {
      if (closed) throw new Error('Codex projection is closed.');
      if (!record || typeof record !== 'object' || typeof record.type !== 'string') throw fatal('Codex emitted an invalid stream event.');
      const at = now();
      transaction(() => {
        if (record.type === 'thread.started') initialize(record.thread_id, at);
        else if (terminal) return;
        else if (record.type === 'item.completed' && record.item?.type === 'agent_message' && typeof record.item.text === 'string') streamText = record.item.text;
        else if (record.type === 'turn.completed') {
          if (!sessionId) throw fatal('Codex success has no verified thread.');
          usage = record.usage && typeof record.usage === 'object' ? record.usage : null;
          terminal = { sessionId };
        } else if (record.type === 'turn.failed') {
          const error = codexError(record.error ?? { message: 'Codex reported a failed turn.' }, rateLimits);
          terminal = { sessionId, isError: true, error };
          if (sessionId) putError(error, at);
        } else if (record.type === 'error') {
          const message = typeof record.message === 'string' ? record.message : '';
          const retry = message.match(/^\s*Reconnecting\.*\s*(\d+)\s*\/\s*(\d+)/i);
          // Codex retries dropped streams itself; record them without consuming the monitor's retry budget.
          if (retry) { retries++; if (sessionId) { const id = `codex-retry-${retries}`;
            putMessage.run(`${id}-message`, sessionId, at, at, json({ role: 'system', time: { created: at } }));
            putPart.run(id, `${id}-message`, sessionId, at, at, json({ type: 'retry', attempt: Number(retry[1]), limit: Number(retry[2]),
              message: bounded(message, 2000), time: { start: at } })); } }
          else { lastError = codexError({ message }, rateLimits); if (sessionId) putError(lastError, at); }
        }
        if (sessionId) touchSession.run(at, sessionId);
      });
    },
    // Rollout JSONL: the detailed, timestamped history the stdout stream omits.
    ingestRollout(record) {
      if (closed) throw new Error('Codex projection is closed.');
      if (!sessionId || !record || typeof record !== 'object' || typeof record.type !== 'string') { warnings++; return; }
      const p = record.payload ?? {}, parsed = Date.parse(record.timestamp), at = Number.isFinite(parsed) ? parsed : now();
      transaction(() => {
        if (record.type === 'session_meta') {
          if (metaSeen) return; metaSeen = true;
          if (p.id && p.id !== sessionId) throw fatal('Codex rollout belongs to a different thread.');
          if (p.cwd && directory(p.cwd) !== projectDir) throw fatal('Codex reported a different working directory.');
          if (typeof p.model_provider === 'string' && p.model_provider) provider = p.model_provider;
          return;
        }
        if (record.type === 'turn_context') verifyContext(p);
        else if (record.type === 'token_usage_record') { usageRecords = true; tokenUsage(p, at); }
        else if (record.type === 'compacted') {
          // The compaction summary is itself a model request; label it instead of counting it as work.
          const req = lastRequest && (p.compaction_response_id ? lastRequest.row.logical_request_id === p.compaction_response_id : !lastRequest.calls && !lastRequest.parts) ? lastRequest : null;
          if (req) writeUsage(req, { finish_reason: 'compaction', query_source: 'compaction' });
          compactionTokens = (req ?? lastRequest)?.row.input_tokens ?? finite(p.latest_token_usage_record?.usage?.input_tokens);
        } else if (record.type === 'response_item') {
          if (p.type === 'message') context(p, at);
          else if (typeof p.type === 'string' && p.type.endsWith('_call_output') && p.call_id) finishCall(p, at);
          else if (typeof p.type === 'string' && p.type.endsWith('_call') && p.call_id) startCall(p, at);
        } else if (record.type === 'event_msg') {
          if (p.type === 'item_completed') item(p, at);
          else if (p.type === 'task_started' && typeof p.turn_id === 'string') turnId = p.turn_id;
          else if (p.type === 'task_complete' && typeof p.last_agent_message === 'string') finalText = p.last_agent_message;
          else if (p.type === 'turn_aborted') cancelled = true;
          else if (p.type === 'token_count') {
            if (p.rate_limits) rateLimits = limitsOf(p.rate_limits);
            // Older rollouts have no token_usage_record; their per-request usage is last_token_usage.
            if (!usageRecords && request && p.info?.last_token_usage) tokenUsage({ turn_id: turnId, usage: p.info.last_token_usage }, at);
          }
          else return;
        } else return;
        touchSession.run(at, sessionId);
      });
    },
    result({ failure = null, response = null }: any = {}) {
      const text = response?.trim() ? response : streamText ?? finalText ?? lastText ?? '';
      const base = { sessionId, response: text, ...(usage ? { usage } : {}), ...(rateLimits ? { rateLimits } : {}),
        telemetry: { requests, retries, warnings, ...(lastWarning ? { lastWarning } : {}) } };
      if (failure) return { ...base, isError: true, error: { message: failure.message } };
      if (terminal?.isError) return { ...base, isError: true, error: terminal.error };
      if (terminal) return base;
      if (cancelled) return { ...base, cancelled: true };
      return { ...base, isError: true, error: lastError ?? { message: 'Codex exited without a terminal result; completion is unconfirmed.' } };
    },
    close() { if (!closed) { closed = true; db.close(); } }
  };
}

// codex exec can stay alive after its terminal event, and a process it started (a hung test, a daemon) can inherit
// its stdout and keep the pipe open after it exits. Either would leave the run "running" forever, so both are bounded:
// onLingering asks the supervisor to close the worker tree; a held pipe is released after the process has exited.
export function startCodex(config, { prompt, startedAt, stderrFd, onSession, onFailure, onLingering, onNotice },
  { spawnFn = spawn, locate = locateRollout, tailMs = 500, exitGraceMs = 30_000, pipeGraceMs = 5_000 }: any = {}) {
  let rollout: any = null, offset = 0, resumeMeta: any = null;
  if (config.resumeSessionId) {
    // Resume appends to the saved rollout; only the new part belongs to this run.
    rollout = locate(config.codexHome, config.resumeSessionId, { deep: true });
    if (!rollout) throw new Error('The saved Codex thread rollout was not found; the resume cannot be verified.');
    offset = fs.statSync(rollout).size; resumeMeta = readFirstRecord(rollout);
  }
  const projection = createCodexProjection(config, { prompt, startedAt, onSession });
  let log, copy, child;
  try {
    log = fs.openSync(path.join(config.runDir, 'codex-events.jsonl'), 'wx');
    copy = fs.openSync(path.join(config.runDir, 'codex-rollout.jsonl'), 'wx');
    child = spawnFn(config.codexExe, buildCodexArgs(config), { cwd: config.project, env: codexEnv(config), shell: false, windowsHide: true,
      detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', stderrFd] });
  } catch (error) { for (const fd of [log, copy]) if (fd != null) fs.closeSync(fd); projection.close(); throw error; }
  let failure: any = null, finalized = false, stdoutBuffer = '', tailBuffer = '', skipping = false, metaFed = !resumeMeta, exitTimer: any = null, pipeTimer: any = null;
  const stdoutDecoder = new StringDecoder('utf8'), tailDecoder = new StringDecoder('utf8');
  const fail = error => { if (!failure) { failure = error; onFailure?.(error); } };
  const running = () => child.exitCode === null && child.signalCode === null;
  const processEvent = line => {
    if (!line.trim() || failure) return;
    let record; try { record = JSON.parse(line); } catch { projection.warn('Codex printed a non-JSON stdout line.'); return; }
    try { projection.ingestEvent(record); } catch (error) { fail(new Error('Codex event stream could not be read: ' + error.message)); }
    if (projection.terminal && !exitTimer && !finalized) {
      exitTimer = setTimeout(() => { if (!finalized && running()) onLingering?.(); }, exitGraceMs); exitTimer.unref?.();
    }
  };
  const feed = record => { try { projection.ingestRollout(record); }
    catch (error) { if (error.fatal) fail(new Error('Codex session could not be verified: ' + error.message)); else projection.warn(error.message); } };
  const consume = text => {
    tailBuffer += text; let start = 0, index;
    while ((index = tailBuffer.indexOf('\n', start)) >= 0) {
      const line = tailBuffer.slice(start, index); start = index + 1;
      if (skipping) { skipping = false; continue; }
      if (!line.trim() || failure) continue;
      let record; try { record = JSON.parse(line); } catch { projection.warn('Unreadable rollout line.'); continue; }
      feed(record);
    }
    tailBuffer = tailBuffer.slice(start);
    if (tailBuffer.length > 64_000_000) { tailBuffer = ''; skipping = true; projection.warn('Oversized rollout line skipped.'); }
  };
  const pump = () => {
    if (failure || !projection.sessionId) return;
    rollout ??= locate(config.codexHome, projection.sessionId);
    if (!rollout) return;
    if (!metaFed) { metaFed = true; feed(resumeMeta); }
    let fd; try { fd = fs.openSync(rollout, 'r'); } catch { return; }
    try {
      const chunk = Buffer.allocUnsafe(4 << 20);
      for (let total = 0; total < 64 << 20 && !failure;) {
        const read = fs.readSync(fd, chunk, 0, chunk.length, offset); if (!read) break;
        offset += read; total += read; fs.writeSync(copy, chunk, 0, read); consume(tailDecoder.write(chunk.subarray(0, read)));
      }
    } finally { fs.closeSync(fd); }
  };
  const timer = setInterval(() => { try { pump(); } catch (error) { projection.warn(error.message); } }, tailMs);
  child.stdin?.on('error', () => {});
  child.stdin?.end(prompt);
  child.stdout.on('data', chunk => {
    try {
      fs.writeSync(log, chunk); stdoutBuffer += stdoutDecoder.write(chunk);
      let index; while ((index = stdoutBuffer.indexOf('\n')) >= 0) { const line = stdoutBuffer.slice(0, index); stdoutBuffer = stdoutBuffer.slice(index + 1); processEvent(line); }
      if (stdoutBuffer.length > 16_000_000) { stdoutBuffer = ''; fail(new Error('Codex emitted an oversized stream event.')); }
    } catch (error) { fail(error); }
  });
  const flushStdout = () => { stdoutBuffer += stdoutDecoder.end(); if (stdoutBuffer.trim()) processEvent(stdoutBuffer); stdoutBuffer = ''; };
  child.stdout.on('end', flushStdout);
  child.stdout.on('error', fail);
  // 'close' waits for every holder of the pipe; after exit, give the output a short window and then stop waiting.
  child.once('exit', () => {
    pipeTimer = setTimeout(() => {
      if (finalized) return;
      onNotice?.('Codex exited, but a process it started still holds its output. The runner stopped waiting for it; that process was left running.');
      child.stdin?.destroy(); child.stdout?.destroy();
    }, pipeGraceMs); pipeTimer.unref?.();
  });
  return { child, finalize() {
    if (finalized) return; finalized = true; clearInterval(timer); clearTimeout(exitTimer); clearTimeout(pipeTimer);
    try { flushStdout(); } catch (error) { projection.warn(error.message); }
    try { pump(); tailBuffer += tailDecoder.end(); if (!skipping) consume('\n'); } catch (error) { projection.warn(error.message); }
    const result = projection.result({ failure, response: readBounded(path.join(config.runDir, 'last-message.txt')) });
    try { writeFileAtomic(path.join(config.runDir, 'result.json'), json(result) + '\n'); } finally { fs.closeSync(log); fs.closeSync(copy); projection.close(); }
  } };
}
