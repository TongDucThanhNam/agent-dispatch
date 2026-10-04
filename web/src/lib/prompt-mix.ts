// Where the prompt tokens come from, and where the prompt cache broke. Every request re-reads its whole prompt, so a
// token that enters the context at request j is processed once by each later request until a compaction. Splitting
// each prompt's growth between requests into what the model wrote and what the tools returned attributes all of
// Σ prompt to its sources: the starting context, earlier reasoning, earlier replies, each tool's results.

import type { Carry } from './carry';
import type { TrajectoryEvent } from './types';

/** A model request with a recorded prompt, as the context analysis sees it. */
export interface MixPoint {
  id: string;
  request: number;
  fresh: number;
  cached: number;
  output: number;
  reasoning: number | null;
  compactedBefore: boolean;
  startedAt: number;
  endedAt: number | null;
  ttftMs: number | null;
}

export interface PromptSlice { key: string; label: string; tokens: number; color: string; hint: string; ids: string[] }
/** A tool call's result: tokens it added to the context, and how many later requests read them. */
export interface HeavyResult { id: string; tool: string; request: number; tokens: number; reads: number; shared: number; truncatedFrom: number | null }

export interface PromptMix {
  /** Prompt tokens the run processed (Σ prompt). */
  total: number;
  slices: PromptSlice[];
  heaviest: HeavyResult[];
  /** Tokens the harness or provider removed between requests (cleared tool results, dropped reasoning), times the reads they saved. */
  pruned: number;
  /** Every tool call's result, by event ID. */
  results: Map<string, HeavyResult>;
  first: number;
  last: number;
}

const prompt = (p: MixPoint) => p.fresh + p.cached;
// Workers count reasoning inside output (OpenAI, Anthropic) or beside it; reasoning larger than output must be beside it.
const visibleOf = (p: MixPoint) => { const r = p.reasoning ?? 0; return r > p.output ? p.output : p.output - r; };

/**
 * `colorFor` gives a tool its colour (shared with the time breakdown so a tool keeps one colour), or null once the
 * palette is used up, in which case it joins "other tools".
 */
export function analyzePromptMix(events: TrajectoryEvent[], points: MixPoint[], carry: Carry | null, colorFor: (tool: string) => string | null,
  otherColor = 'var(--muted)'): PromptMix | null {
  if (points.length < 2) return null;
  const reasoningBasis = carry?.basis === 'reasoning';
  const keepsReasoning = reasoningBasis && carry?.retention?.verdict !== 'dropped';

  // Tool calls and injected context recorded after request i (and before i + 1) feed prompt i + 1.
  const index = new Map(points.map((p, i) => [p.id, i]));
  const tools: TrajectoryEvent[][] = points.map(() => []), injected: string[][] = points.map(() => []);
  let current = -1;
  for (const event of events) {
    const i = index.get(event.id);
    if (i != null) { current = i; continue; }
    if (current < 0) continue;
    if (event.kind === 'tool') tools[current].push(event);
    else if (event.kind === 'context' || event.kind === 'input' || event.kind === 'compaction') injected[current].push(event.id);
  }

  const sums = new Map<string, { tokens: number; ids: string[] }>();
  const add = (key: string, tokens: number, id?: string) => {
    if (tokens <= 0) return;
    const sum = sums.get(key) ?? { tokens: 0, ids: [] };
    sum.tokens += tokens;
    if (id && sum.ids.at(-1) !== id) sum.ids.push(id);
    sums.set(key, sum);
  };
  const heavy: HeavyResult[] = [];
  let pruned = 0;

  let start = 0;
  for (let end = 1; end <= points.length; end++) {
    if (end < points.length && !points[end].compactedBefore) continue;
    // Segment [start, end): the first prompt is read by every request in it; each later delta by those after it.
    const last = end - 1;
    add('base', prompt(points[start]) * (end - start), points[start].id);
    for (let j = start; j < last; j++) {
      const p = points[j], reads = last - j;
      const reasoning = keepsReasoning ? p.reasoning ?? 0 : 0, visible = reasoningBasis ? visibleOf(p) : p.output;
      add('reasoning', reasoning * reads, p.id);
      add('output', visible * reads, p.id);
      const added = prompt(points[j + 1]) - prompt(p) - reasoning - visible;
      if (added < 0) { pruned -= added * reads; continue; }
      if (!tools[j].length) { add('context', added * reads, injected[j][0] ?? points[j + 1].id); continue; }
      const share = added / tools[j].length;
      for (const tool of tools[j]) {
        add(`tool:${tool.label}`, share * reads, tool.id);
        heavy.push({ id: tool.id, tool: tool.label, request: p.request, tokens: share, reads, shared: tools[j].length, truncatedFrom: tool.truncatedFrom ?? null });
      }
    }
    start = end;
  }

  const slices: PromptSlice[] = [];
  const fixed: [string, string, string, string][] = [
    ['base', 'Starting context', 'color-mix(in oklch, var(--muted-foreground) 60%, transparent)', 'System prompt, tool definitions and the brief (or the summary after a compaction), read by every request'],
    ['reasoning', 'Earlier reasoning', 'var(--kind-reasoning)', 'Reasoning from earlier requests, still in the context'],
    ['output', reasoningBasis ? 'Earlier replies and tool calls' : 'Earlier model output', 'var(--kind-model)',
      reasoningBasis ? 'Text and tool-call arguments the model wrote earlier' : 'Everything the model wrote earlier: reasoning, text and tool-call arguments'],
    ['context', 'Injected context', 'color-mix(in oklch, var(--muted-foreground) 25%, transparent)', 'Growth with no tool call behind it: reminders, user messages and other harness context'],
  ];
  for (const [key, label, color, hint] of fixed) {
    const sum = sums.get(key);
    if (sum) slices.push({ key, label, tokens: sum.tokens, color, hint, ids: sum.ids });
  }
  const byTool = [...sums].filter(([key]) => key.startsWith('tool:')).sort((a, b) => b[1].tokens - a[1].tokens);
  const other = { tokens: 0, ids: [] as string[], names: [] as string[] };
  for (const [key, sum] of byTool) {
    const color = colorFor(key.slice(5));
    if (color) slices.push({ key, label: key.slice(5), tokens: sum.tokens, color, hint: 'Results this tool returned, read by every later request', ids: sum.ids });
    else { other.tokens += sum.tokens; other.ids.push(...sum.ids); other.names.push(key.slice(5)); }
  }
  if (other.tokens > 0) {
    slices.push({ key: 'tool:*', label: `${other.names.length} other tools`, tokens: other.tokens, color: otherColor,
      hint: other.names.join(', '), ids: other.ids });
  }
  slices.sort((a, b) => b.tokens - a.tokens);

  return {
    total: points.reduce((n, p) => n + prompt(p), 0), slices, pruned, results: new Map(heavy.map(h => [h.id, h])),
    heaviest: heavy.filter(h => h.tokens >= 500).sort((a, b) => b.tokens * b.reads - a.tokens * a.reads).slice(0, 6),
    first: prompt(points[0]), last: prompt(points.at(-1)!),
  };
}

