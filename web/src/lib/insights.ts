// Run diagnostics for auditing an agent session: where the wall time went, which failures repeat, which
// calls are redundant, and how the context grew. Computed in the browser from the trajectory and the
// one-line previews (the only content read), so it works against any hub version.

import { analyzeCarry, costliest, type Carry } from './carry';
import { duration, full, num } from './format';
import { analyzePromptMix, CACHE_TTL_MS, findCacheBreaks, type CacheBreaks, type PromptMix } from './prompt-mix';
import { isFailed, isRunning } from './status';
import { parseToolError } from './tool-content';
import type { Preview, Run, TrajectoryEvent } from './types';

export type Severity = 'high' | 'medium' | 'low' | 'info';
export type Area = 'Errors' | 'Time' | 'Context' | 'Cache' | 'Waste' | 'Data';

export interface Finding {
  key: string;
  severity: Severity;
  area: Area;
  title: string;
  detail: string;
  /** Events behind the finding, in trajectory order. */
  ids: string[];
}

export interface TimeSlice { key: string; label: string; ms: number; color: string; hint: string; ids: string[] }
export interface ErrorVariant { text: string; ids: string[] }
export interface ErrorGroup { key: string; tool: string; title: string; ids: string[]; variants: ErrorVariant[] }
export interface RepeatGroup {
  key: string; tool: string; text: string; ids: string[]; failed: number; ms: number;
  /** Prompt tokens the repeats (all but the first call) put through later requests, when results could be attributed. */
  tokens: number | null;
}
export interface ContextPoint {
  id: string; request: number; at: number; endedAt: number | null; ttftMs: number | null;
  fresh: number; cached: number; output: number; reasoning: number | null; compactedBefore: boolean;
}
export interface Gap { from: number; to: number; nextId: string | null }

export interface Insights {
  wallMs: number;
  time: TimeSlice[];
  findings: Finding[];
  errors: ErrorGroup[];
  repeats: RepeatGroup[];
  slowest: TrajectoryEvent[];
  context: ContextPoint[];
  /** How the model's own reasoning (or output) is read again by later prompts. */
  carry: Carry | null;
  /** Where the prompt tokens came from: starting context, the model's own output, each tool's results. */
  mix: PromptMix | null;
  /** Requests that re-processed a prefix the previous request had cached. */
  cacheBreaks: CacheBreaks | null;
  /** Previews the diagnostics need (tool calls, failures) against those loaded so far. */
  coverage: { loaded: number; total: number };
}

type Previews = { get(id: string): Preview | undefined } | null;

const SEVERITY_ORDER: Record<Severity, number> = { high: 0, medium: 1, low: 2, info: 3 };
const spanOf = (event: TrajectoryEvent, now: number) => {
  const end = event.endedAt ?? (isRunning(event) ? now : null);
  return end == null ? null : Math.max(0, end - event.startedAt);
};
const plural = (n: number, word: string, many = `${word}s`) => `${full(n)} ${n === 1 ? word : many}`;
const clip = (text: string, size = 90) => (text.length > size ? `${text.slice(0, size - 1)}…` : text);

/** Needs previews: tool calls (for repeats and sleeps) and failures (for error text). */
export const needsPreview = (event: TrajectoryEvent) => event.kind === 'tool' || isFailed(event);

/** Two calls count as the same when the tool and its input summary match. */
// Previews summarise edits by their path alone, so two edits to one file would look like the same call.
const EDITS = /edit|write|patch|replace|create|todo|notebook/i;

export function callKey(event: TrajectoryEvent, preview?: Preview) {
  const text = preview?.text?.replace(/\s+/g, ' ').trim();
  return event.kind === 'tool' && text && !EDITS.test(event.label) ? `${event.label}\u0000${text}` : null;
}

/** Tool calls with the same tool and input as `event`, including it. */
export function sameCalls(events: TrajectoryEvent[], previews: Previews, event: TrajectoryEvent) {
  const key = callKey(event, previews?.get(event.id));
  return key ? events.filter(e => e.kind === 'tool' && e.label === event.label && callKey(e, previews?.get(e.id)) === key) : [];
}

