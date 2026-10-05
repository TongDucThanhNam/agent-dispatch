// Reasoning carry-over. A token the model generates stays in the conversation, so every later request in the same
// context reads it again: per request the cost looks linear (N × r), but the run processes about r × N²/2.
// Computed from per-request usage alone, so it works against any hub version and any worker that reports tokens.

/** One model request with a recorded prompt size, in trajectory order. */
export interface CarryInput {
  id: string;
  request: number;
  /** Full prompt size: cached plus new input tokens. */
  prompt: number;
  output: number;
  reasoning: number | null;
  compactedBefore: boolean;
}

export interface CarryPoint {
  id: string;
  request: number;
  prompt: number;
  /** Tokens this request generated that later prompts carry: its reasoning, or all output when reasoning is not reported. */
  generated: number;
  /** Earlier requests' generated tokens still in this prompt (since the last compaction), at most the prompt itself. */
  carried: number;
  /** Later requests in the same context, each of which reads this request's generated tokens again. */
  rereads: number;
  generatedSoFar: number;
  rereadSoFar: number;
  compactedBefore: boolean;
}

/** `reasoning` when the worker reports reasoning tokens; `output` when it only reports output (thinking included). */
export type CarryBasis = 'reasoning' | 'output';

export interface Carry {
  basis: CarryBasis;
  points: CarryPoint[];
  generated: number;
  /** Generated tokens read again by later prompts, summed over every request. */
  reread: number;
  /** All prompt tokens the run processed. */
  prompt: number;
  /** The request whose prompt carried the most earlier generated tokens. */
  peak: CarryPoint;
  /** The prompt just before the first compaction, and how much of it was carried generation. */
  atCompaction: { request: number; prompt: number; carried: number } | null;
  /**
   * Whether prompts grew enough to hold the reasoning (reasoning basis only). Growth can come from tool output too,
   * so `kept` is consistency, not proof; `dropped` means the provider (or harness) removed earlier reasoning.
   */
  retention: { verdict: 'kept' | 'partial' | 'dropped'; share: number } | null;
}

// Workers count reasoning inside output (OpenAI, Anthropic) or beside it; reasoning larger than output must be beside it.
const visibleOf = (input: CarryInput) => {
  const reasoning = input.reasoning ?? 0;
  return reasoning > input.output ? input.output : input.output - reasoning;
};

export function analyzeCarry(inputs: CarryInput[]): Carry | null {
  if (inputs.length < 2) return null;
  const basis: CarryBasis | null = inputs.some(p => (p.reasoning ?? 0) > 0) ? 'reasoning' : inputs.some(p => p.output > 0) ? 'output' : null;
  if (!basis) return null;
  const generatedOf = (input: CarryInput) => basis === 'reasoning' ? input.reasoning ?? 0 : input.output;

  // A compaction replaces the history with a summary, so carried generation starts again from zero.
  const segments: CarryInput[][] = [];
  for (const input of inputs) {
    if (input.compactedBefore || !segments.length) segments.push([]);
    segments.at(-1)!.push(input);
  }

  const points: CarryPoint[] = [];
  let generatedSoFar = 0, rereadSoFar = 0, grown = 0, visible = 0, reasoning = 0;
  for (const segment of segments) {
    let carried = 0;
    segment.forEach((input, i) => {
      const generated = generatedOf(input), inPrompt = Math.min(carried, input.prompt);
      generatedSoFar += generated; rereadSoFar += inPrompt;
      points.push({ id: input.id, request: input.request, prompt: input.prompt, generated, carried: inPrompt, rereads: segment.length - 1 - i,
        generatedSoFar, rereadSoFar, compactedBefore: input.compactedBefore });
      carried += generated;
    });
    if (segment.length > 1) {
      grown += segment.at(-1)!.prompt - segment[0].prompt;
      for (const input of segment.slice(0, -1)) { visible += visibleOf(input); reasoning += input.reasoning ?? 0; }
    }
  }

  let retention: Carry['retention'] = null;
  if (basis === 'reasoning' && reasoning >= 500) {
    const share = Math.min(1, Math.max(0, (grown - visible) / reasoning));
    retention = { verdict: share >= 0.9 ? 'kept' : share >= 0.5 ? 'partial' : 'dropped', share };
  }

  const firstCompaction = points.findIndex(p => p.compactedBefore);
  const before = firstCompaction > 0 ? points[firstCompaction - 1] : null;
  return {
    basis, points, generated: generatedSoFar, reread: rereadSoFar,
    prompt: inputs.reduce((n, p) => n + p.prompt, 0),
    peak: points.reduce((best, p) => (p.carried > best.carried ? p : best), points[0]),
    atCompaction: before ? { request: before.request, prompt: before.prompt, carried: before.carried + before.generated } : null,
    retention,
  };
}

/**
 * What the run would have processed had every request generated `scale` times as much, with the trajectory held
 * fixed (same requests, same tool output). A real effort change also changes how many steps the agent takes.
 */
export function projectCarry(carry: Carry, scale: number) {
  const k = scale - 1;
  return {
    /** The extra generation: what the per-request number suggests. */
    generated: carry.generated * k,
    /** The extra prompt tokens later requests read. */
    reread: carry.reread * k,
    peakPrompt: Math.max(...carry.points.map(p => p.prompt + k * p.carried)),
  };
}

/** Requests whose generated tokens were read again the most, highest first. */
export const costliest = (carry: Carry, limit = 5) => carry.points.filter(p => p.generated > 0 && p.rereads > 0)
  .sort((a, b) => b.generated * b.rereads - a.generated * a.rereads).slice(0, limit);
