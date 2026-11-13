import { test, expect } from 'bun:test';
import { median, summarizeGeminiResources } from '../scripts/gemini-metrics.ts';

function samples(growth = 0) {
  return Array.from({ length: 24 }, (_, index) => ({ event: 'sample', elapsedMs: index * 1000,
    phase: index < 12 ? 'baseline' : 'cooldown', privateMB: 500 + (index < 12 ? 0 : growth), workingMB: 600,
    rootPrivateMB: 80, rootHandles: 1000, handles: 4000, processCount: 6, cpuDeltaSeconds: .1 }));
}
test('resource summaries use idle medians, keep CPU units and distinguish caching from an alarm', () => {
  const data = samples(20); data[23].privateMB = 1800;
  const result = summarizeGeminiResources(data);
  expect(result.passed).toBe(true); expect(result.retained.privateGrowthMB).toBe(20);
  expect(result.peakPrivateMB).toBe(1800); expect(result.meanCpuOneCorePercent).toBeCloseTo(10);
  expect(median([100, 1, 3, 2])).toBe(2.5);
  const alarming = summarizeGeminiResources(samples(300));
  expect(alarming.passed).toBe(false); expect(alarming.alerts[0]).toContain('declared alarm');
});
test('missing cooldown or a disappearing owner cannot be reported as a passed soak', () => {
  expect(summarizeGeminiResources(samples().slice(0, 12)).passed).toBe(false);
  expect(summarizeGeminiResources([...samples(), { event: 'owner-exit', exitCode: 1 }]).passed).toBe(false);
  expect(summarizeGeminiResources([]).passed).toBe(false);
});

test('cold cache loading is disclosed separately, and active CPU excludes idle dilution', () => {
  const rows = samples(20).map(row => ({ ...row, elapsedMs: row.elapsedMs + 20_000 }));
  const data = [{ ...rows[0], phase: 'cold', elapsedMs: 0, privateMB: 200 },
    { ...rows[0], phase: 'work', case: 'soak-001', elapsedMs: 1000, cpuDeltaSeconds: .5 }, ...rows];
  const result = summarizeGeminiResources(data);
  expect(result.passed).toBe(true); expect(result.coldToWarmPrivateGrowthMB).toBe(300);
  expect(result.retained.privateGrowthMB).toBe(20); expect(result.workCpuOneCorePercent).toBe(50);
});