/** The error class and variant of a failed event, from its preview (first line of the error). */
export function errorOf(event: TrajectoryEvent, preview?: Preview): { title: string; variant: string } {
  if (event.kind === 'model') return { title: `Request error${event.error ? `: ${event.error}` : ''}`, variant: event.error ?? '' };
  const text = (event.kind === 'tool' ? preview?.result : null) ?? event.error ?? '';
  if (!text) return { title: `${event.label} failed`, variant: '' };
  const parsed = parseToolError(text.replace(/^→\s*/, ''));
  const title = parsed.exitCode != null ? `${parsed.title} (exit ${parsed.exitCode})` : parsed.title;
  return { title: clip(title, 80), variant: (parsed.command ?? parsed.detail ?? '').replace(/\s+/g, ' ').trim() };
}

const SLEEP = /\b(?:Start-Sleep|sleep)\b\s+-?\w*\s*\d|\btimeout\s+\/t\b|\bwait-process\b/i;
const isSleep = (event: TrajectoryEvent, preview?: Preview) =>
  event.kind === 'tool' && (/sleep|wait/i.test(event.label) || SLEEP.test(preview?.text ?? ''));

// Tools share the tool hue, in shades mixed toward the foreground or background so they work in both themes: the
// breakdowns read tools against the model first, and each row names its tool. A tool keeps its shade across the
// time and token breakdowns; once the shades run out, further tools join "other tools".
const TOOL_SHADES = ['var(--kind-tool)', ...[[62, 'foreground'], [55, 'background'], [38, 'foreground'], [30, 'background'], [80, 'foreground'], [75, 'background']]
  .map(([share, toward]) => `color-mix(in oklch, var(--kind-tool) ${share}%, var(--${toward}))`)];
export const OTHER_TOOLS = 'color-mix(in oklch, var(--kind-tool) 18%, var(--muted))';
function toolPalette() {
  const colors = new Map<string, string>();
  return (tool: string) => {
    if (!colors.has(tool) && colors.size < TOOL_SHADES.length) colors.set(tool, TOOL_SHADES[colors.size]);
    return colors.get(tool) ?? null;
  };
}

