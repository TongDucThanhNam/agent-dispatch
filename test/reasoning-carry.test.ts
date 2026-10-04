import { expect, test } from 'bun:test';
import { analyzeCarry, costliest, projectCarry, type CarryInput } from '../web/src/lib/carry.ts';
import { computeInsights } from '../web/src/lib/insights.ts';
import type { Run, TrajectoryEvent } from '../web/src/lib/types.ts';

// Each request reasons `reasoning` tokens inside `output`; the next prompt adds that output plus `tool` tokens of results.
function loop(count: number, { reasoning = 100, visible = 50, tool = 1000, base = 10_000, kept = true, compactAt = -1 } = {}): CarryInput[] {
  const inputs: CarryInput[] = [];
  let prompt = base;
  for (let i = 0; i < count; i++) {
    const compactedBefore = i === compactAt;
    if (compactedBefore) prompt = base;
    inputs.push({ id: `r${i + 1}`, request: i + 1, prompt, output: reasoning + visible, reasoning, compactedBefore });
    prompt += (kept ? reasoning : 0) + visible + tool;
  }
  return inputs;
}

test('carried reasoning grows linearly per prompt, so the re-reads grow with the square of the request count', () => {
  const carry = analyzeCarry(loop(5))!;
  expect(carry.basis).toBe('reasoning');
  expect(carry.points.map(p => p.carried)).toEqual([0, 100, 200, 300, 400]);
  expect(carry.points.map(p => p.rereads)).toEqual([4, 3, 2, 1, 0]);
  expect(carry.generated).toBe(500);
  expect(carry.reread).toBe(1000);
  expect(carry.points.map(p => p.rereadSoFar)).toEqual([0, 100, 300, 600, 1000]);
  expect(carry.peak.id).toBe('r5');
  expect(carry.atCompaction).toBeNull();
  // 400 reasoning tokens are too few to judge retention from prompt sizes; 700 are enough.
  expect(carry.retention).toBeNull();
  expect(analyzeCarry(loop(8))!.retention).toEqual({ verdict: 'kept', share: 1 });
  // N requests reading r each: r × N(N−1)/2 against r × N generated.
  const long = analyzeCarry(loop(100))!;
  expect(long.reread).toBe(100 * 100 * 99 / 2);
  expect(long.reread / long.generated).toBe(49.5);
});

test('a compaction resets the carried reasoning and records how much of the compacted prompt it filled', () => {
  const carry = analyzeCarry(loop(6, { compactAt: 3 }))!;
  expect(carry.points.map(p => p.carried)).toEqual([0, 100, 200, 0, 100, 200]);
  expect(carry.points.map(p => p.rereads)).toEqual([2, 1, 0, 2, 1, 0]);
  expect(carry.reread).toBe(600);
  expect(carry.atCompaction).toEqual({ request: 3, prompt: 12_300, carried: 300 });
});

test('projection scales generation linearly and the re-reads by the same factor of a much larger base', () => {
  const carry = analyzeCarry(loop(10))!;
  const max = projectCarry(carry, 5);
  // 100 → 500 tokens a request looks like +4,000 tokens over ten requests ...
  expect(max.generated).toBe(4000);
  // ... but every later prompt reads the extra again: 400 × (0 + 1 + … + 9).
  expect(max.reread).toBe(400 * 45);
  expect(max.peakPrompt).toBe(carry.points[9].prompt + 4 * 900);
  const low = projectCarry(carry, 0.25);
  expect(low.generated).toBe(-750);
  expect(low.peakPrompt).toBe(carry.points[9].prompt - 0.75 * 900);
});

test('prompts that grow by less than the reasoning show the provider dropping it', () => {
  expect(analyzeCarry(loop(8, { kept: false, tool: 0 }))!.retention?.verdict).toBe('dropped');
  expect(analyzeCarry(loop(8, { kept: false, tool: 60 }))!.retention?.verdict).toBe('partial');
  // Growth from tool output alone can hold the reasoning: consistency, not proof, so it reads as kept.
  expect(analyzeCarry(loop(8, { kept: false, tool: 1000 }))!.retention?.verdict).toBe('kept');
});

test('without reported reasoning the carry-over covers all model output and skips the retention check', () => {
  const carry = analyzeCarry(loop(4).map(p => ({ ...p, reasoning: null })))!;
  expect(carry.basis).toBe('output');
  expect(carry.points.map(p => p.carried)).toEqual([0, 150, 300, 450]);
  expect(carry.retention).toBeNull();
  expect(analyzeCarry(loop(4).map(p => ({ ...p, reasoning: null, output: 0 })))).toBeNull();
  expect(analyzeCarry(loop(1))).toBeNull();
});

test('reasoning reported beside output is not subtracted from it', () => {
  // AGY-style: output 50 visible, reasoning 100 counted separately; the next prompt holds both.
  const inputs = loop(6).map(p => ({ ...p, output: 50 }));
  const carry = analyzeCarry(inputs)!;
  expect(carry.points.map(p => p.carried)).toEqual([0, 100, 200, 300, 400, 500]);
  expect(carry.retention?.verdict).toBe('kept');
});

test('carried tokens never exceed the prompt that holds them, and the costliest requests are the early long ones', () => {
  const inputs = loop(5, { kept: false, tool: 0, base: 120, visible: 0 });
  const carry = analyzeCarry(inputs)!;
  for (const point of carry.points) expect(point.carried).toBeLessThanOrEqual(point.prompt);
  const uneven = analyzeCarry(loop(6).map((p, i) => ({ ...p, reasoning: i === 1 ? 2000 : 100, output: i === 1 ? 2050 : 150 })))!;
  expect(costliest(uneven, 2).map(p => p.id)).toEqual(['r2', 'r1']);
});

test('insights report the carry-over as a context finding pointing at the requests that cost the most', () => {
  const events: TrajectoryEvent[] = loop(12, { reasoning: 2000, visible: 100, tool: 500 }).map((p, i) => ({
    id: p.id, kind: 'model', label: 'model', status: 'completed', startedAt: 1000 + i * 10, endedAt: 1005 + i * 10, request: p.request,
    inputTokens: p.prompt, cacheReadTokens: Math.max(0, p.prompt - 2600), outputTokens: p.output, reasoningTokens: p.reasoning,
  }));
  const run = { startedAt: 1000, endedAt: 1200, active: false, trajectory: { events, stats: {} } } as unknown as Run;
  const insights = computeInsights(run, null, 2000);
  expect(insights.carry?.generated).toBe(24_000);
  expect(insights.context.map(p => p.reasoning)).toEqual(events.map(() => 2000));
  const finding = insights.findings.find(f => f.key === 'carry')!;
  expect(finding.area).toBe('Context');
  expect(finding.title).toBe('Reasoning re-read 6× in later prompts');
  expect(finding.ids).toEqual(['r1', 'r2', 'r3', 'r4', 'r5']);
});
