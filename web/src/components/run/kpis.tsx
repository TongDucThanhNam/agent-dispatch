import { useMemo } from 'react';
import { ago, clock, duration, full, num, pct } from '@/lib/format';
import type { Run } from '@/lib/types';
import { cn } from '@/lib/utils';

interface Tile { label: string; value: string; sub?: string; title?: string; danger?: boolean; spark?: number[] }

export function Kpis({ run, now }: { run: Run; now: number }) {
  const t = run.trajectory, s = t.stats ?? {}, usage = run.usage ?? {};
  const end = run.endedAt ?? (run.active ? now : run.lastActivityAt ?? run.startedAt);
  const input = s.inputTokens ?? usage.inputTokens, output = s.outputTokens ?? usage.outputTokens;
  // Context size per model request shows how the conversation grew and where compactions cut it.
  const context = useMemo(() => t.events.filter(e => e.kind === 'model' && e.inputTokens != null).map(e => e.inputTokens as number), [t.events]);

  const tiles: Tile[] = [
    { label: 'Elapsed', value: duration(end - run.startedAt), sub: run.endedAt ? `ended ${clock(run.endedAt)}` : run.active ? `since ${clock(run.startedAt)}` : 'not recorded' },
    { label: 'Last activity', value: ago(run.lastActivityAt, now), sub: run.lastActivityAt ? clock(run.lastActivityAt) : undefined },
    { label: 'Requests', value: num(t.requests ?? usage.modelCalls), sub: s.avgTtftMs != null ? `avg TTFT ${duration(s.avgTtftMs)}` : t.turns != null ? `${t.turns} turns` : undefined,
      danger: Boolean(s.requestErrors), title: s.requestErrors ? `${s.requestErrors} request errors · ${s.retries ?? 0} retries` : undefined },
    { label: 'Tool calls', value: num(t.toolCalls), sub: s.toolErrors ? `${s.toolErrors} errors` : t.toolCalls ? 'no errors' : undefined, danger: Boolean(s.toolErrors) },
    { label: 'Tokens in / out', value: `${num(input)} / ${num(output)}`, sub: s.cacheHitRate != null ? `${pct(s.cacheHitRate)} cache hit` : undefined,
      title: `${full(input)} input · ${full(s.cacheReadTokens ?? usage.cacheReadTokens)} cached · ${full(output)} output` },
    { label: 'Peak context', value: num(s.peakInputTokens), sub: s.compactions ? `${s.compactions} compaction${s.compactions > 1 ? 's' : ''}` : 'largest request', spark: context },
  ];

  return (
    <div className="@container">
      <div className="grid grid-cols-2 gap-2 @lg:grid-cols-3 @3xl:grid-cols-6">
        {tiles.map(tile => (
          <div key={tile.label} className="relative overflow-hidden rounded-lg border bg-card px-3 py-2" title={tile.title}>
            <div className="text-[10.5px] font-medium tracking-wider text-muted-foreground uppercase">{tile.label}</div>
            <div className="mt-0.5 truncate text-[15px] leading-tight font-semibold tabular">{tile.value}</div>
            {tile.sub && <div className={cn('mt-0.5 truncate text-[11px]', tile.danger ? 'text-destructive' : 'text-muted-foreground')}>{tile.sub}</div>}
            {tile.spark && tile.spark.length > 1 && <Sparkline values={tile.spark} />}
          </div>
        ))}
      </div>
    </div>
  );
}

function Sparkline({ values }: { values: number[] }) {
  const max = Math.max(...values, 1), w = 100, h = 24;
  const points = values.map((v, i) => `${(i / (values.length - 1)) * w},${h - (v / max) * (h - 2) - 1}`).join(' ');
  return (
    <svg viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" aria-hidden className="pointer-events-none absolute right-2 bottom-2 h-6 w-[45%] text-kind-model opacity-70">
      <polygon points={`0,${h} ${points} ${w},${h}`} className="fill-current opacity-15" />
      <polyline points={points} fill="none" stroke="currentColor" strokeWidth="1.25" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}
