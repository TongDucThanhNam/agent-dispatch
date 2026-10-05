// Patterns first seen in a real Codex run: the compaction recorded a request after the prompt shrank, tool outputs
// cut by the harness, and a run bound by how fast the model writes rather than by its context.
import { expect, test } from 'bun:test';
import { DatabaseSync } from 'node:sqlite';
import { readTrajectory } from '../src/monitor/trajectory.ts';
import { computeInsights } from '../web/src/lib/insights.ts';
import type { Run, TrajectoryEvent } from '../web/src/lib/types.ts';

const at = (i: number) => 1_000_000 + i * 20_000;
const request = (i: number, input: number, extra: Partial<TrajectoryEvent> = {}): TrajectoryEvent => ({
  id: `r${i}`, kind: 'model', label: 'model', status: 'completed', startedAt: at(i), endedAt: at(i) + 10_000, request: i,
  inputTokens: input, cacheReadTokens: Math.round(input * 0.9), outputTokens: 250, reasoningTokens: 100, ttftMs: 1000, ...extra,
});
const compaction = (i: number): TrajectoryEvent => ({ id: `c${i}`, kind: 'compaction', label: 'Context compacted', status: 'completed', startedAt: at(i) + 15_000 });
const runOf = (events: TrajectoryEvent[]) => ({ startedAt: at(0), endedAt: at(events.length + 1), active: false, trajectory: { events, stats: {} } }) as unknown as Run;
const boundaries = (events: TrajectoryEvent[]) => computeInsights(runOf(events), null, at(99)).context.filter(p => p.compactedBefore).map(p => p.id);

test('a compaction starts at the request whose prompt shrank, even when it is recorded a request later', () => {
  // Codex: the new context starts at r4, and the compaction record lands after r4.
  const late = [request(1, 100_000), request(2, 200_000), request(3, 250_000), request(4, 12_000), compaction(4), request(5, 16_000), request(6, 20_000)];
  expect(boundaries(late)).toEqual(['r4']);
  const insights = computeInsights(runOf(late), null, at(99));
  expect(insights.carry?.atCompaction?.request).toBe(3);
  expect(insights.mix?.pruned).toBe(0);
  // Recorded before the shrinking request, as other workers do: the same single boundary.
  expect(boundaries([request(1, 100_000), request(2, 200_000), compaction(2), request(3, 12_000), request(4, 16_000)])).toEqual(['r3']);
  // Recorded early, ahead of a request that did not shrink yet: the boundary moves to the drop.
  expect(boundaries([request(1, 100_000), compaction(1), request(2, 200_000), request(3, 12_000), request(4, 16_000)])).toEqual(['r3']);
  // A large drop with no record (a harness reset) still starts a new context.
  expect(boundaries([request(1, 100_000), request(2, 200_000), request(3, 40_000), request(4, 44_000)])).toEqual(['r3']);
});

test('the projection reports how large a cut tool output was, never the output itself', () => {
  const db = new DatabaseSync(':memory:'), sid = 'session-1', start = at(0);
  db.exec(`CREATE TABLE session(id TEXT,directory TEXT,parent_id TEXT,time_created INTEGER,time_updated INTEGER);
    CREATE TABLE message(id TEXT,session_id TEXT,time_created INTEGER,time_updated INTEGER,data TEXT);
    CREATE TABLE part(id TEXT,message_id TEXT,session_id TEXT,time_created INTEGER,time_updated INTEGER,data TEXT);
    CREATE TABLE model_usage(id TEXT,status TEXT,model_id TEXT,started_at INTEGER,completed_at INTEGER,input_tokens INTEGER,output_tokens INTEGER,
      cache_read_input_tokens INTEGER,attempt_index INTEGER,retry_count INTEGER,error_code TEXT,session_id TEXT);`);
  db.prepare('INSERT INTO model_usage VALUES(?,?,?,?,?,?,?,?,?,?,?,?)').run('req-1', 'completed', 'model', start, start + 1000, 1000, 50, 0, 0, 0, null, sid);
  const tool = (id: string, output: string) => db.prepare('INSERT INTO part VALUES(?,?,?,?,?,?)').run(id, 'req-1', sid, start + 2000, start + 3000,
    JSON.stringify({ type: 'tool', tool: 'Shell', state: { status: 'completed', output, time: { start: start + 2000, end: start + 3000 } } }));
  // Script-level cut, then a command inside it cut from a far larger output.
  tool('cut', 'Script completed\nOutput:\n\nWarning: truncated output (original token count: 32615)\n{"output":"PRIVATE_LINE Warning: truncated output (original token count: 279131)"}');
  tool('whole', 'Script completed\nOutput:\nPRIVATE_LINE all of it');
  const trajectory = readTrajectory(db, { sessionId: sid, startedAt: start });
  const byId = Object.fromEntries(trajectory.events.map(e => [e.id, e]));
  expect(byId['part:cut'].truncatedFrom).toBe(279_131);
  expect('truncatedFrom' in byId['part:whole']).toBe(false);
  expect(JSON.stringify(trajectory)).not.toContain('PRIVATE_LINE');
});

test('insights name cut tool outputs and a run bound by how fast the model writes', () => {
  // Twelve requests decoding 225 tokens in 9 seconds each (25 tokens/s), 90 of them reasoning, with no tool time between.
  const events: TrajectoryEvent[] = [];
  for (let i = 1; i <= 12; i++) {
    events.push({ ...request(i, 10_000 + i * 1000, { outputTokens: 225, reasoningTokens: 90 }), startedAt: at(0) + (i - 1) * 10_000, endedAt: at(0) + i * 10_000 });
  }
  events.push({ id: 't1', kind: 'tool', label: 'Shell', status: 'completed', startedAt: at(0) + 125_000, endedAt: at(0) + 126_000, truncatedFrom: 32_615 },
    { id: 't2', kind: 'tool', label: 'Shell', status: 'completed', startedAt: at(0) + 127_000, endedAt: at(0) + 128_000, truncatedFrom: 1_433_929 });
  const run = { startedAt: at(0), endedAt: at(0) + 130_000, active: false, trajectory: { events, stats: {} } } as unknown as Run;
  const findings = computeInsights(run, null, at(99)).findings;
  const decode = findings.find(f => f.key === 'decode')!;
  expect(decode.title).toBe('Writing output took 83% of the run, at 25 tokens/s');
  expect(decode.detail).toContain('1.1K reasoning (~43.2s) and 1.6K replies and tool-call arguments (~1m 4s)');
  expect(decode.detail).toContain('every 1,000 output tokens cost 40.0s');
  const cut = findings.find(f => f.key === 'truncated-output')!;
  expect(cut.title).toBe('2 tool outputs cut short by the harness');
  expect(cut.detail).toContain('1.5M tokens in total (the largest 1.4M)');
  expect(cut.ids).toEqual(['t1', 't2']);
});
