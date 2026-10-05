import { useEffect, useMemo, useState } from 'react';
import {
  createColumnHelper, createSortedRowModel, rowSortingFeature, sortFn_basic, sortFn_text, tableFeatures, useTable,
} from '@tanstack/react-table';
import { ArrowDown, ArrowUp, CircleCheck, Crosshair, Info, Loader2, OctagonAlert, TriangleAlert, type LucideIcon } from 'lucide-react';
import { KindChip } from '@/components/kind-chip';
import { Button } from '@/components/ui/button';
import type { Carry } from '@/lib/carry';
import type { CacheBreaks, PromptMix } from '@/lib/prompt-mix';
import { duration, full, num } from '@/lib/format';
import { computeInsights, eventMs, needsPreview, type ContextPoint, type Finding, type Severity } from '@/lib/insights';
import { eventName, isFailed } from '@/lib/status';
import type { EventFocus, Run, ToolStat } from '@/lib/types';
import { usePreviewVersion, type PreviewStore } from '@/lib/use-previews';
import { useNow } from '@/lib/use-snapshot';
import { cn } from '@/lib/utils';
import { ReasoningCarry } from './carry';
import { Heading } from './parts';

type OnFocus = (focus: EventFocus | null) => void;

const SEVERITY: Record<Severity, { icon: LucideIcon; label: string; icon_: string; card: string }> = {
  high: { icon: OctagonAlert, label: 'High', icon_: 'text-destructive', card: 'border-destructive/30 bg-destructive/[0.04]' },
  medium: { icon: TriangleAlert, label: 'Medium', icon_: 'text-warning', card: 'border-warning/30 bg-warning/[0.04]' },
  low: { icon: Info, label: 'Low', icon_: 'text-info', card: '' },
  info: { icon: Info, label: 'Note', icon_: 'text-muted-foreground', card: 'border-dashed' },
};

