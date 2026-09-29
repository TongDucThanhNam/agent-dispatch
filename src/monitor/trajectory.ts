// Original ZCode projection, inspired by the event ledger in DeepSeek Harness.
// Keep the activity stream compact and content-free: labels, timing, usage and structure only.
// Selected message/tool content and row previews are fetched on demand through event-content.mjs.
const label = (value, size = 100) => String(value ?? '').replace(/[\x00-\x1f]/g, '').slice(0, size);
const number = value => Number.isFinite(Number(value)) && value != null ? Number(value) : null;
const flag = value => value === 1 || value === true || value === '1' || value === 'true';
const query = (db, sql) => typeof db.query === 'function' ? db.query(sql) : db.prepare(sql);
const columnsOf = (db, table) => new Set(query(db, `PRAGMA table_info(${table})`).all().map(x => x.name));
// Older schemas (and the AGY projection) omit newer columns; select NULL in their place.
const pick = (columns, name) => columns.has(name) ? name : `NULL ${name}`;
// ZCode marks runtime-injected user-role messages (reminders, notifications, summaries) as synthetic or non-user origin.
const injectedLabel = kind => { const text = label(kind, 60).replaceAll('_', ' ').trim(); return text ? text[0].toUpperCase() + text.slice(1) : 'Injected context'; };

