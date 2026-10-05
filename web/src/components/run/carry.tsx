import { useState } from 'react';
import { CircleCheck, Info, TriangleAlert } from 'lucide-react';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { projectCarry, type Carry } from '@/lib/carry';
import { full, num } from '@/lib/format';
import { cn } from '@/lib/utils';
import { Heading } from './parts';

const SCALES = [['0.25', '×¼'], ['0.5', '×½'], ['1', '×1'], ['2', '×2'], ['4', '×4']] as const;
const signed = (value: number) => `${value < 0 ? '−' : '+'}${num(Math.abs(value))}`;
const amplification = (times: number) => times >= 10 ? String(Math.round(times)) : times.toFixed(1);

/**
 * Generated tokens against the prompt tokens that read them again, accumulated over the run. Per request the
 * generation looks linear; the re-reads grow with the square of the request count until a compaction resets them.
 */
export function ReasoningCarry({ carry, onSelect }: { carry: Carry; onSelect: (id: string) => void }) {
  const [scale, setScale] = useState(1);
  const [hover, setHover] = useState<number | null>(null);
  const { points } = carry, n = points.length, last = points[n - 1];
  const word = carry.basis === 'reasoning' ? 'reasoning' : 'output';
  const times = carry.generated ? carry.reread / carry.generated : 0;
  const max = Math.max(1, last.rereadSoFar, last.generatedSoFar) * Math.max(1, scale);
  const y = (value: number) => 100 - value / max * 100;
  const line = (pick: (i: number) => number) => points.map((_, i) => `${i ? 'L' : 'M'}${i + 0.5},${y(pick(i))}`).join('');
  const reread = line(i => points[i].rereadSoFar), generated = line(i => points[i].generatedSoFar);
  const shown = hover != null ? points[hover] : null;
  const projected = scale !== 1 ? projectCarry(carry, scale) : null;
  const peakShare = carry.peak.prompt ? carry.peak.carried / carry.peak.prompt : 0;

  return (
    <>
      <Heading aside={carry.basis === 'reasoning' ? 'reasoning tokens reported by the worker' : 'reasoning not reported separately: all model output'}>
        {carry.basis === 'reasoning' ? 'Reasoning carry-over' : 'Output carry-over'}
      </Heading>
      <div className="rounded-lg border px-2.5 pt-2 pb-1.5">
        <div className="grid grid-cols-2 gap-x-3 gap-y-1.5 @xl:grid-cols-4">
          <Figure label="Generated" value={num(carry.generated)} sub={`${word} tokens, once`} />
          <Figure label="Re-read later" value={num(carry.reread)} sub={`${Math.round(carry.reread / Math.max(1, carry.prompt) * 100)}% of prompt tokens`} />
          <Figure label="Amplification" value={`×${amplification(times)}`} sub="reads per generated token" />
          <Figure label="Peak carried" value={num(carry.peak.carried)} sub={`${Math.round(peakShare * 100)}% of prompt #${carry.peak.request}`} />
        </div>
        <svg viewBox={`0 0 ${n} 100`} preserveAspectRatio="none" className="mt-2 block h-28 w-full cursor-pointer" role="img"
          aria-label={`Cumulative ${word} tokens: ${full(carry.generated)} generated, ${full(carry.reread)} read again by later prompts over ${n} requests`}
          onMouseMove={e => { const r = e.currentTarget.getBoundingClientRect(); setHover(Math.min(n - 1, Math.max(0, Math.floor((e.clientX - r.left) / r.width * n)))); }}
          onMouseLeave={() => setHover(null)} onClick={() => { if (hover != null) onSelect(points[hover].id); }}>
          {[25, 50, 75].map(at => <line key={at} x1={0} x2={n} y1={at} y2={at} stroke="var(--border)" strokeWidth={1} vectorEffect="non-scaling-stroke" />)}
          {hover != null && <rect x={hover} width={1} y={0} height={100} fill="var(--foreground)" opacity={0.07} />}
          {points.map((p, i) => p.compactedBefore && (
            <line key={`c${p.id}`} x1={i} x2={i} y1={0} y2={100} stroke="var(--kind-compaction)" strokeWidth={1.5} strokeDasharray="3 2" vectorEffect="non-scaling-stroke" />
          ))}
          <path d={`${reread}L${n - 0.5},100L0.5,100Z`} fill="color-mix(in oklch, var(--kind-reasoning) 18%, transparent)" />
          {projected && (
            <>
              <path d={line(i => points[i].rereadSoFar * scale)} fill="none" stroke="var(--kind-reasoning)" strokeWidth={1.5} strokeDasharray="4 3" vectorEffect="non-scaling-stroke" />
              <path d={line(i => points[i].generatedSoFar * scale)} fill="none" stroke="var(--muted-foreground)" strokeWidth={1.5} strokeDasharray="4 3" vectorEffect="non-scaling-stroke" />
            </>
          )}
          <path d={reread} fill="none" stroke="var(--kind-reasoning)" strokeWidth={2} strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
          <path d={generated} fill="none" stroke="var(--muted-foreground)" strokeWidth={2} strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
        </svg>
        <div className="mt-1 flex min-h-4 items-center gap-3 text-[10.5px] text-muted-foreground tabular">
          {shown ? (
            <span className="truncate">
              <span className="font-medium text-foreground">Request #{shown.request}</span> · {full(shown.generatedSoFar)} generated · {full(shown.rereadSoFar)} re-read so far
              · this prompt carries {full(shown.carried)}{shown.prompt ? ` (${Math.round(shown.carried / shown.prompt * 100)}%)` : ''}
            </span>
          ) : (
            <>
              <span className="flex items-center gap-1"><i className="h-0.5 w-2.5 rounded-full bg-muted-foreground" />generated</span>
              <span className="flex items-center gap-1"><i className="h-2 w-2.5 rounded-[2px] border-t-2 border-kind-reasoning bg-kind-reasoning/20" />re-read by later prompts</span>
              {projected && <span className="flex items-center gap-1"><i className="w-2.5 border-t border-dashed border-muted-foreground" />×{scale}</span>}
              <span className="ml-auto">cumulative · #{points[0].request} → #{last.request}</span>
            </>
          )}
        </div>
      </div>

      <div className="mt-2 rounded-lg border px-2.5 py-2 text-[11.5px]">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span className="text-muted-foreground">If every request {carry.basis === 'reasoning' ? 'reasoned' : 'generated'}</span>
          <ToggleGroup type="single" size="sm" spacing={1} value={String(scale)} onValueChange={value => value && setScale(Number(value))} aria-label={`Scale ${word} per request`}>
            {SCALES.map(([value, label]) => <ToggleGroupItem key={value} value={value} className="h-6 min-w-0 px-1.5 text-[11px] tabular">{label}</ToggleGroupItem>)}
          </ToggleGroup>
          <span className="ml-auto text-[11px] text-muted-foreground tabular">
            ≈ {full(Math.round(carry.generated / n))}{projected ? ` → ${full(Math.round(carry.generated / n * scale))}` : ''} per request
          </span>
        </div>
        {projected ? (
          <dl className="mt-1.5 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 tabular">
            <dt className="text-muted-foreground">Per-request view</dt>
            <dd>{signed(projected.generated)} {word} tokens</dd>
            <dt className="text-muted-foreground">With carry-over</dt>
            <dd><span className="font-medium">{signed(projected.reread)}</span> prompt tokens read again <span className="text-muted-foreground">(×{amplification(times)} the per-request view)</span></dd>
            <dt className="text-muted-foreground">Peak prompt</dt>
            <dd>{num(Math.max(...points.map(p => p.prompt)))} → {num(projected.peakPrompt)}</dd>
          </dl>
        ) : (
          <p className="mt-1.5 leading-relaxed text-muted-foreground">
            A token generated at one request is read again by every later request until a compaction, so {full(n)} requests read
            it up to {full(n - 1)} more times: the re-reads grow with the square of the request count while the generation grows linearly.
            Pick a multiplier to see what a different effort level would have cost on this same trajectory.
          </p>
        )}
        {projected && <p className="mt-1.5 text-[11px] text-muted-foreground">Holds the trajectory fixed. A real effort change also changes how many steps the agent takes, which can move the total either way.</p>}
      </div>
      <Retention carry={carry} />
    </>
  );
}

