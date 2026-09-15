// Original ZCode projection, inspired by the event ledger in DeepSeek Harness.
// Keep the activity stream compact. Selected message/tool content uses event-content.mjs.
const label = (value, size = 100) => String(value ?? '').replace(/[\x00-\x1f]/g, '').slice(0, size);
const number = value => Number.isFinite(Number(value)) && value != null ? Number(value) : null;

export function readTrajectory(db, { sessionId, startedAt, limit = 2000 }) {
  const cap = Math.max(1, Math.min(2000, limit));
  const since = startedAt - 2000;
  const all = (sql, ...args) => db.prepare(sql).all(...args);
  const messages = all(`SELECT id,time_created,json_extract(data,'$.role') role,
    json_extract(data,'$.time.completed') ended,json_extract(data,'$.modelID') model
    FROM message WHERE session_id=? AND time_created>=? AND json_valid(data)
    ORDER BY time_created DESC,id DESC LIMIT ?`, sessionId, since, cap + 1);
  const parts = all(`SELECT id,message_id,time_created,time_updated,json_extract(data,'$.type') type,
    json_extract(data,'$.tool') tool,json_extract(data,'$.state.status') status,
    json_extract(data,'$.state.time.start') started,json_extract(data,'$.state.time.end') ended
    FROM part WHERE session_id=? AND time_created>=? AND json_valid(data)
    AND json_extract(data,'$.type') IN ('tool','compaction','retry')
    ORDER BY time_created DESC,id DESC LIMIT ?`, sessionId, since, cap + 1);
  const hasUsage = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='model_usage'").get();
  const requests = hasUsage ? all(`SELECT id,status,model_id,started_at,completed_at,
    input_tokens,output_tokens,cache_read_input_tokens,attempt_index
    FROM model_usage WHERE session_id=? AND started_at>=?
    ORDER BY started_at DESC,id DESC LIMIT ?`, sessionId, since, cap + 1) : [];
  const events = [];
  for (const row of messages) {
    if (!['user', 'assistant'].includes(row.role)) continue;
    // Usage records describe model requests more precisely than message timestamps.
    if (row.role === 'assistant' && requests.length) continue;
    events.push({ id: `message:${row.id}`, kind: row.role === 'user' ? 'input' : 'model',
      label: row.role === 'user' ? 'User instruction' : label(row.model || 'Assistant turn'),
      startedAt: row.time_created, endedAt: number(row.ended),
      status: row.role === 'user' ? 'recorded' : row.ended ? 'completed' : 'recorded', source: 'message', recordId: row.id });
  }
  for (const row of requests) events.push({ id: `request:${row.id}`, kind: 'model', label: label(row.model_id || 'Model request'),
    startedAt: row.started_at, endedAt: number(row.completed_at), status: label(row.status, 40),
    inputTokens: number(row.input_tokens), outputTokens: number(row.output_tokens), cacheReadTokens: number(row.cache_read_input_tokens),
    attempt: (number(row.attempt_index) ?? 0) + 1, source: 'model_usage', recordId: row.id });
  for (const row of parts) events.push({ id: `part:${row.id}`, kind: row.type === 'tool' ? 'tool' : 'context',
    label: row.type === 'tool' ? label(row.tool || 'Tool') : row.type === 'compaction' ? 'Context compacted' : 'Request retry',
    startedAt: number(row.started) ?? row.time_created, endedAt: number(row.ended),
    status: label(row.status || 'recorded', 40), source: 'part', recordId: row.id, messageId: row.message_id });
  events.sort((a, b) => a.startedAt - b.startedAt || a.id.localeCompare(b.id));
  const totalTurns = db.prepare(`SELECT COUNT(*) count FROM message WHERE session_id=? AND time_created>=?
    AND json_valid(data) AND json_extract(data,'$.role')='assistant'`).get(sessionId, since).count;
  const totalTools = db.prepare(`SELECT COUNT(*) count FROM part WHERE session_id=? AND time_created>=?
    AND json_valid(data) AND json_extract(data,'$.type')='tool'`).get(sessionId, since).count;
  return { events: events.slice(-cap), truncated: events.length > cap || messages.length > cap || parts.length > cap || requests.length > cap,
    turns: totalTurns, toolCalls: totalTools, timing: 'Recorded start and end times; open records have no final duration.' };
}