/** Diagnostics for auditing the run: findings first, then the breakdowns they come from. */
export function InsightsPanel({ run, previews, onFocus, onSelect }: {
  run: Run; previews: PreviewStore | null; onFocus: OnFocus; onSelect: (id: string) => void;
}) {
  const events = run.trajectory.events;
  // Error text and call inputs come from the one-line previews; read them for every call, not just visible rows.
  const version = usePreviewVersion(previews);
  const now = useNow(5000, run.active);
  useEffect(() => { previews?.request(events.filter(needsPreview), false); }, [previews, events, now]);
  const tick = run.active ? Math.floor(now / 5000) : 0;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const insights = useMemo(() => computeInsights(run, previews, now), [run, previews, version, tick]);
  const focus = (label: string, ids: string[]) => { if (ids.length === 1) onSelect(ids[0]); else if (ids.length) onFocus({ label, ids: new Set(ids) }); };
  const { findings, time, errors, repeats, slowest, context, carry, mix, cacheBreaks, coverage, wallMs } = insights;
  const reading = coverage.loaded < coverage.total;

  if (!events.length) {
    return <p className="py-10 text-center text-xs text-muted-foreground">{run.active ? 'Insights appear once the worker records events.' : 'No trajectory was recorded for this run.'}</p>;
  }

  return (
    <div className="@container">
      <Heading aside={reading ? undefined : `${full(events.length)} events · ${duration(wallMs)}`}>Findings</Heading>
      {reading && (
        <div className="mb-2 flex items-center gap-2 text-[11px] text-muted-foreground" role="status">
          <Loader2 className="size-3 animate-spin" aria-hidden />
          Reading call details {full(coverage.loaded)} / {full(coverage.total)}
          <span className="h-1 flex-1 overflow-hidden rounded-full bg-muted">
            <span className="block h-full rounded-full bg-brand/60 transition-[width]" style={{ width: `${coverage.loaded / Math.max(1, coverage.total) * 100}%` }} />
          </span>
        </div>
      )}
      {findings.length ? (
        <div className="space-y-2">
          {findings.map(finding => <FindingCard key={finding.key} finding={finding} onShow={() => focus(finding.title, finding.ids)} />)}
        </div>
      ) : (
        <div className="flex items-center gap-2 rounded-lg border px-3 py-2.5 text-[12px] text-muted-foreground">
          <CircleCheck className="size-3.5 text-success" aria-hidden />
          {reading ? 'Nothing stands out so far.' : 'Nothing stands out: no repeated failures, long waits or redundant calls.'}
        </div>
      )}

      {time.length > 0 && wallMs > 0 && (
        <>
          <Heading aside={`${duration(wallMs)} wall time`}>Where the time went</Heading>
          <Breakdown slices={time} value={slice => slice.ms} format={duration} onFocus={slice => focus(slice.key.startsWith('tool:') ? `${slice.label} calls` : slice.label, slice.ids)} />
        </>
      )}

      {errors.length > 0 && (
        <>
          <Heading aside={`${full(errors.reduce((n, g) => n + g.ids.length, 0))} failed events`}>Error patterns</Heading>
          <div className="divide-y overflow-hidden rounded-lg border">
            {errors.slice(0, 8).map(group => (
              <div key={group.key} className="py-1">
                <button type="button" onClick={() => focus(`${group.tool}: ${group.title}`, group.ids)}
                  className="flex w-full items-baseline gap-2 px-3 py-1 text-left hover:bg-accent/60">
                  <span className="shrink-0 font-mono text-[11px] text-muted-foreground">{group.tool}</span>
                  <span className="min-w-0 flex-1 truncate text-[12px] font-medium text-destructive" title={group.title}>{group.title}</span>
                  <span className="shrink-0 text-[11px] tabular">×{group.ids.length}</span>
                </button>
                {group.variants.filter(v => v.text).slice(0, 3).map(variant => (
                  <button key={variant.text} type="button" onClick={() => focus(`${group.tool}: ${variant.text}`, variant.ids)}
                    className="flex w-full items-baseline gap-2 py-0.5 pr-3 pl-6 text-left hover:bg-accent/60">
                    <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-muted-foreground" title={variant.text}>{variant.text}</span>
                    <span className="shrink-0 text-[10.5px] text-muted-foreground tabular">×{variant.ids.length}</span>
                  </button>
                ))}
              </div>
            ))}
          </div>
          {errors.length > 8 && <p className="mt-1 text-[11px] text-muted-foreground">+{errors.length - 8} rarer error kinds</p>}
        </>
      )}

      {repeats.length > 0 && (
        <>
          <Heading aside="same tool, same input">Repeated calls</Heading>
          <div className="divide-y overflow-hidden rounded-lg border">
            {repeats.slice(0, 8).map(group => (
              <button key={group.key} type="button" onClick={() => focus(`${group.tool} ×${group.ids.length}: ${group.text}`, group.ids)}
                className="flex w-full items-baseline gap-2 px-3 py-1.5 text-left hover:bg-accent/60">
                <span className="shrink-0 font-mono text-[11px] text-muted-foreground">{group.tool}</span>
                <span className="min-w-0 flex-1 truncate font-mono text-[11.5px]" title={group.text}>{group.text}</span>
                {group.failed > 0 && <span className="shrink-0 text-[10.5px] text-destructive tabular">{group.failed} failed</span>}
                {group.tokens != null && group.tokens >= 1000 && (
                  <span className="shrink-0 text-[10.5px] text-muted-foreground tabular" title="Prompt tokens the repeats put through later requests">{num(group.tokens)} tok</span>
                )}
                <span className="shrink-0 text-[11px] font-medium tabular">×{group.ids.length}</span>
              </button>
            ))}
          </div>
        </>
      )}

      {slowest.length > 0 && (
        <>
          <Heading>Slowest steps</Heading>
          <div className="space-y-px">
            {slowest.map(event => {
              const ms = eventMs(event, now) ?? 0, max = eventMs(slowest[0], now) || 1, preview = previews?.get(event.id)?.text;
              return (
                <button key={event.id} type="button" onClick={() => onSelect(event.id)}
                  className="relative flex w-full items-center gap-2 overflow-hidden rounded-md px-1.5 py-1 text-left text-[12px] hover:bg-accent/60">
                  <span className="absolute inset-y-0 left-0 bg-foreground/[0.045]" style={{ width: `${ms / max * 100}%` }} aria-hidden />
                  <KindChip kind={event.kind} error={isFailed(event)} compact className="relative" />
                  <span className="relative min-w-0 flex-1 truncate">
                    <span className="font-medium">{eventName(event)}</span>
                    {preview && <span className="text-muted-foreground"> · {preview}</span>}
                  </span>
                  <span className="relative shrink-0 text-muted-foreground tabular">{duration(ms)}</span>
                </button>
              );
            })}
          </div>
        </>
      )}

      {context.length > 1 && <ContextGrowth points={context} carry={carry} breaks={cacheBreaks} onSelect={onSelect} />}
      {mix && mix.total > 0 && <InputMix mix={mix} previews={previews} onFocus={focus} onSelect={onSelect} />}
      {carry && carry.generated > 0 && <ReasoningCarry carry={carry} onSelect={onSelect} />}

      {(run.trajectory.stats?.tools?.length ?? 0) > 0 && (
        <>
          <Heading aside={`${full(run.trajectory.toolCalls)} calls${run.trajectory.stats?.toolErrors ? ` · ${run.trajectory.stats.toolErrors} errors` : ''} · time summed, overlaps counted twice`}>Tools</Heading>
          <ToolsTable tools={run.trajectory.stats!.tools!} onPick={name => focus(`${name} calls`, events.filter(e => e.kind === 'tool' && e.label === name).map(e => e.id))} />
        </>
      )}
      <p className="mt-5 text-[11px] text-muted-foreground">
        Computed in the browser from the trajectory and call previews. Click a row to show its events in the trajectory.
      </p>
    </div>
  );
}