function Figure({ label, value, sub }: { label: string; value: string; sub: string }) {
  return (
    <div className="min-w-0">
      <div className="text-[10px] tracking-wider text-muted-foreground uppercase">{label}</div>
      <div className="text-[15px] leading-tight font-medium tabular">{value}</div>
      <div className="truncate text-[10.5px] text-muted-foreground" title={sub}>{sub}</div>
    </div>
  );
}

/** What the prompt sizes say about whether the worker keeps reasoning in context. */
function Retention({ carry }: { carry: Carry }) {
  const verdict = carry.retention?.verdict;
  const [Icon, tone, text] = carry.basis === 'output'
    ? [Info, 'text-muted-foreground', 'This worker reports thinking inside output tokens, so these figures cover all model output: reasoning, text and tool-call arguments, all of which stay in context until a compaction.']
    : verdict === 'kept'
      ? [CircleCheck, 'text-success', 'Prompts grew enough to hold all of it, consistent with the worker keeping reasoning in context.']
      : verdict === 'partial'
        ? [TriangleAlert, 'text-warning', `Prompts grew by less than the reasoning produced: about ${Math.round(carry.retention!.share * 100)}% looks kept, so the re-read figures are an upper bound.`]
        : verdict === 'dropped'
          ? [TriangleAlert, 'text-warning', 'Prompts grew by less than the reasoning produced: this provider appears to drop earlier reasoning, so it costs output and latency but does not compound. The re-read figures are an upper bound.']
          : [Info, 'text-muted-foreground', 'Too little reasoning to check from prompt sizes whether the worker keeps it in context; the figures assume it does.'];
  return (
    <div className="mt-1.5 space-y-1 text-[11px] leading-relaxed text-muted-foreground">
      <p className="flex gap-1.5"><Icon className={cn('mt-0.5 size-3 shrink-0', tone)} aria-hidden />{text}</p>
      <p className="pl-[18px]">Re-reads usually hit the prompt cache and bill at the cache-read rate, but they fill the context window at full size, which is what triggers compaction.</p>
    </div>
  );
}
