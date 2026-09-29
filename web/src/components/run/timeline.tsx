import { memo, useEffect, useMemo, useRef, useState } from 'react';
import { ChevronDown, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { clock, duration, num } from '@/lib/format';
import { eventName, isFailed, isRunning, KIND } from '@/lib/status';
import type { EventKind, Run, TrajectoryEvent } from '@/lib/types';
import { useNow } from '@/lib/use-snapshot';
import { cn } from '@/lib/utils';

export interface Range { start: number; end: number }
type Mode = 'time' | 'requests' | 'calls';

const LANES: { name: string; kinds: EventKind[] }[] = [
  { name: 'Input', kinds: ['input', 'context', 'compaction', 'retry'] },
  { name: 'Model', kinds: ['model'] },
  { name: 'Tools', kinds: ['tool'] },
];
const LEGEND: EventKind[] = ['input', 'context', 'model', 'tool', 'compaction', 'retry'];
const MIN_ZOOM_MS = 500;

interface Placed { event: TrajectoryEvent; turn: number; call: number }

export function Timeline({ run, events, selectedId, onSelect, range, onRange }: {
  run: Run; events: TrajectoryEvent[]; selectedId: string | null; onSelect: (id: string) => void;
  range: Range | null; onRange: (range: Range | null) => void;
}) {
  const [mode, setMode] = useState<Mode>('time');
  const [zoom, setZoom] = useState<Range | null>(null);
  const [open, setOpen] = useState(true);
  const [hover, setHover] = useState<{ event: TrajectoryEvent; left: number; top: number } | null>(null);
  const [drag, setDrag] = useState<{ from: number; to: number } | null>(null);
  const now = useNow(5000, run.active);
  const lanesRef = useRef<HTMLDivElement>(null);

  const domain = useMemo<Range>(() => {
    let start = run.startedAt, end = run.endedAt ?? (run.active ? now : run.lastActivityAt ?? run.startedAt);
    for (const event of events) { start = Math.min(start, event.startedAt); end = Math.max(end, event.endedAt ?? event.startedAt); }
    return { start, end: Math.max(start + 1, end) };
  }, [run.startedAt, run.endedAt, run.active, run.lastActivityAt, events, now]);

  const placed = useMemo(() => {
    let turn = 0, call = 0;
    return events.map<Placed>(event => ({ event, turn: event.kind === 'model' ? ++turn : turn, call: event.kind === 'model' || event.kind === 'tool' ? ++call : call }));
  }, [events]);
  const turns = placed.at(-1)?.turn ?? 0, calls = placed.at(-1)?.call ?? 0;
  const view = zoom ?? domain;

  // The latest values for the native wheel listener.
  const live = useRef({ mode, view, domain });
  live.current = { mode, view, domain };

  const timeAt = (clientX: number) => {
    const box = lanesRef.current?.getBoundingClientRect();
    if (!box) return null;
    const { view } = live.current;
    return view.start + Math.min(1, Math.max(0, (clientX - box.left) / box.width)) * (view.end - view.start);
  };

  useEffect(() => {
    const el = lanesRef.current;
    if (!el || !open) return;
    const onWheel = (event: WheelEvent) => {
      const { mode, view, domain } = live.current;
      if (mode !== 'time') return;
      event.preventDefault();
      const at = timeAt(event.clientX) ?? (view.start + view.end) / 2, factor = event.deltaY > 0 ? 1.25 : 0.8;
      let start = at - (at - view.start) * factor, end = at + (view.end - at) * factor;
      if (end - start >= domain.end - domain.start) return setZoom(null);
      if (end - start < MIN_ZOOM_MS) return;
      if (start < domain.start) { end += domain.start - start; start = domain.start; }
      if (end > domain.end) { start -= end - domain.end; end = domain.end; }
      setZoom({ start: Math.max(domain.start, start), end });
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [open]);

  // Drag across the lanes to focus the trajectory on a time range.
  const onPointerDown = (event: React.PointerEvent) => {
    if (mode !== 'time' || event.button !== 0) return;
    const from = event.clientX;
    const move = (e: PointerEvent) => setDrag({ from, to: e.clientX });
    const up = (e: PointerEvent) => {
      removeEventListener('pointermove', move);
      removeEventListener('pointerup', up);
      setDrag(null);
      if (Math.abs(e.clientX - from) < 5) return;
      const a = timeAt(from)!, b = timeAt(e.clientX)!;
      onRange({ start: Math.min(a, b), end: Math.max(a, b) });
    };
    addEventListener('pointermove', move);
    addEventListener('pointerup', up);
  };

  const geometry = (item: Placed) => {
    if (mode === 'time') {
      const span = view.end - view.start, start = item.event.startedAt;
      const end = item.event.endedAt ?? (isRunning(item.event) ? domain.end : start);
      return { left: (start - view.start) / span, width: (end - start) / span };
    }
    const total = (mode === 'requests' ? turns : calls) + 1, x = mode === 'requests' ? item.turn : item.call;
    return { left: x / total, width: 0.65 / total };
  };

  const pct = (t: number) => ((t - view.start) / (view.end - view.start)) * 100;
  const box = lanesRef.current?.getBoundingClientRect();
  const dragBox = drag && box ? { left: Math.min(drag.from, drag.to) - box.left, width: Math.abs(drag.to - drag.from) } : null;

  return (
    <section aria-label="Activity timeline" className="rounded-lg border bg-card">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 px-3 py-2">
        <button type="button" onClick={() => setOpen(!open)} className="flex items-center gap-1 text-[12px] font-semibold" aria-expanded={open}>
          <ChevronDown className={cn('size-3.5 text-muted-foreground transition-transform', !open && '-rotate-90')} aria-hidden />
          Timeline
        </button>
        <div className="hidden items-center gap-2.5 text-[11px] text-muted-foreground md:flex">
          {LEGEND.map(kind => (
            <span key={kind} className="inline-flex items-center gap-1"><i className={cn('size-2 rounded-[2px]', KIND[kind].color)} />{KIND[kind].label}</span>
          ))}
        </div>
        <div className="ml-auto flex items-center gap-2">
          {range ? (
            <span className="inline-flex h-6 items-center gap-1 rounded-md bg-brand/10 pr-0.5 pl-2 text-[11px] text-brand">
              Focused {clock(range.start)} – {clock(range.end)} · {duration(range.end - range.start)}
              <Button variant="ghost" size="icon-xs" className="text-brand hover:bg-brand/15" onClick={() => onRange(null)} aria-label="Clear focus"><X /></Button>
            </span>
          ) : mode === 'time' && open ? (
            <span className="hidden text-[11px] text-muted-foreground lg:inline">Drag to focus · scroll to zoom{zoom ? ' · double-click to reset' : ''}</span>
          ) : null}
          <ToggleGroup type="single" size="sm" variant="outline" spacing={0} value={mode} onValueChange={value => value && setMode(value as Mode)} aria-label="Timeline scale">
            <ToggleGroupItem value="time">Time</ToggleGroupItem>
            <ToggleGroupItem value="requests">Requests</ToggleGroupItem>
            <ToggleGroupItem value="calls">Calls</ToggleGroupItem>
          </ToggleGroup>
        </div>
      </div>
      {open && (
        <div className="relative px-3 pb-2" onMouseLeave={() => setHover(null)}>
          <div className="flex">
            <div className="w-12 shrink-0 space-y-1.5 pt-px text-[10.5px] text-muted-foreground">
              {LANES.map(lane => <div key={lane.name} className="flex h-4 items-center">{lane.name}</div>)}
            </div>
            <div ref={lanesRef} onPointerDown={onPointerDown} onDoubleClick={() => setZoom(null)} onContextMenu={e => { if (range) { e.preventDefault(); onRange(null); } }}
              className={cn('relative min-w-0 flex-1 space-y-1.5 select-none', mode === 'time' && 'cursor-crosshair')}>
              {LANES.map(lane => (
                <Lane key={lane.name} items={placed} kinds={lane.kinds} geometry={geometry} selectedId={selectedId} range={range}
                  mode={mode} onSelect={onSelect} onHover={(event, el) => {
                    if (!event || !el || !lanesRef.current) return setHover(null);
                    const outer = lanesRef.current.getBoundingClientRect(), rect = el.getBoundingClientRect();
                    setHover({ event, left: rect.left - outer.left + rect.width / 2, top: rect.top - outer.top });
                  }} />
              ))}
              {mode === 'time' && range && (
                <div className="pointer-events-none absolute inset-y-0 rounded-sm bg-brand/12 ring-1 ring-brand/40 ring-inset"
                  style={{ left: `${Math.max(0, pct(range.start))}%`, width: `${Math.max(0.3, Math.min(100, pct(range.end)) - Math.max(0, pct(range.start)))}%` }} />
              )}
              {dragBox && <div className="pointer-events-none absolute inset-y-0 rounded-sm bg-brand/15 ring-1 ring-brand/50" style={dragBox} />}
              {mode === 'time' && run.active && pct(now) <= 100 && (
                <div className="pointer-events-none absolute -inset-y-1 w-px bg-running/70" style={{ left: `${pct(now)}%` }} aria-hidden>
                  <span className="absolute -top-1 -left-[3px] size-[7px] rounded-full bg-running" />
                </div>
              )}
              {hover && <HoverCard event={hover.event} left={hover.left} top={hover.top} />}
            </div>
          </div>
          <div className="mt-1 ml-12 flex justify-between text-[10.5px] text-muted-foreground tabular">
            {mode === 'time' ? (
              <>
                <span>{clock(view.start)}</span>
                <span className="hidden sm:inline">{clock(view.start + (view.end - view.start) / 4)}</span>
                <span>{clock((view.start + view.end) / 2)}</span>
                <span className="hidden sm:inline">{clock(view.start + (view.end - view.start) * 3 / 4)}</span>
                <span>{clock(view.end)} · {duration(view.end - view.start)}{zoom ? ' zoomed' : ''}</span>
              </>
            ) : (
              <><span>0</span><span>{mode === 'requests' ? `${turns} model requests` : `${calls} calls`}</span></>
            )}
          </div>
        </div>
      )}
    </section>
  );
}

const Lane = memo(function Lane({ items, kinds, geometry, selectedId, range, mode, onSelect, onHover }: {
  items: Placed[]; kinds: EventKind[]; geometry: (item: Placed) => { left: number; width: number }; selectedId: string | null; range: Range | null;
  mode: Mode; onSelect: (id: string) => void; onHover: (event: TrajectoryEvent | null, el?: HTMLElement) => void;
}) {
  return (
    <div className="relative h-4 overflow-hidden rounded-[3px] bg-muted/50">
      {items.filter(item => kinds.includes(item.event.kind)).map(item => {
        const { left, width } = geometry(item);
        if (left > 1 || left + width < 0) return null;
        const event = item.event, failed = isFailed(event), running = isRunning(event);
        const outside = range && !(event.startedAt <= range.end && (event.endedAt ?? event.startedAt) >= range.start);
        const split = mode === 'time' && event.kind === 'model' && event.ttftMs != null && event.endedAt
          ? Math.min(100, (event.ttftMs / Math.max(1, event.endedAt - event.startedAt)) * 100) : null;
        return (
          <button key={event.id} type="button" aria-label={`${eventName(event)} at ${clock(event.startedAt)}`}
            onPointerDown={e => e.stopPropagation()} onClick={() => onSelect(event.id)}
            onMouseEnter={e => onHover(event, e.currentTarget)} onMouseLeave={() => onHover(null)} onFocus={e => onHover(event, e.currentTarget)} onBlur={() => onHover(null)}
            className={cn('absolute top-0.5 bottom-0.5 min-w-[3px] rounded-[2px] transition-opacity hover:brightness-125 focus-visible:outline-2 focus-visible:outline-ring',
              failed ? 'bg-destructive' : KIND[event.kind]?.color ?? 'bg-kind-context', running && 'stripes',
              event.id === selectedId && 'z-10 outline-2 outline-offset-1 outline-foreground', outside && 'opacity-25')}
            style={{
              left: `${Math.max(0, left) * 100}%`, width: `${Math.max(0, Math.min(width, 1 - Math.max(0, left))) * 100}%`,
              ...(split != null && !failed ? { background: `linear-gradient(to right, var(--kind-model-wait) 0 ${split}%, var(--kind-model) ${split}% 100%)` } : null),
            }} />
        );
      })}
    </div>
  );
});

function HoverCard({ event, left, top }: { event: TrajectoryEvent; left: number; top: number }) {
  const ms = event.endedAt != null ? event.endedAt - event.startedAt : null;
  return (
    <div className="pointer-events-none absolute z-20 w-max max-w-72 -translate-x-1/2 -translate-y-full rounded-md border bg-popover px-2.5 py-1.5 text-[11px] text-popover-foreground shadow-lg"
      style={{ left, top: top - 6 }}>
      <div className="flex items-center gap-1.5 font-medium">
        <i className={cn('size-2 rounded-[2px]', isFailed(event) ? 'bg-destructive' : KIND[event.kind]?.color)} />
        <span className="truncate">{eventName(event)}</span>
      </div>
      <div className="mt-0.5 text-muted-foreground tabular">
        {clock(event.startedAt)} · {isRunning(event) ? 'running' : duration(ms)}
        {event.ttftMs != null && ` · TTFT ${duration(event.ttftMs)}`}
        {event.inputTokens != null && ` · ${num(event.inputTokens)} in / ${num(event.outputTokens)} out`}
      </div>
      {event.error && <div className="mt-0.5 line-clamp-2 text-destructive">{event.error}</div>}
    </div>
  );
}
