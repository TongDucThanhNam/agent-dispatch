import type { Run, TrajectoryEvent, Preview } from '../web/src/lib/types.ts';

export function insightFixture() {
  const events: TrajectoryEvent[] = [], previews = new Map<string, Preview>();
  for (let i = 0; i < 8; i++) {
    const at = 1_000_000 + i * 300_000;
    events.push({ id: `request:r${i}`, kind: 'model', label: 'model', status: 'completed', request: i + 1, startedAt: at, endedAt: at + 150_000,
      inputTokens: 20_000 + i * 20_000, cacheReadTokens: i === 4 ? 0 : 10_000 + i * 19_000, outputTokens: 3000, reasoningTokens: 2000,
      ttftMs: 50_000, finishReason: i === 2 ? 'max_tokens' : 'tool_use' });
    events.push({ id: `part:t${i}`, kind: 'tool', label: i < 3 ? 'apply_patch' : 'Bash', status: i < 3 ? 'error' : 'completed',
      startedAt: at + 155_000, endedAt: at + 285_000, truncatedFrom: i === 6 ? 80_000 : null });
    previews.set(`part:t${i}`, { text: i < 3 ? 'src/a.ts' : 'cat src/a.ts', result: i < 3 ? 'apply_patch verification failed: missing line' : 'output' });
  }
  events.push({ id: 'part:c', kind: 'compaction', label: 'Context compacted', startedAt: 3_400_000, endedAt: 3_410_000 });
  const run = { startedAt: 1_000_000, endedAt: 3_420_000, active: false, trajectory: { events, truncated: true,
    stats: { requests: 8, retries: 3, requestErrors: 1, tools: [{ name: 'apply_patch', calls: 3, errors: 3, ms: 390_000 }] } } } as Run;
  return { run, previews, now: 3_420_000 };
}