export function computeInsights(run: Run, previews: Previews, now: number): Insights {
  const events = run.trajectory.events;
  const stats = run.trajectory.stats ?? {};
  const findings: Finding[] = [];
  const add = (finding: Finding) => findings.push(finding);
  const colorFor = toolPalette();

  // ── Wall-clock attribution ─────────────────────────────────────────────────────────────────────
  // Every millisecond of the run goes to one activity: a running tool first, then compaction, then the
  // model decoding, then waiting for its first token, then retry back-off; the rest is untracked.
  const first = events[0]?.startedAt ?? run.startedAt;
  const start = Math.min(run.startedAt, first);
  const lastEnd = events.reduce((max, e) => Math.max(max, e.endedAt ?? e.startedAt), start);
  const end = Math.max(run.endedAt ?? (run.active ? now : lastEnd), lastEnd);
  const wallMs = Math.max(0, end - start);

  const rank = (cat: string) => cat.startsWith('tool:') ? 5 : cat === 'compaction' ? 4 : cat === 'decode' ? 3 : cat === 'wait' ? 2 : 1;
  const points: { at: number; delta: 1 | -1; cat: string }[] = [];
  const catIds = new Map<string, string[]>();
  const push = (from: number, to: number, cat: string, id: string) => {
    const a = Math.max(start, from), b = Math.min(end, to);
    if (b <= a) return;
    points.push({ at: a, delta: 1, cat }, { at: b, delta: -1, cat });
    const ids = catIds.get(cat) ?? [];
    if (ids.at(-1) !== id) ids.push(id);
    catIds.set(cat, ids);
  };
  for (const event of events) {
    const ms = spanOf(event, now);
    if (ms == null || ms <= 0) continue;
    const to = event.startedAt + ms;
    if (event.kind === 'tool') push(event.startedAt, to, `tool:${event.label}`, event.id);
    else if (event.kind === 'model') {
      const ttft = event.ttftMs != null ? Math.min(ms, Math.max(0, event.ttftMs)) : 0;
      push(event.startedAt, event.startedAt + ttft, 'wait', event.id);
      push(event.startedAt + ttft, to, 'decode', event.id);
    } else if (event.kind === 'compaction') push(event.startedAt, to, 'compaction', event.id);
    else if (event.kind === 'retry') push(event.startedAt, to, 'retry', event.id);
  }
  points.sort((a, b) => a.at - b.at || a.delta - b.delta);

  const totals = new Map<string, number>();
  const active = new Map<string, number>();
  const gaps: Gap[] = [];
  let cursor = start, gapFrom: number | null = null;
  const attribute = (to: number) => {
    if (to <= cursor) return;
    let top: string | null = null;
    for (const [cat, count] of active) if (count > 0 && (!top || rank(cat) > rank(top) || (rank(cat) === rank(top) && count > active.get(top)!))) top = cat;
    const cat = top ?? 'idle';
    totals.set(cat, (totals.get(cat) ?? 0) + to - cursor);
    if (!top) gapFrom ??= cursor;
    else if (gapFrom != null) { gaps.push({ from: gapFrom, to: cursor, nextId: null }); gapFrom = null; }
    cursor = to;
  };
  for (const point of points) {
    attribute(point.at);
    active.set(point.cat, (active.get(point.cat) ?? 0) + point.delta);
  }
  attribute(end);
  if (gapFrom != null) gaps.push({ from: gapFrom, to: end, nextId: null });
  for (const gap of gaps) gap.nextId = events.find(e => e.startedAt >= gap.to - 1)?.id ?? null;

  const tools = [...totals].filter(([cat]) => cat.startsWith('tool:')).sort((a, b) => b[1] - a[1]);
  const time: TimeSlice[] = [];
  tools.slice(0, 5).forEach(([cat, ms]) => time.push({ key: cat, label: cat.slice(5), ms, color: colorFor(cat.slice(5))!, hint: 'Tool calls running', ids: catIds.get(cat) ?? [] }));
  const otherTools = tools.slice(5);
  if (otherTools.length) {
    time.push({ key: 'tool:*', label: `${otherTools.length} other tools`, ms: otherTools.reduce((n, [, ms]) => n + ms, 0), color: OTHER_TOOLS,
      hint: otherTools.map(([cat]) => cat.slice(5)).join(', '), ids: otherTools.flatMap(([cat]) => catIds.get(cat) ?? []) });
  }
  const fixed: [string, string, string, string][] = [
    ['decode', 'Model decoding', 'var(--kind-model)', 'The model streaming its reply after the first token'],
    ['wait', 'Waiting for model', 'var(--kind-model-wait)', 'Time to first token: prompt processing and queueing'],
    ['compaction', 'Compaction', 'var(--kind-compaction)', 'Summarising the context to fit the window'],
    ['retry', 'Retry back-off', 'var(--kind-retry)', 'Waiting before retrying a failed request'],
    ['idle', 'Untracked', 'color-mix(in oklch, var(--muted-foreground) 28%, transparent)', 'No model request or tool call recorded: harness overhead, approvals, or an idle worker'],
  ];
  for (const [key, label, color, hint] of fixed) {
    const ms = totals.get(key) ?? 0;
    if (ms > 0) time.push({ key, label, ms, color, hint, ids: catIds.get(key) ?? [] });
  }
  time.sort((a, b) => b.ms - a.ms);

  // ── Errors ─────────────────────────────────────────────────────────────────────────────────────
  const groups = new Map<string, { tool: string; title: string; ids: string[]; variants: Map<string, string[]> }>();
  for (const event of events) {
    if (!isFailed(event)) continue;
    const { title, variant } = errorOf(event, previews?.get(event.id));
    const key = `${event.kind === 'tool' ? event.label : event.kind}\u0000${title}`;
    const group = groups.get(key) ?? { tool: event.kind === 'tool' ? event.label : event.kind === 'model' ? 'Model' : event.label, title, ids: [] as string[], variants: new Map<string, string[]>() };
    group.ids.push(event.id);
    const ids = group.variants.get(variant) ?? [];
    ids.push(event.id);
    group.variants.set(variant, ids);
    groups.set(key, group);
  }
  const errors: ErrorGroup[] = [...groups].map(([key, g]) => ({
    key, tool: g.tool, title: g.title, ids: g.ids,
    variants: [...g.variants].map(([text, ids]) => ({ text, ids })).sort((a, b) => b.ids.length - a.ids.length),
  })).sort((a, b) => b.ids.length - a.ids.length);

  const patchFailures = errors.filter(g => /apply_patch|patch verification|failed to find expected lines/i.test(`${g.title} ${g.variants[0]?.text}`));
  const patchIds = patchFailures.flatMap(g => g.ids);
  if (patchIds.length) {
    const files = new Set(patchFailures.flatMap(g => g.variants.map(v => /expected lines in (.+?):?$/i.exec(v.text)?.[1]).filter(Boolean)));
    add({
      key: 'patch', severity: patchIds.length >= 3 ? 'high' : 'medium', area: 'Errors', ids: patchIds,
      title: `${plural(patchIds.length, 'edit')} failed to apply`,
      detail: `The patch context did not match the file${files.size ? ` (${[...files].slice(0, 2).map(f => f!.split(/[\\/]/).pop()).join(', ')}${files.size > 2 ? '…' : ''})` : ''}: the agent edited from stale or guessed contents. Re-reading the file before patching avoids the retry loop.`,
    });
  }
  for (const group of errors) {
    if (patchFailures.includes(group)) continue;
    const top = group.variants[0];
    if (top && top.ids.length >= 3 && top.text) {
      add({
        key: `repeat-fail:${group.key}`, severity: top.ids.length >= 5 ? 'high' : 'medium', area: 'Errors', ids: top.ids,
        title: `${group.tool} failed the same way ${top.ids.length}×`,
        detail: `${group.title}: ${clip(top.text, 140)}. The agent retried without changing approach.`,
      });
    }
  }
  for (const tool of stats.tools ?? []) {
    if (tool.calls < 10 || tool.errors / tool.calls < 0.2) continue;
    const ids = events.filter(e => e.kind === 'tool' && e.label === tool.name && isFailed(e)).map(e => e.id);
    const classes = errors.filter(g => g.tool === tool.name).slice(0, 2).map(g => `${g.title} ×${g.ids.length}`).join(', ');
    add({
      key: `rate:${tool.name}`, severity: tool.errors / tool.calls >= 0.35 ? 'high' : 'medium', area: 'Errors', ids,
      title: `${tool.name} fails ${Math.round(tool.errors / tool.calls * 100)}% of the time`,
      detail: `${full(tool.errors)} of ${full(tool.calls)} calls failed${classes ? ` — mostly ${classes}` : ''}. Non-zero exits from probing commands (grep with no match, test -f) also count here.`,
    });
  }
  const cut = events.filter(e => e.kind === 'model' && /max_tokens|length|max_output/i.test(e.finishReason ?? ''));
  if (cut.length) {
    add({
      key: 'output-limit', severity: cut.length >= 3 ? 'medium' : 'low', area: 'Errors', ids: cut.map(e => e.id),
      title: `${plural(cut.length, 'response')} hit the output limit`,
      detail: 'Generation stopped at the maximum output tokens, so the reply or tool call was cut short and has to be continued or redone. With reasoning on, long reasoning can use up the limit before the answer starts.',
    });
  }
  const requestFailures = events.filter(e => (e.kind === 'model' && isFailed(e)) || e.kind === 'retry').map(e => e.id);
  if (requestFailures.length || stats.requestErrors || stats.retries) {
    add({
      key: 'requests', severity: 'medium', area: 'Errors', ids: requestFailures,
      title: `${plural(stats.requestErrors ?? requestFailures.length, 'model request')} failed${stats.retries ? `, ${plural(stats.retries, 'retry', 'retries')}` : ''}`,
      detail: 'Provider errors or rate limits. Retries add back-off time and resend the whole prompt.',
    });
  }

  // ── Time ───────────────────────────────────────────────────────────────────────────────────────
  const sleeps = events.filter(e => isSleep(e, previews?.get(e.id)));
  const sleepMs = sleeps.reduce((n, e) => n + (spanOf(e, now) ?? 0), 0);
  if (sleepMs >= 60_000 && sleepMs >= wallMs * 0.03) {
    add({
      key: 'sleep', severity: sleepMs >= wallMs * 0.1 ? 'medium' : 'low', area: 'Time', ids: sleeps.map(e => e.id),
      title: `${duration(sleepMs)} spent sleeping`,
      detail: `${plural(sleeps.length, 'sleep call')} (${Math.round(sleepMs / wallMs * 100)}% of the run). Fixed sleeps while polling a build or server; waiting on the process or a shorter back-off is cheaper.`,
    });
  }
  const slow = events.filter(e => e.kind === 'tool' && !isSleep(e, previews?.get(e.id)) && (spanOf(e, now) ?? 0) >= 120_000);
  if (slow.length) {
    const slowMs = slow.reduce((n, e) => n + (spanOf(e, now) ?? 0), 0);
    const worst = [...slow].sort((a, b) => (spanOf(b, now) ?? 0) - (spanOf(a, now) ?? 0)).slice(0, 3)
      .map(e => `${e.label} ${duration(spanOf(e, now))}${previews?.get(e.id)?.text ? ` (${clip(previews.get(e.id)!.text!, 40)})` : ''}`);
    add({
      key: 'slow', severity: slowMs >= wallMs * 0.15 ? 'medium' : 'low', area: 'Time', ids: slow.map(e => e.id),
      title: `${plural(slow.length, 'tool call')} ran over 2 minutes`,
      detail: `${duration(slowMs)} in total. Longest: ${worst.join('; ')}.`,
    });
  }
  const models = events.filter(e => e.kind === 'model' && e.ttftMs != null);
  const waitMs = models.reduce((n, e) => n + (e.ttftMs ?? 0), 0);
  if (models.length >= 5 && waitMs >= wallMs * 0.3) {
    const sorted = models.map(e => e.ttftMs!).sort((a, b) => a - b), median = sorted[sorted.length >> 1];
    add({
      key: 'ttft', severity: waitMs >= wallMs * 0.5 ? 'medium' : 'low', area: 'Time',
      ids: models.filter(e => e.ttftMs! >= Math.max(median * 2, 10_000)).map(e => e.id),
      title: `${Math.round(waitMs / wallMs * 100)}% of the run waiting for the model`,
      detail: `Median time to first token ${duration(median)} over ${plural(models.length, 'request')}. Large prompts and cache misses raise it; the focused events are the slowest starts.`,
    });
  }
  const idle = gaps.filter(g => g.to - g.from >= 180_000);
  if (idle.length) {
    const longest = Math.max(...idle.map(g => g.to - g.from));
    add({
      key: 'idle', severity: longest >= 600_000 ? 'medium' : 'low', area: 'Time', ids: idle.map(g => g.nextId).filter(Boolean) as string[],
      title: `${plural(idle.length, 'gap')} with nothing recorded`,
      detail: `Longest ${duration(longest)}. Approvals, a stalled worker or harness overhead; the focused events are the ones that ended each gap.`,
    });
  }

  // ── Context ────────────────────────────────────────────────────────────────────────────────────
  const context: ContextPoint[] = [];
  let compacted = false;
  for (const event of events) {
    if (event.kind === 'compaction') { compacted = true; continue; }
    if (event.kind !== 'model' || event.inputTokens == null) continue;
    const cached = event.cacheReadTokens ?? 0, input = event.inputTokens;
    // Some workers count cached tokens inside input_tokens, others separately.
    const fresh = cached > input ? input : input - cached;
    context.push({ id: event.id, request: event.request ?? context.length + 1, at: event.startedAt, endedAt: event.endedAt ?? null, ttftMs: event.ttftMs ?? null,
      fresh, cached, output: event.outputTokens ?? 0, reasoning: event.reasoningTokens ?? null, compactedBefore: compacted });
    compacted = false;
  }
  const compactions = events.filter(e => e.kind === 'compaction');
  if (compactions.length) {
    add({
      key: 'compaction', severity: compactions.length >= 3 ? 'medium' : 'low', area: 'Context', ids: compactions.map(e => e.id),
      title: `Context compacted ${compactions.length}×`,
      detail: `Peak prompt ${num(stats.peakInputTokens)} tokens. Each compaction drops detail the agent may have to re-read; large tool outputs are the usual cause.`,
    });
  }
  const carry = analyzeCarry(context.map(p => ({ ...p, prompt: p.fresh + p.cached })));
  if (carry && carry.generated > 0 && carry.points.length >= 5) {
    const share = carry.reread / Math.max(1, carry.prompt), times = carry.reread / carry.generated;
    const what = carry.basis === 'reasoning' ? 'Reasoning' : 'Model output';
    if (share >= 0.1 && times >= 5) {
      const top = costliest(carry, 1)[0];
      add({
        key: 'carry', severity: carry.retention?.verdict === 'dropped' ? 'info' : share >= 0.25 ? 'medium' : 'low', area: 'Context',
        ids: costliest(carry).map(p => p.id),
        title: `${what} re-read ${Math.round(times)}× in later prompts`,
        detail: `${num(carry.generated)} ${carry.basis === 'reasoning' ? 'reasoning' : 'output'} tokens stayed in context; later prompts read them again for ${num(carry.reread)} tokens in total, ${Math.round(share * 100)}% of all prompt tokens.`
          + (top ? ` Early, long ${carry.basis === 'reasoning' ? 'reasoning' : 'output'} costs the most: request #${top.request} generated ${num(top.generated)} that ${plural(top.rereads, 'later request')} read again.` : '')
          + (carry.atCompaction ? ` At the first compaction it filled ${Math.round(carry.atCompaction.carried / Math.max(1, carry.atCompaction.prompt) * 100)}% of the prompt.` : '')
          + (carry.retention?.verdict === 'dropped' ? ' Prompts grew by less than the reasoning produced, so this provider appears to drop it: an upper bound.' : ''),
      });
    }
  }
  const mixPoints = context.map(p => ({ ...p, startedAt: p.at }));
  const mix = analyzePromptMix(events, mixPoints, carry, colorFor, OTHER_TOOLS);
  if (mix && mix.total > 0 && context.length >= 5) {
    const top = mix.heaviest[0];
    if (top && top.tokens * top.reads >= mix.total * 0.1) {
      add({
        key: 'heavy-result', severity: top.tokens * top.reads >= mix.total * 0.2 ? 'medium' : 'low', area: 'Context',
        ids: mix.heaviest.filter(h => h.tokens * h.reads >= mix.total * 0.05).map(h => h.id),
        title: `One ${top.tool} result was read again ${full(top.reads)}×`,
        detail: `About ${num(top.tokens)} tokens entered the context after request #${top.request}${top.shared > 1 ? ` (shared evenly by ${top.shared} calls in that step)` : ''}`
          + ` and every later request read them: ${num(top.tokens * top.reads)} tokens, ${Math.round(top.tokens * top.reads / mix.total * 100)}% of all prompt tokens.`
          + ' Trimming output before it enters the context (a line range, a narrower search, head/tail) saves it on every step after.',
      });
    }
    const heaviestTool = mix.slices.find(s => s.key.startsWith('tool:') && s.key !== 'tool:*');
    if (heaviestTool && heaviestTool.tokens >= mix.total * 0.35) {
      add({
        key: 'tool-share', severity: 'low', area: 'Context', ids: heaviestTool.ids,
        title: `${heaviestTool.label} results are ${Math.round(heaviestTool.tokens / mix.total * 100)}% of all prompt tokens`,
        detail: `${num(heaviestTool.tokens)} prompt tokens re-read results this tool returned, more than the model's own reasoning and replies. Shrinking those results moves the total more than lowering effort.`,
      });
    }
  }
  const cacheBreaks = findCacheBreaks(mixPoints);
  if (cacheBreaks && cacheBreaks.breaks.length && cacheBreaks.missed >= 10_000) {
    const { breaks, missed, ttft } = cacheBreaks, waits = breaks.filter(b => b.longWait);
    const promptTotal = context.reduce((n, p) => n + p.fresh + p.cached, 0);
    add({
      key: 'cache-break', severity: missed >= promptTotal * 0.1 ? 'medium' : 'low', area: 'Cache', ids: breaks.map(b => b.id),
      title: `Prompt cache missed ${plural(breaks.length, 'time')} mid-run`,
      detail: `${num(missed)} tokens the previous request had cached were processed again at the full input rate.`
        + (waits.length ? ` ${full(waits.length)} came after a wait over ${CACHE_TTL_MS / 60_000} minutes (longest ${duration(Math.max(...waits.map(b => b.gapMs!)))}), longer than a typical cache lifetime: long tool calls let it expire.` : '')
        + (waits.length < breaks.length ? ` The rest point to a changed prefix: edited earlier context, a model or setting change, or eviction by the provider.` : '')
        + (ttft && ttft.breaks > ttft.others * 1.2 ? ` Their first token took ${(ttft.breaks / ttft.others).toFixed(1)}× longer (median ${duration(ttft.breaks)} against ${duration(ttft.others)}).` : ''),
    });
  }
  if (stats.cacheHitRate != null && (stats.requests ?? 0) >= 5 && stats.cacheHitRate < 50) {
    add({
      key: 'cache', severity: stats.cacheHitRate < 25 ? 'medium' : 'low', area: 'Context', ids: [],
      title: `Prompt cache hit rate ${Math.round(stats.cacheHitRate)}%`,
      detail: 'Most of each prompt was processed from scratch. Changing early context (system prompt, injected files) invalidates the cache.',
    });
  }

  // ── Redundant calls ────────────────────────────────────────────────────────────────────────────
  const repeatMap = new Map<string, RepeatGroup>();
  for (const event of events) {
    const preview = previews?.get(event.id), key = callKey(event, preview);
    if (!key || isSleep(event, preview)) continue;
    const group = repeatMap.get(key) ?? { key, tool: event.label, text: preview!.text!.replace(/\s+/g, ' ').trim(), ids: [], failed: 0, ms: 0, tokens: null };
    const result = group.ids.length ? mix?.results.get(event.id) : null;
    if (result) group.tokens = (group.tokens ?? 0) + result.tokens * result.reads;
    group.ids.push(event.id);
    if (isFailed(event)) group.failed++;
    group.ms += spanOf(event, now) ?? 0;
    repeatMap.set(key, group);
  }
  const repeats = [...repeatMap.values()].filter(g => g.ids.length >= 3).sort((a, b) => b.ids.length - a.ids.length || b.ms - a.ms);
  const redundant = repeats.filter(g => g.ids.length >= 4);
  if (redundant.length) {
    const calls = redundant.reduce((n, g) => n + g.ids.length - 1, 0), tokens = redundant.reduce((n, g) => n + (g.tokens ?? 0), 0);
    add({
      key: 'repeats', severity: calls >= 30 ? 'medium' : 'low', area: 'Waste', ids: redundant.flatMap(g => g.ids),
      title: `${plural(calls, 'call')} repeated an earlier call`,
      detail: `${plural(redundant.length, 'call')} ran 4 or more times with the same input, e.g. ${redundant.slice(0, 2).map(g => `“${clip(g.text, 48)}” ×${g.ids.length}`).join(', ')}. A fix-and-rerun loop or a repeated status check; each run adds its output to the context again${tokens ? `, and the repeats alone put ${num(tokens)} tokens through later prompts` : ''}.`,
    });
  }

  if (run.trajectory.truncated) {
    add({ key: 'truncated', severity: 'info', area: 'Data', ids: [], title: 'Only the most recent 2,000 events are loaded',
      detail: 'Counts from the session totals are complete; lists and patterns cover the loaded events.' });
  }

  const order = new Map(events.map((e, i) => [e.id, i]));
  for (const finding of findings) finding.ids = [...new Set(finding.ids)].sort((a, b) => (order.get(a) ?? 0) - (order.get(b) ?? 0));
  findings.sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] || b.ids.length - a.ids.length);

  const slowest = events.filter(e => (e.kind === 'tool' || e.kind === 'model') && spanOf(e, now) != null)
    .sort((a, b) => (spanOf(b, now) ?? 0) - (spanOf(a, now) ?? 0)).slice(0, 8);

  const wanted = events.filter(needsPreview);
  const coverage = { loaded: wanted.filter(e => previews?.get(e.id)).length, total: wanted.length };

  return { wallMs, time, findings, errors, repeats, slowest, context, carry, mix, cacheBreaks, coverage };
}

export const eventMs = spanOf;
