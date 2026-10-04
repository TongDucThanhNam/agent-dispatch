import { expect, test } from 'bun:test';
import { analyzeCarry } from '../web/src/lib/carry.ts';
import { computeInsights } from '../web/src/lib/insights.ts';
import { analyzePromptMix, findCacheBreaks, type MixPoint } from '../web/src/lib/prompt-mix.ts';
import type { Run, TrajectoryEvent } from '../web/src/lib/types.ts';

const point = (i: number, prompt: number, extra: Partial<MixPoint> = {}): MixPoint => ({
  id: `r${i}`, request: i, fresh: prompt, cached: 0, output: 150, reasoning: 100, compactedBefore: false,
  startedAt: i * 60_000, endedAt: i * 60_000 + 5000, ttftMs: 1000, ...extra,
});
const tool = (id: string, label: string) => ({ id, kind: 'tool', label, startedAt: 0 }) as TrajectoryEvent;
const model = (p: MixPoint) => ({ id: p.id, kind: 'model', label: 'model', startedAt: p.startedAt }) as TrajectoryEvent;
const colors = () => { const seen: string[] = []; return (name: string) => { if (!seen.includes(name)) seen.push(name); return seen.indexOf(name) < 2 ? `c${seen.indexOf(name)}` : null; }; };
const mixOf = (points: MixPoint[], events: TrajectoryEvent[], palette = colors()) =>
  analyzePromptMix(events, points, analyzeCarry(points.map(p => ({ ...p, prompt: p.fresh + p.cached }))), palette)!;
const slice = (mix: ReturnType<typeof mixOf>, key: string) => mix.slices.find(s => s.key === key)?.tokens ?? 0;

// Base 10,000. Each request writes 100 reasoning + 50 visible; Read returns 5,000 after #1, Bash 1,000 after #2,
// Read and Grep 2,000 together after #3.
function scenario() {
  const points = [point(1, 10_000), point(2, 15_150), point(3, 16_300), point(4, 18_450)];
  const events = [model(points[0]), tool('t1', 'Read'), model(points[1]), tool('t2', 'Bash'), model(points[2]), tool('t3', 'Read'), tool('t4', 'Grep'), model(points[3])];
  return { points, events };
}

test('every prompt token is attributed to one source, counted once per request that read it', () => {
  const { points, events } = scenario();
  const mix = mixOf(points, events);
  expect(mix.total).toBe(59_900);
  expect(slice(mix, 'base')).toBe(40_000);
  expect(slice(mix, 'reasoning')).toBe(600);
  expect(slice(mix, 'output')).toBe(300);
  expect(slice(mix, 'tool:Read')).toBe(16_000);
  expect(slice(mix, 'tool:Bash')).toBe(2000);
  expect(mix.pruned).toBe(0);
  expect(mix.slices.reduce((n, s) => n + s.tokens, 0)).toBe(mix.total);
  expect(mix.slices[0].key).toBe('base');
  expect([mix.first, mix.last]).toEqual([10_000, 18_450]);
});

test('tools past the palette fold into other tools, and the heaviest results are the early large ones', () => {
  const { points, events } = scenario();
  const mix = mixOf(points, events);
  // Read and Bash take the two colours; Grep joins "other tools".
  expect(mix.slices.find(s => s.key === 'tool:*')).toMatchObject({ label: '1 other tools', tokens: 1000, ids: ['t4'] });
  expect(mix.heaviest.map(h => [h.id, h.tokens, h.reads, h.shared])).toEqual([['t1', 5000, 3, 1], ['t2', 1000, 2, 1], ['t3', 1000, 1, 2], ['t4', 1000, 1, 2]]);
});

test('compaction starts a new base, a shrinking prompt counts as pruned, and growth without tools is injected context', () => {
  const points = [point(1, 10_000), point(2, 12_150), point(3, 6000, { compactedBefore: true }), point(4, 5000), point(5, 7150)];
  const events = points.map(model);
  const mix = mixOf(points, events);
  // Segment 1: base 10,000 × 2; segment 2: base 6,000 × 3.
  expect(slice(mix, 'base')).toBe(38_000);
  expect(slice(mix, 'context')).toBe(2000 + 2000);
  // #3 → #4 shrank by 1,000 plus the 150 the model wrote, read once by #4 and once by #5.
  expect(mix.pruned).toBe(1150 * 2);
  expect(mix.slices.reduce((n, s) => n + s.tokens, 0) - mix.pruned).toBe(mix.total);
});

