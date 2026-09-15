import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';

const directory = value => { const resolved = path.resolve(value); return process.platform === 'win32' ? resolved.toLowerCase() : resolved; };
const displayText = value => String(value ?? '').replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '');

// Selected-event content is fetched on demand by the browser, never in telemetry or callbacks.
export function readEventContent(dbPath, { sessionId, project, startedAt, eventId, field = null, offset = 0, limit = 32768, workerLabel = 'ZCode' }) {
  if (typeof eventId !== 'string' || !/^(part|message|request):[A-Za-z0-9_.:-]{1,240}$/.test(eventId)) throw new Error('Invalid event ID.');
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > 100_000_000 || !Number.isSafeInteger(limit) || limit < 1 || limit > 65536) throw new Error('Invalid content page.');
  if (field != null && !['input', 'output', 'error', 'text'].includes(field)) throw new Error('Invalid content field.');
  if (!Number.isFinite(startedAt) || !sessionId || !project) throw new Error('The run session is not available yet.');
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    db.exec('PRAGMA query_only=ON; PRAGMA busy_timeout=500');
    const session = db.prepare('SELECT directory FROM session WHERE id=?').get(sessionId);
    if (!session || directory(session.directory) !== directory(project)) throw new Error('Session belongs to a different project.');
    const colon = eventId.indexOf(':'), source = eventId.slice(0, colon), id = eventId.slice(colon + 1), since = startedAt - 2000;
    const sections = [];
    let note = null, messageId = null, role = null;
    const add = (name, title, row, format = 'text') => {
      if (!row || !row.total) return;
      let text = String(row.text ?? '');
      if (format === 'json' && offset === 0 && row.total <= limit) { try { text = JSON.stringify(JSON.parse(text), null, 2); } catch {} }
      sections.push({ field: name, title, text: displayText(text), offset, totalChars: row.total,
        nextOffset: offset + limit < row.total ? offset + limit : null });
    };
    if (source === 'part') {
      const part = db.prepare(`SELECT json_extract(data,'$.type') type FROM part
        WHERE id=? AND session_id=? AND time_created>=? AND json_valid(data)`).get(id, sessionId, since);
      if (!part) throw new Error('Event is outside this run or no longer available.');
      if (part.type === 'tool') {
        for (const [name, title] of [['input', 'Tool input'], ['output', 'Tool result'], ['error', 'Tool error']]) {
          if (field && field !== name) continue;
          const row = db.prepare(`SELECT substr(value,?,?) text,length(value) total FROM
            (SELECT CAST(json_extract(data,?) AS TEXT) value FROM part WHERE id=? AND session_id=? AND json_valid(data))`)
            .get(offset + 1, limit, '$.state.' + name, id, sessionId);
          add(name, title, row, name === 'input' ? 'json' : 'text');
        }
        if (!sections.length) note = 'No tool content has been recorded for this event yet.';
      } else note = 'This event has no displayable message or tool content.';
    } else {
      if (source === 'request') {
        const columns = db.prepare('PRAGMA table_info(model_usage)').all();
        const linked = columns.some(x => x.name === 'assistant_message_id');
        const request = db.prepare(`SELECT ${linked ? 'assistant_message_id' : 'NULL'} messageId FROM model_usage
          WHERE id=? AND session_id=? AND started_at>=?`).get(id, sessionId, since);
        if (!request) throw new Error('Event is outside this run or no longer available.');
        messageId = request.messageId;
        if (!messageId) note = `${workerLabel === 'AGY' ? 'AGY' : 'ZCode'} did not record a message link for this model request.`;
      } else messageId = id;
      if (messageId) {
        const message = db.prepare(`SELECT json_extract(data,'$.role') role FROM message
          WHERE id=? AND session_id=? AND time_created>=? AND json_valid(data)`).get(messageId, sessionId, since);
        if (!message || !['user', 'assistant'].includes(message.role)) throw new Error('Message is outside this run or no longer available.');
        role = message.role;
        if (!field || field === 'text') {
          const row = db.prepare(`SELECT substr(value,?,?) text,length(value) total FROM
            (SELECT group_concat(text, char(10)||char(10)) value FROM
              (SELECT json_extract(data,'$.text') text FROM part WHERE message_id=? AND session_id=? AND time_created>=?
                AND json_valid(data) AND json_extract(data,'$.type')='text' ORDER BY time_created,id))`)
            .get(offset + 1, limit, messageId, sessionId, since);
          add('text', role === 'user' ? 'User instruction' : `${workerLabel === 'AGY' ? 'AGY' : 'ZCode'} response`, row);
        }
        if (!sections.length) {
          const count = db.prepare(`SELECT count(*) count FROM part WHERE message_id=? AND session_id=? AND time_created>=?
            AND json_valid(data) AND json_extract(data,'$.type')='tool'`).get(messageId, sessionId, since).count;
          note = count ? 'This response contains tool calls. Select a Tool event to read its input and result.' : 'No reply text has been recorded for this event yet.';
        }
      }
    }
    return { eventId, messageId, role, sections, note };
  } finally { db.close(); }
}
