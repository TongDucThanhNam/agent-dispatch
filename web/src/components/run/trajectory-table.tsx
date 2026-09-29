import { memo, useDeferredValue, useEffect, useMemo, useRef } from 'react';
import {
  columnFilteringFeature, createColumnHelper, createFilteredRowModel, filterFn_includesString, globalFilteringFeature, tableFeatures, useTable,
  type ColumnFiltersState, type FilterFn,
} from '@tanstack/react-table';
import { useVirtualizer } from '@tanstack/react-virtual';
import { ChevronDown, Crosshair, ListFilter, Search, X } from 'lucide-react';
import { KindChip } from '@/components/kind-chip';
import { Button } from '@/components/ui/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { Kbd } from '@/components/ui/kbd';
import { Switch } from '@/components/ui/switch';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { clock, duration, full, human, num, stamp } from '@/lib/format';
import { eventName, isFailed, isRunning, KIND_FILTERS, kindMeta, type KindFilter } from '@/lib/status';
import type { EventFocus, Run, TrajectoryEvent } from '@/lib/types';
import { usePreviewVersion, type PreviewStore } from '@/lib/use-previews';
import { cn } from '@/lib/utils';

interface Item { event: TrajectoryEvent; index: number; search: string }

const byKind: FilterFn<any, Item> = (row, _id, value: KindFilter) => (KIND_FILTERS.find(f => f.value === value)?.test ?? (() => true))(row.original.event);
// A focus is a set of events picked elsewhere (an insight, "same call ran N×"), shown in trajectory order.
const inFocus: FilterFn<any, Item> = (row, _id, ids: ReadonlySet<string>) => ids.has(row.original.event.id);

const features = tableFeatures({
  columnFilteringFeature,
  globalFilteringFeature,
  filteredRowModel: createFilteredRowModel(),
  filterFns: { includesString: filterFn_includesString, byKind, inFocus },
  columnMeta: {} as { className?: string },
});
const helper = createColumnHelper<typeof features, Item>();

/** Columns share one grid template sized to the panel: narrow panels drop the token, then the index column. */
const GRID = 'grid grid-cols-[82px_minmax(0,1fr)_56px] @md:grid-cols-[92px_minmax(0,1fr)_68px_60px] @xl:grid-cols-[40px_92px_minmax(0,1fr)_68px_60px] items-start gap-x-2.5';

const HEADER_HEIGHT = 28;