export function readTrajectory(db, { sessionId, startedAt, limit = 2000 }) {
  const cap = Math.max(1, Math.min(2000, limit));
  const since = startedAt - 2000;
  const all = (sql, ...args) => query(db, sql).all(...args);
  const tables = new Set(all("SELECT name FROM sqlite_master WHERE type='table'").map(x => x.name));
  const messages = all(`SELECT id,time_created,json_extract(data,'$.role') role,
    json_extract(data,'$.time.completed') ended,json_extract(data,'$.modelID') model,
    json_extract(data,'$.semantics.kind') semantic,json_extract(data,'$.semantics.origin') semantic_origin,json_extract(data,'$.synthetic') synthetic,
    json_extract(data,'$.source') origin,json_extract(data,'$.anchor.turnId') turn_id
    FROM message WHERE session_id=? AND time_created>=? AND json_valid(data)
    ORDER BY time_created DESC,id DESC LIMIT ?`, sessionId, since, cap + 1);
  const parts = all(`SELECT id,message_id,time_created,time_updated,json_extract(data,'$.type') type,
    json_extract(data,'$.tool') tool,json_extract(data,'$.state.status') status,
    json_extract(data,'$.state.time.start') started,json_extract(data,'$.state.time.end') ended,
    json_extract(data,'$.state.error') IS NOT NULL has_error,
    json_extract(data,'$.time.start') part_started,json_extract(data,'$.time.end') part_ended,
    coalesce(json_extract(data,'$.compactReason'),json_extract(data,'$.trigger')) reason,
    json_extract(data,'$.preCompactTokenCount') pre_tokens,
    coalesce(json_extract(data,'$.truePostCompactTokenCount'),json_extract(data,'$.postCompactTokenCount')) post_tokens,
    json_extract(data,'$.attempt') attempt
    FROM part WHERE session_id=? AND time_created>=? AND json_valid(data)
    AND json_extract(data,'$.type') IN ('tool','compaction','retry','checkpoint')
    ORDER BY time_created DESC,id DESC LIMIT ?`, sessionId, since, cap + 1);
  const usageColumns = tables.has('model_usage') ? columnsOf(db, 'model_usage') : new Set<any>();
  const requests = tables.has('model_usage') ? all(`SELECT id,status,model_id,started_at,completed_at,
    input_tokens,output_tokens,cache_read_input_tokens,attempt_index,
    ${['first_token_at', 'time_to_first_token_ms', 'duration_ms', 'reasoning_tokens', 'cache_creation_input_tokens', 'finish_reason',
      'tool_call_count', 'turn_id', 'query_source', 'retry_count', 'error_type', 'error_code', 'assistant_message_id', 'variant'].map(x => pick(usageColumns, x)).join(',')}
    FROM model_usage WHERE session_id=? AND started_at>=?
    ORDER BY started_at DESC,id DESC LIMIT ?`, sessionId, since, cap + 1) : [];
  const events: any[] = [];
  for (const row of messages) {
    if (!['user', 'assistant'].includes(row.role)) continue;
    // Usage records describe model requests more precisely than message timestamps.
    if (row.role === 'assistant' && requests.length) continue;
    const injected = row.role === 'user' && (flag(row.synthetic) || (row.semantic_origin != null && row.semantic_origin !== 'real_user'));
    events.push({ id: `message:${row.id}`, kind: row.role === 'user' ? injected ? 'context' : 'input' : 'model',
      label: row.role === 'assistant' ? label(row.model || 'Assistant turn') : !injected ? 'User instruction'
        : injectedLabel(row.semantic || row.origin),
      startedAt: row.time_created, endedAt: number(row.ended), turnKey: row.turn_id ?? null,
      status: row.role === 'user' ? 'recorded' : row.ended ? 'completed' : 'recorded', source: 'message', recordId: row.id,
      ...(injected && row.origin ? { origin: label(row.origin, 40) } : {}) });
  }
  for (const row of requests) {
    const started = row.started_at, ended = number(row.completed_at), firstToken = number(row.first_token_at);
    const ttft = number(row.time_to_first_token_ms) ?? (firstToken != null ? firstToken - started : null);
    events.push({ id: `request:${row.id}`, kind: 'model', label: label(row.model_id || 'Model request'),
      startedAt: started, endedAt: ended, status: label(row.status, 40),
      inputTokens: number(row.input_tokens), outputTokens: number(row.output_tokens), cacheReadTokens: number(row.cache_read_input_tokens),
      cacheWriteTokens: number(row.cache_creation_input_tokens), reasoningTokens: number(row.reasoning_tokens),
      ttftMs: ttft != null && ttft >= 0 ? ttft : null, durationMs: number(row.duration_ms) ?? (ended != null ? ended - started : null),
      finishReason: row.finish_reason ? label(row.finish_reason, 40) : null, toolCallCount: number(row.tool_call_count),
      querySource: row.query_source ? label(row.query_source, 40) : null, variant: row.variant ? label(row.variant, 30) : null,
      retries: number(row.retry_count), error: row.error_code || row.error_type ? label(row.error_code || row.error_type, 60) : null,
      attempt: (number(row.attempt_index) ?? 0) + 1, turnKey: row.turn_id ?? null, messageId: row.assistant_message_id ?? null,
      source: 'model_usage', recordId: row.id });
  }
  for (const row of parts) {
    const kind = row.type === 'tool' ? 'tool' : row.type === 'retry' ? 'retry' : 'compaction';
    const event: any = { id: `part:${row.id}`, kind,
      label: row.type === 'tool' ? label(row.tool || 'Tool') : row.type === 'compaction' ? 'Context compacted' : row.type === 'checkpoint' ? 'Checkpoint' : 'Request retry',
      startedAt: number(row.started) ?? number(row.part_started) ?? row.time_created, endedAt: number(row.ended) ?? number(row.part_ended),
      status: label(row.status || (row.part_ended ? 'completed' : 'recorded'), 40), source: 'part', recordId: row.id, messageId: row.message_id };
    if (row.type === 'tool' && (flag(row.has_error) || row.status === 'error')) event.isError = true;
    if (kind === 'compaction') Object.assign(event, { reason: row.reason ? label(row.reason, 40) : null,
      preTokens: number(row.pre_tokens), postTokens: number(row.post_tokens) });
    if (row.type === 'retry') event.attempt = number(row.attempt);
    events.push(event);
  }
  events.sort((a, b) => a.startedAt - b.startedAt || a.id.localeCompare(b.id));
  const trimmed = events.slice(-cap);
  annotate(trimmed);
  const count = (sql, ...args) => db.prepare(sql).get(...args).count ?? 0;
  const turnsByUsage = usageColumns.has('turn_id') ? count(`SELECT COUNT(DISTINCT turn_id) count FROM model_usage
    WHERE session_id=? AND started_at>=? AND turn_id IS NOT NULL`, sessionId, since) : 0;
  const userTurns = count(`SELECT COUNT(*) count FROM message WHERE session_id=? AND time_created>=? AND json_valid(data)
    AND json_extract(data,'$.role')='user' AND coalesce(json_extract(data,'$.synthetic'),0) IN (0,'false')
    AND coalesce(json_extract(data,'$.semantics.origin'),'real_user')='real_user'`, sessionId, since);
  const assistantMessages = count(`SELECT COUNT(*) count FROM message WHERE session_id=? AND time_created>=?
    AND json_valid(data) AND json_extract(data,'$.role')='assistant'`, sessionId, since);
  const totalTools = count(`SELECT COUNT(*) count FROM part WHERE session_id=? AND time_created>=?
    AND json_valid(data) AND json_extract(data,'$.type')='tool'`, sessionId, since);
  const stats = readStats(db, { sessionId, since, tables, usageColumns });
  return { events: trimmed, truncated: events.length > cap || messages.length > cap || parts.length > cap || requests.length > cap,
    turns: turnsByUsage || userTurns || (assistantMessages ? 1 : 0), requests: stats.requests ?? assistantMessages, toolCalls: totalTools, stats,
    timing: 'Recorded start and end times; open records have no final duration.' };
}

// Turn/step/request numbering in the DeepSeek Harness style. Turns follow the recorded turn ID when
// present, otherwise each real user instruction opens a turn. Tools inherit the step of their request.
function annotate(events) {
  const turnOf = new Map<any, any>(), stepOfMessage = new Map<any, any>();
  let turn = 0, step = 0, request = 0, current;
  const enter = key => {
    if (key && turnOf.has(key)) { if (key !== current) { turn = turnOf.get(key); current = key; } return; }
    turn++; step = 0; current = key; if (key) turnOf.set(key, turn);
  };
  for (const event of events) {
    if (event.kind === 'input') { enter(event.turnKey); event.opensTurn = true; }
    else if (event.kind === 'model') {
      if (event.turnKey && event.turnKey !== current) enter(event.turnKey);
      if (!turn) enter(null);
      event.step = ++step; event.request = ++request;
      if (event.messageId) stepOfMessage.set(event.messageId, step);
    } else if (event.kind === 'tool') event.step = stepOfMessage.get(event.messageId) ?? (step || null);
    event.turn = turn || null;
    delete event.turnKey;
  }
}

