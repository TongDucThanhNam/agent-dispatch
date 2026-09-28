import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { clean } from './monitor-core.ts';

const directory = value => { const resolved = path.resolve(value); return process.platform === 'win32' ? resolved.toLowerCase() : resolved; };
const displayText = value => String(value ?? '').replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '');
const EVENT_ID = /^(part|message|request):[A-Za-z0-9_.:-]{1,240}$/;
const FIELDS = ['input', 'output', 'error', 'text', 'reasoning'];
const label = workerLabel => ['AGY', 'Codex'].includes(workerLabel) ? workerLabel : 'ZCode';

function openSession(dbPath, { sessionId, project, startedAt }) {
  if (!Number.isFinite(startedAt) || !sessionId || !project) throw new Error('The run session is not available yet.');
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    db.exec('PRAGMA query_only=ON; PRAGMA busy_timeout=500');
    const session = db.prepare('SELECT directory FROM session WHERE id=?').get(sessionId);
    if (!session || directory(session.directory) !== directory(project)) throw new Error('Session belongs to a different project.');
    const usage = new Set(db.prepare("SELECT name FROM pragma_table_info('model_usage')").all().map(x => x.name));
    return { db, since: startedAt - 2000, linked: usage.has('assistant_message_id'), hasUsage: usage.size > 0 };
  } catch (error) { db.close(); throw error; }
}

// Selected-event content is fetched on demand by the browser, never in telemetry or callbacks.
export function readEventContent(dbPath, { sessionId, project, startedAt, eventId, field = null, offset = 0, limit = 32768, workerLabel = 'ZCode' }) {
  if (typeof eventId !== 'string' || !EVENT_ID.test(eventId)) throw new Error('Invalid event ID.');
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > 100_000_000 || !Number.isSafeInteger(limit) || limit < 1 || limit > 65536) throw new Error('Invalid content page.');
  if (field != null && !FIELDS.includes(field)) throw new Error('Invalid content field.');
  const { db, since, linked } = openSession(dbPath, { sessionId, project, startedAt });
  try {
    const colon = eventId.indexOf(':'), source = eventId.slice(0, colon), id = eventId.slice(colon + 1);
    const sections: any[] = [];
    let note: any = null, messageId: any = null, role: any = null;
    const add = (name, title, row, format = 'text') => {
      if (!row || !row.total) return;
      let text = String(row.text ?? '');
      if (format === 'json' && offset === 0 && row.total <= limit) { try { text = JSON.stringify(JSON.parse(text), null, 2); } catch {} }
      sections.push({ field: name, title, text: displayText(text), offset, totalChars: row.total,
        nextOffset: offset + limit < row.total ? offset + limit : null });
    };
    // Joined text of one part type in one message, paged by character offset.
    const joined = (type, message) => db.prepare(`SELECT substr(value,?,?) text,length(value) total FROM
      (SELECT group_concat(text, char(10)||char(10)) value FROM
        (SELECT json_extract(data,'$.text') text FROM part WHERE message_id=? AND session_id=? AND json_valid(data)
          AND json_extract(data,'$.type')=? ORDER BY time_created,id))`).get(offset + 1, limit, message, sessionId, type);
    if (source === 'part') {
      const part = db.prepare(`SELECT json_extract(data,'$.type') type,json_extract(data,'$.summaryMessageId') summary FROM part
        WHERE id=? AND session_id=? AND time_created>=? AND json_valid(data)`).get(id, sessionId, since);
      if (!part) throw new Error('Event is outside this run or no longer available.');
      if (part.type === 'tool') {
        for (const [name, title] of [['input', 'Tool input'], ['output', 'Tool result'], ['error', 'Tool error']]) {
          if (field && field !== name) continue;
          const row = db.prepare(`SELECT substr(value,?,?) text,length(value) total FROM
            (SELECT CAST(json_extract(data,?) AS TEXT) value FROM part WHERE id=? AND session_id=? AND json_valid(data))`)
            .get(offset + 1, limit, '$.state.' + name, id, sessionId);
          add(name, title, row, name === 'input' || name === 'error' ? 'json' : 'text');
        }
        if (!sections.length) note = 'No tool content has been recorded for this event yet.';
      } else if (part.type === 'compaction' && part.summary) {
        // The summary message replaces the compacted history; show what the model continues from.
        const summary = db.prepare('SELECT id FROM message WHERE id=? AND session_id=?').get(part.summary, sessionId);
        if (summary && (!field || field === 'text')) add('text', 'Compaction summary', joined('text', summary.id));
        if (!sections.length) note = 'The compaction summary is not available in the local session.';
      } else note = 'This event has no displayable message or tool content.';
    } else {
      if (source === 'request') {
        const request = db.prepare(`SELECT ${linked ? 'assistant_message_id' : 'NULL'} messageId FROM model_usage
          WHERE id=? AND session_id=? AND started_at>=?`).get(id, sessionId, since);
        if (!request) throw new Error('Event is outside this run or no longer available.');
        messageId = request.messageId;
        if (!messageId) note = `${label(workerLabel)} did not record a message link for this model request.`;
      } else messageId = id;
      if (messageId) {
        const message = db.prepare(`SELECT json_extract(data,'$.role') role,json_extract(data,'$.synthetic') synthetic,
          json_extract(data,'$.semantics.origin') origin FROM message
          WHERE id=? AND session_id=? AND time_created>=? AND json_valid(data)`).get(messageId, sessionId, since);
        if (!message || !['user', 'assistant'].includes(message.role)) throw new Error('Message is outside this run or no longer available.');
        role = message.role;
        const injected = role === 'user' && (message.synthetic === 1 || message.synthetic === true || (message.origin && message.origin !== 'real_user'));
        if (role === 'assistant' && (!field || field === 'reasoning')) add('reasoning', 'Thinking', joined('reasoning', messageId));
        if (!field || field === 'text') add('text', role === 'user' ? injected ? 'Injected context' : 'User instruction' : `${label(workerLabel)} response`, joined('text', messageId));
        if (!sections.some(x => x.field === 'text')) {
          const tools = db.prepare(`SELECT json_extract(data,'$.tool') tool FROM part WHERE message_id=? AND session_id=?
            AND json_valid(data) AND json_extract(data,'$.type')='tool' ORDER BY time_created,id LIMIT 12`).all(messageId, sessionId).map(x => x.tool);
          if (!field) note = tools.length ? `This response contains tool calls (${tools.join(', ')}). Select a Tool event to read its input and result.`
            : sections.length ? null : 'No reply text has been recorded for this event yet.';
        }
      }
    }
    return { eventId, messageId, role, sections, note };
  } finally { db.close(); }
}