export const TrajectoryTable = memo(function TrajectoryTable({ run, previews, selectedId, onSelect, kind, onKind, search, onSearch, focus, onFocus, follow, onFollow }: {
  run: Run; previews: PreviewStore | null; selectedId: string | null; onSelect: (id: string | null) => void;
  kind: KindFilter; onKind: (kind: KindFilter) => void; search: string; onSearch: (search: string) => void;
  focus: EventFocus | null; onFocus: (focus: EventFocus | null) => void; follow: boolean; onFollow: (follow: boolean) => void;
}) {
  const events = run.trajectory.events;
  const version = usePreviewVersion(previews);
  const deferredSearch = useDeferredValue(search);

  // Search covers what the row shows, including the lazily loaded previews.
  const indexCache = useRef(new Map<string, { preview: unknown; item: Item }>());
  const data = useMemo<Item[]>(() => {
    const next = new Map<string, { preview: unknown; item: Item }>();
    const items = events.map((event, index) => {
    const preview = previews?.get(event.id);
    const old = indexCache.current.get(event.id);
    if (old?.item.event === event && old.item.index === index && old.preview === preview) { next.set(event.id, old); return old.item; }
    const item = {
      event, index,
      search: [eventName(event), event.label, kindMeta(event.kind).role, event.status, event.finishReason, event.reason, preview?.text, preview?.result,
        event.request ? `#${event.request}` : '', event.error].filter(Boolean).join(' '),
    };
    next.set(event.id, { preview, item }); return item;
    });
    indexCache.current = next;
    return items;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [events, previews, version]);

  const columns = useMemo(() => helper.columns([
    helper.accessor(item => item.index, {
      id: 'index', header: '#', filterFn: 'inFocus', enableGlobalFilter: false, meta: { className: 'hidden @xl:block' },
      cell: ({ getValue }) => <span className="font-mono text-[10.5px] text-muted-foreground/70">{String(getValue() + 1).padStart(3, '0')}</span>,
    }),
    helper.accessor(item => item.event.kind, {
      id: 'kind', header: 'Role', filterFn: 'byKind', enableGlobalFilter: false,
      cell: ({ row }) => <KindChip kind={row.original.event.kind} error={isFailed(row.original.event)} />,
    }),
    helper.accessor(item => item.search, {
      id: 'activity', header: 'Activity',
      cell: ({ row }) => <Activity event={row.original.event} previews={previews} />,
    }),
    helper.display({
      id: 'tokens', header: () => <span className="block text-right">Tokens</span>, meta: { className: 'hidden @md:block' },
      cell: ({ row }) => <Tokens event={row.original.event} />,
    }),
    helper.accessor(item => item.event.startedAt, {
      id: 'time', header: () => <span className="block text-right">Time</span>, enableGlobalFilter: false,
      cell: ({ row }) => {
        const event = row.original.event;
        return isRunning(event)
          ? <span className="block text-right text-[11px] font-medium text-running">running</span>
          : <span className="block text-right text-[11px] text-muted-foreground tabular">{duration(event.endedAt == null ? null : event.endedAt - event.startedAt)}</span>;
      },
    }),
  ]), [previews]);

  const columnFilters = useMemo<ColumnFiltersState>(() => [
    ...(kind !== 'all' ? [{ id: 'kind', value: kind }] : []),
    ...(focus ? [{ id: 'index', value: focus.ids }] : []),
  ], [kind, focus]);

  const table = useTable({
    features, columns, data,
    state: { columnFilters, globalFilter: deferredSearch.trim() },
    getRowId: item => item.event.id,
    globalFilterFn: 'includesString',
    getColumnCanGlobalFilter: column => column.id === 'activity',
  });
  const rows = table.getRowModel().rows;
  const counts = useMemo(() => Object.fromEntries(KIND_FILTERS.map(f => [f.value, events.filter(f.test).length])), [events]);

  const scrollRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 50,
    getItemKey: index => rows[index]?.id ?? index,
    overscan: 10,
    paddingStart: HEADER_HEIGHT,
    scrollPaddingStart: HEADER_HEIGHT,
  });
  const items = virtualizer.getVirtualItems();
  const visibleEvents = useRef<TrajectoryEvent[]>([]);
  visibleEvents.current = items.map(item => rows[item.index]?.original.event).filter(Boolean) as TrajectoryEvent[];

  // Load previews for the rows on screen.
  useEffect(() => { previews?.request(visibleEvents.current); });
  useEffect(() => {
    const timer = setInterval(() => { if (!document.hidden) previews?.request(visibleEvents.current); }, 4000);
    return () => clearInterval(timer);
  }, [previews]);

  // Follow keeps the newest event in view.
  useEffect(() => {
    if (follow && rows.length) virtualizer.scrollToIndex(rows.length - 1, { align: 'end' });
  }, [follow, rows.length, virtualizer]);

  // Keep a selection made elsewhere (insights, linked events, keyboard) in view.
  useEffect(() => {
    if (!selectedId) return;
    const index = rows.findIndex(row => row.id === selectedId);
    if (index >= 0) virtualizer.scrollToIndex(index, { align: 'auto' });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId]);

  // Scrolling up pauses follow.
  const lastTop = useRef(0);
  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    if (follow && el.scrollTop < lastTop.current - 4 && el.scrollHeight - el.scrollTop - el.clientHeight > 60) onFollow(false);
    lastTop.current = el.scrollTop;
  };

  // ↑/↓ move through the visible events, Esc returns to the run summary, / focuses search.
  const live = useRef({ rows, selectedId, onSelect });
  live.current = { rows, selectedId, onSelect };
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const typing = target?.closest('input, textarea, select, [contenteditable="true"]');
      if (event.key === '/' && !typing) { event.preventDefault(); searchRef.current?.focus(); searchRef.current?.select(); return; }
      if (typing || event.altKey || event.ctrlKey || event.metaKey || document.querySelector('[role="dialog"]')) return;
      const { rows, selectedId, onSelect } = live.current;
      if (event.key === 'Escape' && selectedId) { onSelect(null); return; }
      if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
      if (!rows.length) return;
      event.preventDefault();
      const at = rows.findIndex(row => row.id === selectedId), step = event.key === 'ArrowDown' ? 1 : -1;
      const next = at < 0 ? (step > 0 ? 0 : rows.length - 1) : Math.max(0, Math.min(rows.length - 1, at + step));
      onSelect(rows[next].id);
    };
    addEventListener('keydown', onKey);
    return () => removeEventListener('keydown', onKey);
  }, []);

  const filtered = rows.length !== events.length;
  const clearFilters = () => { onKind('all'); onSearch(''); onFocus(null); };

  return (
    <section aria-label="Trajectory" className="@container flex h-full min-h-0 flex-col">
      <div className="flex flex-wrap items-center gap-2 border-b px-3 py-2">
        <KindMenu kind={kind} onKind={onKind} counts={counts} />
        <div className="hidden min-w-0 @2xl:flex">
          <ToggleGroup type="single" size="sm" spacing={1} value={kind} onValueChange={value => value && onKind(value as KindFilter)} aria-label="Event kind">
            {KIND_FILTERS.map(f => (
              <ToggleGroupItem key={f.value} value={f.value} className={cn('gap-1.5 px-2 text-[11px]', f.value === 'errors' && counts.errors && 'text-destructive')}>
                {f.label}
                <span className={cn('rounded-sm px-1 text-[10px] tabular', kind === f.value ? 'bg-background/70' : 'bg-muted', f.value === 'errors' && counts.errors ? 'text-destructive' : 'text-muted-foreground')}>
                  {num(counts[f.value])}
                </span>
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
        </div>
        {focus && (
          <span className="inline-flex h-7 max-w-full min-w-0 items-center gap-1.5 rounded-md border border-brand/30 bg-brand/8 pr-1 pl-2 text-[11px] text-foreground">
            <Crosshair className="size-3.5 shrink-0 text-brand" aria-hidden />
            <span className="min-w-0 truncate" title={focus.label}>{focus.label}</span>
            <span className="shrink-0 rounded-sm bg-background/70 px-1 text-[10px] text-muted-foreground tabular">{num(focus.ids.size)}</span>
            <button type="button" onClick={() => onFocus(null)} aria-label="Show all events" title="Show all events"
              className="shrink-0 rounded-sm p-0.5 text-muted-foreground hover:bg-background/70 hover:text-foreground">
              <X className="size-3" />
            </button>
          </span>
        )}
        <div className="ml-auto flex items-center gap-3">
          <div className="relative">
            <Search className="pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-muted-foreground" aria-hidden />
            <input ref={searchRef} value={search} onChange={e => onSearch(e.target.value)} placeholder="Search events"
              onKeyDown={e => { if (e.key === 'Escape') { if (search) onSearch(''); else e.currentTarget.blur(); } }}
              aria-label="Search events"
              className="h-7 w-40 rounded-md border bg-transparent pr-7 pl-7 text-xs outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/30 @3xl:w-56" />
            {search ? (
              <button type="button" onClick={() => onSearch('')} aria-label="Clear search" className="absolute top-1/2 right-1.5 -translate-y-1/2 rounded-sm p-0.5 text-muted-foreground hover:text-foreground">
                <X className="size-3" />
              </button>
            ) : <Kbd className="absolute top-1/2 right-1.5 -translate-y-1/2">/</Kbd>}
          </div>
          <label className="flex items-center gap-1.5 text-[11px] text-muted-foreground select-none">
            <Switch size="sm" checked={follow} onCheckedChange={onFollow} aria-label="Follow the newest event" />
            Follow
          </label>
        </div>
      </div>

      <div ref={scrollRef} onScroll={onScroll} className="relative min-h-0 flex-1 overflow-y-auto" tabIndex={-1}>
        <div className="relative w-full" style={{ height: virtualizer.getTotalSize() }}>
          <div className={cn(GRID, 'sticky top-0 z-10 h-7 items-center border-b bg-card/95 px-3 text-[10.5px] font-medium tracking-wider text-muted-foreground uppercase backdrop-blur')}>
            {table.getHeaderGroups()[0].headers.map(header => (
              <div key={header.id} className={header.column.columnDef.meta?.className}><table.FlexRender header={header} /></div>
            ))}
          </div>
          {items.map(item => {
            const row = rows[item.index], event = row.original.event, previous = rows[item.index - 1]?.original.event;
            const turnHead = event.turn != null && event.turn !== previous?.turn;
            const selected = row.id === selectedId;
            return (
              <div key={item.key} data-index={item.index} ref={virtualizer.measureElement} className="absolute top-0 left-0 w-full"
                style={{ transform: `translateY(${item.start}px)` }}>
                {turnHead && (
                  <div className="flex items-center gap-2 px-3 pt-2.5 pb-1 text-[10.5px] text-muted-foreground">
                    <span className="rounded-full bg-muted px-2 py-px font-medium text-foreground/80">Turn {event.turn}</span>
                    {event.opensTurn && <span className="tabular">opened {stamp(event.startedAt)}</span>}
                    <span className="h-px flex-1 bg-border/70" />
                  </div>
                )}
                <button type="button" onClick={() => onSelect(row.id)} aria-pressed={selected} data-event={row.id}
                  className={cn(GRID, 'relative w-full border-b border-border/50 px-3 py-2 text-left transition-colors hover:bg-accent/60 focus-visible:bg-accent/60 focus-visible:outline-none',
                    selected && 'bg-brand/8 hover:bg-brand/10',
                    isFailed(event) && !selected && 'bg-destructive/[0.035]')}>
                  {selected && <span className="absolute inset-y-0 left-0 w-0.5 bg-brand" aria-hidden />}
                  {row.getAllCells().map(cell => (
                    <div key={cell.id} className={cn('min-w-0 pt-px', cell.column.columnDef.meta?.className)}><table.FlexRender cell={cell} /></div>
                  ))}
                </button>
              </div>
            );
          })}
        </div>
        {!rows.length && (
          <div className="absolute inset-x-0 top-16 flex flex-col items-center gap-2 px-6 text-center text-xs text-muted-foreground">
            <ListFilter className="size-5 opacity-60" aria-hidden />
            {events.length ? (
              <>
                <span>No events match the current filters.</span>
                <Button variant="outline" size="xs" onClick={clearFilters}>Clear filters</Button>
              </>
            ) : <span>{run.active ? 'Waiting for the first recorded event…' : 'No trajectory was recorded for this run.'}</span>}
          </div>
        )}
      </div>

      <div className="flex items-center gap-3 border-t px-3 py-1.5 text-[10.5px] text-muted-foreground">
        <span className="tabular">
          {filtered ? `${full(rows.length)} of ${full(events.length)} events` : `${full(events.length)} events`}
          {run.trajectory.truncated && ' · most recent 2,000 recorded'}
        </span>
        {filtered && <button type="button" onClick={clearFilters} className="text-brand hover:underline">Clear filters</button>}
        <span className="ml-auto hidden items-center gap-1 @lg:flex">
          <Kbd>↑</Kbd><Kbd>↓</Kbd> move <Kbd className="ml-1.5">Esc</Kbd> summary <Kbd className="ml-1.5">/</Kbd> search
        </span>
      </div>
    </section>
  );
});

/** The kind filter as a menu, for panels too narrow for the toggle row. */
function KindMenu({ kind, onKind, counts }: { kind: KindFilter; onKind: (kind: KindFilter) => void; counts: Record<string, number> }) {
  const current = KIND_FILTERS.find(f => f.value === kind) ?? KIND_FILTERS[0];
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" size="sm" className="h-7 gap-1.5 px-2 text-[11px] @2xl:hidden" aria-label={`Event kind: ${current.label}`}>
          <ListFilter className="size-3.5" aria-hidden />
          {current.label}
          <span className="rounded-sm bg-muted px-1 text-[10px] text-muted-foreground tabular">{num(counts[current.value])}</span>
          <ChevronDown className="size-3 opacity-60" aria-hidden />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="min-w-44">
        <DropdownMenuRadioGroup value={kind} onValueChange={value => onKind(value as KindFilter)}>
          {KIND_FILTERS.map(f => (
            <DropdownMenuRadioItem key={f.value} value={f.value} className={cn('text-xs', f.value === 'errors' && counts.errors && 'text-destructive')}>
              {f.label}
              <span className="ml-auto pl-4 text-[10.5px] text-muted-foreground tabular">{num(counts[f.value])}</span>
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function Activity({ event, previews }: { event: TrajectoryEvent; previews: PreviewStore | null }) {
  const preview = previews?.get(event.id), failed = isFailed(event);
  const bits = [human(event.status), clock(event.startedAt)];
  if (event.kind === 'model') {
    if (event.ttftMs != null) bits.push(`TTFT ${duration(event.ttftMs)}`);
    if (event.finishReason) bits.push(human(event.finishReason));
    if ((event.attempt ?? 0) > 1) bits.push(`attempt ${event.attempt}`);
  }
  if (event.kind === 'compaction' && event.reason) bits.push(human(event.reason));
  if (event.origin) bits.push(human(event.origin));
  return (
    <div className="min-w-0">
      <div className="flex min-w-0 items-baseline gap-2 text-[12.5px] leading-5">
        <span className="max-w-full shrink-0 truncate font-medium">{eventName(event)}</span>
        {preview === undefined
          ? <span className="h-2.5 w-24 shrink animate-pulse self-center rounded-sm bg-foreground/10" aria-hidden />
          : preview.text && <span className="truncate text-muted-foreground">{preview.text}</span>}
      </div>
      <div className="truncate text-[11px] leading-4 text-muted-foreground/80 tabular">
        {bits.filter(Boolean).join(' · ')}
        {event.error && <span className="text-destructive"> · {event.error}</span>}
        {preview?.result && <span className={cn(failed && event.kind === 'tool' && 'text-destructive')}> · {preview.result}</span>}
      </div>
    </div>
  );
}

function Tokens({ event }: { event: TrajectoryEvent }) {
  if (event.kind === 'model' && (event.inputTokens != null || event.outputTokens != null)) {
    return (
      <div className="text-right text-[11px] leading-4 tabular"
        title={`${full(event.inputTokens)} input · ${full(event.cacheReadTokens)} cached · ${full(event.outputTokens)} output${event.reasoningTokens ? ` · ${full(event.reasoningTokens)} reasoning` : ''}`}>
        <div>{num(event.inputTokens)}<span className="text-muted-foreground"> in</span></div>
        <div>{num(event.outputTokens)}<span className="text-muted-foreground"> out</span></div>
      </div>
    );
  }
  if (event.kind === 'compaction' && event.preTokens != null) {
    return (
      <div className="text-right text-[11px] leading-4 tabular">
        <div>{num(event.preTokens)}<span className="text-muted-foreground"> →</span></div>
        <div>{num(event.postTokens)}</div>
      </div>
    );
  }
  return null;
}