test('dropped reasoning is not counted as carried, so its growth is not misattributed', () => {
  // Prompts grow by visible output and tool results only: the provider drops reasoning.
  const points = Array.from({ length: 8 }, (_, i) => point(i + 1, 10_000 + i * 150, { reasoning: 400, output: 450 }));
  const events = points.flatMap((p, i) => [model(p), tool(`t${i}`, 'Read')]);
  const mix = mixOf(points, events);
  expect(slice(mix, 'reasoning')).toBe(0);
  expect(slice(mix, 'tool:Read')).toBe(100 * (7 + 6 + 5 + 4 + 3 + 2 + 1));
  expect(mix.pruned).toBe(0);
});

test('cache breaks are the requests that re-processed a cached prefix, split by whether a long wait preceded them', () => {
  const points = Array.from({ length: 8 }, (_, i) => point(i + 1, 20_000 + i * 1000));
  points.forEach((p, i) => { if (i) { p.cached = 20_000 + (i - 1) * 1000; p.fresh = 1000; } });
  Object.assign(points[4], { cached: 0, fresh: 24_000, startedAt: points[3].endedAt! + 6 * 60_000, ttftMs: 5000 });
  Object.assign(points[6], { cached: 2000, fresh: 24_000, startedAt: points[5].endedAt! + 10_000, ttftMs: 7000 });
  const result = findCacheBreaks(points)!;
  expect(result.breaks.map(b => [b.id, b.missed, b.longWait])).toEqual([['r5', 23_000, true], ['r7', 23_000, false]]);
  expect(result.breaks[0].gapMs).toBe(6 * 60_000);
  expect(result.missed).toBe(46_000);
  expect(result.ttft).toEqual({ breaks: 7000, others: 1000 });
  // A run that never caches has no breaks to find; the hit-rate finding covers it.
  expect(findCacheBreaks(points.map(p => ({ ...p, fresh: p.fresh + p.cached, cached: 0 })))).toBeNull();
});

const at = (i: number) => 1_000_000 + i * 60_000;
// Read returns 30,000 tokens after #1; Bash returns 500 after each later request; #5 follows a six-minute wait and misses the cache.
function heavyRun() {
  const prompts = [20_000, 50_150, 50_800, 51_450, 52_100, 52_750, 53_400, 54_050];
  const events: TrajectoryEvent[] = [];
  prompts.forEach((prompt, i) => {
    const wait = i >= 4 ? 6 * 60_000 : 0;
    events.push({ id: `r${i + 1}`, kind: 'model', label: 'model', status: 'completed', startedAt: at(i) + wait, endedAt: at(i) + wait + 5000, request: i + 1,
      inputTokens: prompt, cacheReadTokens: i === 0 ? 0 : i === 4 ? 0 : prompts[i - 1], outputTokens: 150, reasoningTokens: 100, ttftMs: i === 4 ? 9000 : 1000,
      finishReason: i === 2 ? 'max_tokens' : 'tool_use' });
    events.push({ id: `t${i + 1}`, kind: 'tool', label: i === 0 ? 'Read' : 'Bash', status: 'completed', startedAt: at(i) + wait + 6000, endedAt: at(i) + wait + 7000 });
  });
  return { startedAt: at(0), endedAt: at(9), active: false, trajectory: { events, stats: {} } } as unknown as Run;
}

test('insights flag the heaviest result, the cache misses and responses cut at the output limit', () => {
  const insights = computeInsights(heavyRun(), null, at(10));
  const keys = insights.findings.map(f => f.key);
  expect(keys).toContain('heavy-result');
  expect(keys).toContain('cache-break');
  expect(keys).toContain('output-limit');
  const heavy = insights.findings.find(f => f.key === 'heavy-result')!;
  expect(heavy.title).toBe('One Read result was read again 7×');
  expect(heavy.ids).toEqual(['t1']);
  expect(insights.findings.find(f => f.key === 'cache-break')!.ids).toEqual(['r5']);
  expect(insights.findings.find(f => f.key === 'output-limit')!.ids).toEqual(['r3']);
  // Read keeps the colour it has in the time breakdown.
  const readTime = insights.time.find(s => s.key === 'tool:Read')!, readTokens = insights.mix!.slices.find(s => s.key === 'tool:Read')!;
  expect(readTokens.color).toBe(readTime.color);
});

test('repeated calls carry the prompt tokens their repeats put through later requests', () => {
  const previews = { get: (id: string) => id.startsWith('t') ? { text: id === 't1' ? 'src/big.json' : 'bun test' } : undefined };
  const insights = computeInsights(heavyRun(), previews, at(10));
  const bash = insights.repeats.find(g => g.tool === 'Bash')!;
  expect(bash.ids).toHaveLength(7);
  // The first call is not a repeat; t8 follows the last request, so nothing read it.
  expect(bash.tokens).toBe(500 * (5 + 4 + 3 + 2 + 1));
  expect(insights.findings.find(f => f.key === 'repeats')!.detail).toContain('the repeats alone put 7.5K tokens through later prompts');
});