const oneLine = (value, size) => clean(displayText(value).replace(/\s+/g, ' ').trim(), size);
const INPUT_KEYS = ['command', 'CommandLine', 'cmd', 'file_path', 'filePath', 'AbsolutePath', 'TargetFile', 'path', 'pattern', 'Query',
  'query', 'url', 'Url', 'description', 'subject', 'prompt', 'skill', 'name'];
function inputSummary(raw) {
  let value; try { value = JSON.parse(raw); } catch { return oneLine(raw, 160); }
  if (value == null || typeof value !== 'object') return oneLine(value, 160);
  if (Array.isArray(value.todos)) return `${value.todos.length} todos · ` + oneLine(value.todos.find(x => x?.status === 'in_progress')?.content ?? '', 120);
  const key = INPUT_KEYS.find(x => typeof value[x] === 'string' && value[x].trim());
  return oneLine(key ? value[key] : JSON.stringify(value), 160);
}
const firstLine = value => oneLine(String(value ?? '').split(/\r?\n/).find(x => x.trim()) ?? '', 120);

// Short, redacted one-line previews for visible ledger rows (DSH-style summaries). On demand only.
export function readEventPreviews(dbPath, { sessionId, project, startedAt, ids }) {
  if (!Array.isArray(ids) || ids.length > 200 || ids.some(x => typeof x !== 'string' || !EVENT_ID.test(x))) throw new Error('Invalid event IDs.');
  const { db, since, linked, hasUsage } = openSession(dbPath, { sessionId, project, startedAt });
  try {
    const previews: any = {};
    const tool = db.prepare(`SELECT json_extract(data,'$.type') type,CAST(json_extract(data,'$.state.input') AS TEXT) input,
      substr(CAST(json_extract(data,'$.state.output') AS TEXT),1,600) output,substr(CAST(json_extract(data,'$.state.error') AS TEXT),1,400) error,
      json_extract(data,'$.summaryMessageId') summary,json_extract(data,'$.preCompactTokenCount') pre
      FROM part WHERE id=? AND session_id=? AND time_created>=? AND json_valid(data)`);
    const firstOf = db.prepare(`SELECT substr(json_extract(data,'$.text'),1,400) text FROM part WHERE message_id=? AND session_id=?
      AND json_valid(data) AND json_extract(data,'$.type')=? AND length(trim(json_extract(data,'$.text')))>0 ORDER BY time_created,id LIMIT 1`);
    const toolsOf = db.prepare(`SELECT json_extract(data,'$.tool') tool FROM part WHERE message_id=? AND session_id=?
      AND json_valid(data) AND json_extract(data,'$.type')='tool' ORDER BY time_created,id LIMIT 6`);
    const request = hasUsage && linked ? db.prepare('SELECT assistant_message_id id FROM model_usage WHERE id=? AND session_id=? AND started_at>=?') : null;
    const message = db.prepare('SELECT id FROM message WHERE id=? AND session_id=? AND time_created>=?');
    for (const eventId of ids) {
      const colon = eventId.indexOf(':'), source = eventId.slice(0, colon), id = eventId.slice(colon + 1);
      if (source === 'part') {
        const row = tool.get(id, sessionId, since); if (!row) continue;
        if (row.type === 'tool') previews[eventId] = { text: row.input ? inputSummary(row.input) : '', result: row.error ? firstLine(row.error) : firstLine(row.output) };
        else if (row.type === 'compaction' && row.summary) previews[eventId] = { text: oneLine(firstOf.get(row.summary, sessionId, 'text')?.text, 160) };
        continue;
      }
      const messageId = source === 'request' ? request?.get(id, sessionId, since)?.id : message.get(id, sessionId, since)?.id;
      if (!messageId) continue;
      const text = firstOf.get(messageId, sessionId, 'text')?.text;
      const reasoning = text ? null : firstOf.get(messageId, sessionId, 'reasoning')?.text;
      const calls = toolsOf.all(messageId, sessionId).map(x => x.tool).filter(Boolean);
      previews[eventId] = { text: text ? oneLine(text, 160) : reasoning ? 'Thinking: ' + oneLine(reasoning, 150) : '',
        ...(calls.length ? { result: '→ ' + calls.join(', ') } : {}) };
    }
    return { previews };
  } finally { db.close(); }
}