// Whole-run aggregates (not limited to the newest 2000 records), in the spirit of dsh-session-stats.
function readStats(db, { sessionId, since, tables, usageColumns }) {
  const stats: any = {};
  if (tables.has('model_usage')) {
    const has = name => usageColumns.has(name);
    const row = query(db, `SELECT COUNT(*) requests,SUM(input_tokens) input,SUM(output_tokens) output,SUM(cache_read_input_tokens) cache_read,
      ${has('cache_creation_input_tokens') ? 'SUM(cache_creation_input_tokens)' : 'NULL'} cache_write,
      ${has('reasoning_tokens') ? 'SUM(reasoning_tokens)' : 'NULL'} reasoning,
      ${has('time_to_first_token_ms') ? 'AVG(time_to_first_token_ms)' : has('first_token_at') ? 'AVG(first_token_at-started_at)' : 'NULL'} ttft,
      ${has('duration_ms') ? 'SUM(coalesce(duration_ms,completed_at-started_at))' : 'SUM(completed_at-started_at)'} model_ms,
      ${has('first_token_at') ? 'SUM(CASE WHEN completed_at>first_token_at THEN completed_at-first_token_at END)' : 'NULL'} decode_ms,
      ${has('first_token_at') ? 'SUM(CASE WHEN completed_at>first_token_at THEN output_tokens END)' : 'NULL'} decode_tokens,
      SUM(CASE WHEN status='error' OR error_code IS NOT NULL THEN 1 ELSE 0 END) errors,SUM(retry_count) retries,MAX(input_tokens) peak_input,
      SUM(CASE WHEN cache_read_input_tokens>input_tokens THEN input_tokens+cache_read_input_tokens ELSE input_tokens END) prompt_total
      FROM model_usage WHERE session_id=? AND started_at>=?`).get(sessionId, since);
    Object.assign(stats, { requests: row.requests, inputTokens: number(row.input), outputTokens: number(row.output),
      cacheReadTokens: number(row.cache_read), cacheWriteTokens: number(row.cache_write), reasoningTokens: number(row.reasoning),
      avgTtftMs: row.ttft == null ? null : Math.round(row.ttft), modelMs: number(row.model_ms), peakInputTokens: number(row.peak_input),
      decodeTokensPerSecond: row.decode_ms > 0 && row.decode_tokens ? Math.round(row.decode_tokens / row.decode_ms * 10000) / 10 : null,
      requestErrors: row.errors ?? 0, retries: row.retries ?? 0,
      // ZCode counts cached tokens inside input_tokens; AGY/Gemini reports them separately. Both give a 0-100% hit rate.
      cacheHitRate: row.prompt_total > 0 && row.cache_read != null ? Math.round(row.cache_read / row.prompt_total * 1000) / 10 : null });
    if (has('finish_reason')) stats.finishReasons = Object.fromEntries(query(db, `SELECT finish_reason reason,COUNT(*) count FROM model_usage
      WHERE session_id=? AND started_at>=? AND finish_reason IS NOT NULL GROUP BY finish_reason ORDER BY count DESC LIMIT 8`)
      .all(sessionId, since).map(x => [label(x.reason, 40), x.count]));
  }
  stats.tools = query(db, `SELECT json_extract(data,'$.tool') name,COUNT(*) calls,
    SUM(CASE WHEN json_extract(data,'$.state.status')='error' OR json_extract(data,'$.state.error') IS NOT NULL THEN 1 ELSE 0 END) errors,
    SUM(CASE WHEN json_extract(data,'$.state.time.end')>=json_extract(data,'$.state.time.start')
      THEN json_extract(data,'$.state.time.end')-json_extract(data,'$.state.time.start') END) ms
    FROM part WHERE session_id=? AND time_created>=? AND json_valid(data) AND json_extract(data,'$.type')='tool'
    GROUP BY name ORDER BY calls DESC LIMIT 30`).all(sessionId, since)
    .map(x => ({ name: label(x.name || 'Tool', 60), calls: x.calls, errors: x.errors ?? 0, ms: number(x.ms) }));
  const counts = query(db, `SELECT SUM(CASE WHEN json_extract(data,'$.type') IN ('compaction','checkpoint') THEN 1 ELSE 0 END) compactions,
    SUM(CASE WHEN json_extract(data,'$.type')='retry' THEN 1 ELSE 0 END) retries
    FROM part WHERE session_id=? AND time_created>=? AND json_valid(data)`).get(sessionId, since);
  stats.compactions = counts.compactions ?? 0; stats.retryParts = counts.retries ?? 0;
  stats.toolErrors = stats.tools.reduce((n, x) => n + x.errors, 0);
  if (tables.has('session')) stats.subagents = query(db, 'SELECT COUNT(*) count FROM session WHERE parent_id=?').get(sessionId).count;
  return stats;
}