interface Slice { key: string; label: string; color: string; hint: string; ids: string[] }

/** A whole split into labelled slices: a stacked bar, then one row per slice. Rows with events focus them. */
function Breakdown<T extends Slice>({ slices, value, format, onFocus }: {
  slices: T[]; value: (slice: T) => number; format: (value: number) => string; onFocus: (slice: T) => void;
}) {
  const total = slices.reduce((n, slice) => n + value(slice), 0) || 1;
  return (
    <>
      <div className="flex h-2.5 overflow-hidden rounded-full bg-muted" aria-hidden>
        {slices.map(slice => <i key={slice.key} className="h-full border-r border-background/60 last:border-0" style={{ width: `${value(slice) / total * 100}%`, background: slice.color }} />)}
      </div>
      <ul className="mt-1.5">
        {slices.map(slice => {
          const share = value(slice) / total * 100, clickable = slice.ids.length > 0;
          return (
            <li key={slice.key}>
              <button type="button" disabled={!clickable} onClick={() => onFocus(slice)}
                title={slice.hint} className="group flex w-full items-center gap-2 rounded-md px-1.5 py-1 text-left text-[12px] enabled:hover:bg-accent/60">
                <span className="size-2.5 shrink-0 rounded-[3px]" style={{ background: slice.color }} />
                <span className={cn('min-w-0 flex-1 truncate', slice.key.startsWith('tool:') && slice.key !== 'tool:*' && 'font-mono text-[11.5px]')}>{slice.label}</span>
                {clickable && <Crosshair className="size-3 text-muted-foreground opacity-0 group-hover:opacity-100" aria-hidden />}
                <span className="w-16 text-right text-muted-foreground tabular">{format(value(slice))}</span>
                <span className="w-9 text-right tabular">{share < 1 ? '<1' : Math.round(share)}%</span>
              </button>
            </li>
          );
        })}
      </ul>
    </>
  );
}