export interface CacheBreak { id: string; request: number; missed: number; gapMs: number | null; ttftMs: number | null; longWait: boolean }
export interface CacheBreaks { breaks: CacheBreak[]; missed: number; ttft: { breaks: number; others: number } | null }

/** Below this a prefix may be too short to cache at all (the minimum is 1–4K tokens depending on the model). */
const CACHEABLE = 4096;
/** The default prompt-cache lifetime on the Claude API; OpenAI keeps prefixes for a similar few minutes or longer. */
export const CACHE_TTL_MS = 5 * 60_000;

const median = (values: number[]) => { const sorted = [...values].sort((a, b) => a - b); return sorted[sorted.length >> 1]; };

/**
 * Requests that re-processed a prefix the previous request had cached. Only meaningful when caching normally works
 * in this run; a run that never caches is a hit-rate problem, not a break.
 */
export function findCacheBreaks(points: MixPoint[]): CacheBreaks | null {
  const pairs = points.slice(1).map((p, k) => [points[k], p] as const)
    .filter(([previous, p]) => !p.compactedBefore && prompt(previous) >= CACHEABLE);
  if (pairs.length < 4) return null;
  const hit = ([previous, p]: readonly [MixPoint, MixPoint]) => p.cached / Math.min(prompt(previous), prompt(p)) >= 0.5;
  if (pairs.filter(hit).length < pairs.length * 0.6) return null;
  const breaks: CacheBreak[] = pairs.filter(pair => !hit(pair)).map(([previous, p]) => {
    const gapMs = previous.endedAt != null ? Math.max(0, p.startedAt - previous.endedAt) : null;
    return { id: p.id, request: p.request, missed: Math.max(0, Math.min(prompt(previous), prompt(p)) - p.cached), gapMs, ttftMs: p.ttftMs,
      longWait: gapMs != null && gapMs >= CACHE_TTL_MS };
  });
  const broken = new Set(breaks.map(b => b.id));
  const ttftOf = (ps: MixPoint[]) => ps.map(p => p.ttftMs).filter((ms): ms is number => ms != null && ms > 0);
  const slow = ttftOf(pairs.filter(([, p]) => broken.has(p.id)).map(([, p]) => p)), normal = ttftOf(pairs.filter(([, p]) => !broken.has(p.id)).map(([, p]) => p));
  return {
    breaks, missed: breaks.reduce((n, b) => n + b.missed, 0),
    ttft: slow.length && normal.length >= 3 ? { breaks: median(slow), others: median(normal) } : null,
  };
}
