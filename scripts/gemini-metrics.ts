export const median = (values: number[]) => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b), mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};

/** Retained-memory alarms, not a claim that normal Chromium caching is a leak. */
export function summarizeGeminiResources(records: any[]) {
  const samples = records.filter(row => row.event === 'sample');
  const before = samples.filter(row => row.phase === 'baseline').slice(-10);
  const after = samples.filter(row => row.phase === 'cooldown').slice(-10);
  const cold = samples.filter(row => row.phase === 'cold').slice(-10);
  const limits = { rootPrivateGrowthMB: 64, privateGrowthMB: 256, rootHandleGrowth: 64, processGrowth: 2 };
  const alerts: string[] = [];
  if (records.some(row => row.event === 'owner-exit')) alerts.push('Gemini owner exited; inspect its recorded exit code.');
  if (before.length < 5 || after.length < 5) alerts.push('Insufficient baseline/cooldown samples.');
  const fields = ['privateMB', 'workingMB', 'rootPrivateMB', 'rootHandles', 'handles', 'processCount'];
  const summarize = (rows: any[]) => Object.fromEntries(fields.map(field => [field, median(rows.map(row => row[field]))]));
  const baseline = summarize(before), cooldown = summarize(after);
  const coldStart = summarize(cold);
  const delta = (field: string) => baseline[field] == null || cooldown[field] == null ? null : cooldown[field]! - baseline[field]!;
  const retained = { rootPrivateGrowthMB: delta('rootPrivateMB'), privateGrowthMB: delta('privateMB'),
    rootHandleGrowth: delta('rootHandles'), processGrowth: delta('processCount') };
  for (const [key, limit] of Object.entries(limits)) if (retained[key] != null && retained[key] > limit)
    alerts.push(`${key} ${retained[key].toFixed(2)} exceeds declared alarm ${limit}.`);
  const wallSeconds = samples.length > 1 ? (samples.at(-1).elapsedMs - samples[0].elapsedMs) / 1000 : 0;
  const cpuSeconds = samples.slice(1).reduce((sum, row) => sum + row.cpuDeltaSeconds, 0);
  let workSeconds = 0, workCpuSeconds = 0;
  for (let i = 1; i < samples.length; i++) if (samples[i].phase === 'work' && samples[i].case !== 'warmup') {
    workSeconds += (samples[i].elapsedMs - samples[i - 1].elapsedMs) / 1000;
    workCpuSeconds += samples[i].cpuDeltaSeconds;
  }
  return { passed: !alerts.length, alerts, limits, samples: samples.length, durationSeconds: wallSeconds,
    coldStart, baseline, cooldown, retained,
    coldToWarmPrivateGrowthMB: coldStart.privateMB == null || baseline.privateMB == null ? null : baseline.privateMB - coldStart.privateMB,
    peakPrivateMB: samples.length ? Math.max(...samples.map(row => row.privateMB)) : null,
    sampledCpuSeconds: cpuSeconds, meanCpuOneCorePercent: wallSeconds ? cpuSeconds / wallSeconds * 100 : null,
    workSeconds, sampledWorkCpuSeconds: workCpuSeconds, workCpuOneCorePercent: workSeconds ? workCpuSeconds / workSeconds * 100 : null,
    cpuAccounting: 'Sum of per-process CPU deltas. A process exiting between samples can hide its final CPU interval; 100% means one core.',
    scope: 'Verified Gemini executable only. Cold-to-warm cache growth is reported separately; acceptance compares warm idle with final idle. Retained growth is an alarm, not proof of a leak.' };
}