/** Σ prompt tokens by source, then the tool results that cost the most re-reads. */
function InputMix({ mix, previews, onFocus, onSelect }: {
  mix: PromptMix; previews: PreviewStore | null; onFocus: (label: string, ids: string[]) => void; onSelect: (id: string) => void;
}) {
  const growth = mix.first ? mix.last / mix.first : 0, max = mix.heaviest[0] ? mix.heaviest[0].tokens * mix.heaviest[0].reads : 1;
  return (
    <>
      <Heading aside={`${num(mix.total)} prompt tokens${growth >= 1.5 ? ` · last prompt ${growth.toFixed(1)}× the first` : ''}`}>Where the input went</Heading>
      <Breakdown slices={mix.slices} value={slice => slice.tokens} format={num}
        onFocus={slice => onFocus(slice.key.startsWith('tool:') && slice.key !== 'tool:*' ? `${slice.label} results` : slice.label, slice.ids)} />
      {mix.heaviest.length > 0 && (
        <>
          <div className="mt-3 mb-1 flex items-baseline gap-2 text-[11px] text-muted-foreground">
            <span className="font-medium text-foreground">Heaviest tool results</span><span>tokens added × later requests that read them</span>
          </div>
          <div className="space-y-px">
            {mix.heaviest.map(result => {
              const preview = previews?.get(result.id)?.text;
              return (
                <button key={result.id} type="button" onClick={() => onSelect(result.id)}
                  className="relative flex w-full items-center gap-2 overflow-hidden rounded-md px-1.5 py-1 text-left text-[12px] hover:bg-accent/60">
                  <span className="absolute inset-y-0 left-0 bg-foreground/[0.045]" style={{ width: `${result.tokens * result.reads / max * 100}%` }} aria-hidden />
                  <span className="relative min-w-0 flex-1 truncate">
                    <span className="font-mono text-[11.5px]">{result.tool}</span>
                    <span className="text-muted-foreground"> · #{result.request}{preview ? ` · ${preview}` : ''}</span>
                  </span>
                  {result.truncatedFrom != null && (
                    <span className="relative shrink-0 text-[10.5px] text-destructive tabular" title="The harness cut this output; the model saw only the head">cut from {num(result.truncatedFrom)}</span>
                  )}
                  <span className="relative shrink-0 text-[11px] text-muted-foreground tabular" title={result.shared > 1 ? `Shared evenly by ${result.shared} calls in this step` : undefined}>
                    {result.shared > 1 ? '≈' : ''}{num(result.tokens)} × {full(result.reads)}
                  </span>
                  <span className="relative w-12 shrink-0 text-right font-medium tabular">{num(result.tokens * result.reads)}</span>
                </button>
              );
            })}
          </div>
        </>
      )}
      <p className="mt-1.5 text-[11px] leading-relaxed text-muted-foreground">
        Each token counts once per request that read it. Tool results are inferred from prompt growth between requests; calls in one step share it evenly.
        {mix.pruned >= mix.total * 0.01 && ` The harness also removed context that would have been read ${num(mix.pruned)} more times (cleared results or dropped reasoning).`}
      </p>
    </>
  );
}

function FindingCard({ finding, onShow }: { finding: Finding; onShow: () => void }) {
  const meta = SEVERITY[finding.severity], Icon = meta.icon;
  return (
    <div className={cn('rounded-lg border px-3 py-2.5', meta.card)}>
      <div className="flex items-start gap-2">
        <Icon className={cn('mt-0.5 size-3.5 shrink-0', meta.icon_)} aria-label={`${meta.label} severity`} />
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-2">
            <span className="min-w-0 text-[12.5px] leading-snug font-medium">{finding.title}</span>
            <span className="ml-auto shrink-0 text-[10px] tracking-wider text-muted-foreground uppercase">{finding.area}</span>
          </div>
          <p className="mt-0.5 text-[11.5px] leading-relaxed break-words text-muted-foreground">{finding.detail}</p>
          {finding.ids.length > 0 && (
            <Button variant="outline" size="xs" className="mt-1.5 h-6 gap-1 bg-background/60 text-[11px]" onClick={onShow}>
              <Crosshair className="size-3" aria-hidden />{finding.ids.length === 1 ? 'Open event' : `Show ${full(finding.ids.length)} events`}
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * Prompt size per request, cached vs new, with compactions marked. The model's own earlier reasoning (or output) still
 * in the prompt is split out of the cached part, where it normally sits. Hover to read, click to open.
 */
function ContextGrowth({ points, carry, breaks, onSelect }: { points: ContextPoint[]; carry: Carry | null; breaks: CacheBreaks | null; onSelect: (id: string) => void }) {
  const [hover, setHover] = useState<number | null>(null);
  const n = points.length, max = Math.max(1, ...points.map(p => p.fresh + p.cached));
  // analyzeCarry keeps one point per context point, in order.
  const carried = (i: number) => carry?.points[i]?.carried ?? 0;
  const word = carry?.basis === 'output' ? 'output' : 'reasoning';
  const missed = useMemo(() => new Map(breaks?.breaks.map(b => [b.id, b]) ?? []), [breaks]);
  const compactions = points.filter(p => p.compactedBefore).length;
  const shown = hover != null ? points[hover] : null;
  const gap = n > 120 ? 0 : 0.15;
  return (
    <>
      <Heading aside={`peak ${num(max)} tokens${compactions ? ` · ${compactions} compaction${compactions > 1 ? 's' : ''}` : ''}`}>Context growth</Heading>
      <div className="rounded-lg border px-2.5 pt-2 pb-1.5">
        <svg viewBox={`0 0 ${n} 100`} preserveAspectRatio="none" className="block h-24 w-full cursor-pointer" role="img"
          aria-label={`Prompt tokens for ${n} requests, peaking at ${full(max)}`}
          onMouseMove={e => { const r = e.currentTarget.getBoundingClientRect(); setHover(Math.min(n - 1, Math.max(0, Math.floor((e.clientX - r.left) / r.width * n)))); }}
          onMouseLeave={() => setHover(null)} onClick={() => { if (hover != null) onSelect(points[hover].id); }}>
          {hover != null && <rect x={hover} width={1} y={0} height={100} fill="var(--foreground)" opacity={0.07} />}
          {points.map((p, i) => {
            const prompt = p.fresh + p.cached, own = Math.min(carried(i), prompt), rest = Math.max(0, p.cached - own);
            const ownH = own / max * 100, cached = rest / max * 100, fresh = (prompt - own - rest) / max * 100;
            return (
              <g key={p.id}>
                {ownH > 0 && <rect x={i + gap} width={1 - gap * 2} y={100 - ownH} height={ownH} fill="var(--kind-reasoning)" />}
                <rect x={i + gap} width={1 - gap * 2} y={100 - ownH - cached} height={cached} fill="color-mix(in oklch, var(--kind-model) 38%, transparent)" />
                <rect x={i + gap} width={1 - gap * 2} y={100 - ownH - cached - fresh} height={fresh} fill="var(--kind-model)" />
              </g>
            );
          })}
          {points.map((p, i) => missed.has(p.id) && <rect key={`m${p.id}`} x={i + gap} width={1 - gap * 2} y={0} height={5} fill="var(--destructive)" />)}
          {points.map((p, i) => p.compactedBefore && (
            <line key={`c${p.id}`} x1={i} x2={i} y1={0} y2={100} stroke="var(--kind-compaction)" strokeWidth={1.5} strokeDasharray="3 2" vectorEffect="non-scaling-stroke" />
          ))}
        </svg>
        <div className="mt-1 flex min-h-4 items-center gap-3 text-[10.5px] text-muted-foreground tabular">
          {shown ? (
            <span className="truncate">
              <span className="font-medium text-foreground">Request #{shown.request}</span> · {full(shown.cached)} cached + {full(shown.fresh)} new · {full(shown.output)} out
              {carried(hover!) > 0 && <> · {full(carried(hover!))} earlier {word}</>}
              {missed.has(shown.id) && <span className="text-destructive"> · cache miss{missed.get(shown.id)!.gapMs != null ? ` after a ${duration(missed.get(shown.id)!.gapMs)} wait` : ''}</span>}
              {shown.compactedBefore && <span className="text-kind-compaction"> · after compaction</span>}
            </span>
          ) : (
            <>
              <span className="flex items-center gap-1"><i className="size-2 rounded-[2px] bg-kind-model" />new</span>
              <span className="flex items-center gap-1"><i className="size-2 rounded-[2px] bg-kind-model/40" />cached</span>
              {carry && carry.reread > 0 && <span className="flex items-center gap-1"><i className="size-2 rounded-[2px] bg-kind-reasoning" />earlier {word}</span>}
              {compactions > 0 && <span className="flex items-center gap-1"><i className="h-2.5 w-0 border-l border-dashed border-kind-compaction" />compaction</span>}
              {missed.size > 0 && <span className="flex items-center gap-1"><i className="h-1 w-2 rounded-[1px] bg-destructive" />cache miss</span>}
              <span className="ml-auto">#{points[0].request} → #{points.at(-1)!.request}</span>
            </>
          )}
        </div>
      </div>
    </>
  );
}

const toolFeatures = tableFeatures({
  rowSortingFeature,
  sortedRowModel: createSortedRowModel(),
  sortFns: { basic: sortFn_basic, text: sortFn_text },
  columnMeta: {} as { align?: 'right' },
});
const toolHelper = createColumnHelper<typeof toolFeatures, ToolStat>();

function ToolsTable({ tools, onPick }: { tools: ToolStat[]; onPick: (name: string) => void }) {
  const max = Math.max(1, ...tools.map(tool => tool.ms));
  const columns = useMemo(() => toolHelper.columns([
    toolHelper.accessor('name', {
      header: 'Tool', sortFn: 'text',
      cell: ({ row }) => (
        <div className="min-w-0">
          <div className="truncate font-mono text-[11.5px]">{row.original.name}</div>
          <div className="mt-1 h-1 overflow-hidden rounded-full bg-muted" title="Share of total tool time">
            <div className="h-full rounded-full bg-kind-tool/70" style={{ width: `${row.original.ms / max * 100}%` }} />
          </div>
        </div>
      ),
    }),
    toolHelper.accessor('calls', { header: 'Calls', sortFn: 'basic', sortDescFirst: true, meta: { align: 'right' }, cell: ({ getValue }) => full(getValue()) }),
    toolHelper.accessor(tool => tool.calls ? tool.errors / tool.calls : 0, {
      id: 'errors', header: 'Err', sortFn: 'basic', sortDescFirst: true, meta: { align: 'right' },
      cell: ({ row }) => row.original.errors
        ? <span className="text-destructive" title={`${row.original.errors} of ${row.original.calls} failed`}>{Math.round(row.original.errors / row.original.calls * 100)}%</span>
        : <span className="text-muted-foreground/60">·</span>,
    }),
    toolHelper.accessor('ms', { header: 'Time', sortFn: 'basic', sortDescFirst: true, meta: { align: 'right' }, cell: ({ getValue }) => duration(getValue()) }),
    toolHelper.accessor(tool => tool.calls ? tool.ms / tool.calls : 0, {
      id: 'avg', header: 'Avg', sortFn: 'basic', sortDescFirst: true, meta: { align: 'right' }, cell: ({ getValue }) => <span className="text-muted-foreground">{duration(getValue())}</span>,
    }),
  ]), [max]);
  const table = useTable({
    features: toolFeatures, columns, data: tools,
    initialState: { sorting: [{ id: 'ms', desc: true }] },
    getRowId: tool => tool.name,
  });
  return (
    <table className="w-full table-fixed text-[12px]">
      <colgroup><col /><col className="w-13" /><col className="w-11" /><col className="w-16" /><col className="w-14" /></colgroup>
      <thead>
        <tr className="border-b">
          {table.getHeaderGroups()[0].headers.map(header => {
            const sorted = header.column.getIsSorted(), right = header.column.columnDef.meta?.align === 'right';
            return (
              <th key={header.id} className={cn('pb-1.5 font-medium', right ? 'text-right' : 'text-left')} aria-sort={sorted ? (sorted === 'asc' ? 'ascending' : 'descending') : undefined}>
                <button type="button" onClick={header.column.getToggleSortingHandler()}
                  className={cn('inline-flex items-center gap-0.5 text-[10.5px] tracking-wider uppercase hover:text-foreground', sorted ? 'text-foreground' : 'text-muted-foreground')}>
                  <table.FlexRender header={header} />
                  {sorted === 'asc' ? <ArrowUp className="size-3" /> : sorted === 'desc' ? <ArrowDown className="size-3" /> : null}
                </button>
              </th>
            );
          })}
        </tr>
      </thead>
      <tbody>
        {table.getRowModel().rows.map(row => (
          <tr key={row.id} onClick={() => onPick(row.original.name)} className="cursor-pointer border-b border-border/50 last:border-0 hover:bg-accent/50"
            title={`Show ${row.original.name} calls in the trajectory`}>
            {row.getAllCells().map(cell => (
              <td key={cell.id} className={cn('py-1.5 align-top tabular', cell.column.columnDef.meta?.align === 'right' && 'pl-2 text-right')}>
                <table.FlexRender cell={cell} />
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}
