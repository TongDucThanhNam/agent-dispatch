import { useCallback, useEffect, useMemo, useState } from 'react';
import { CircleAlert, Menu, TerminalSquare, TriangleAlert, WifiOff, Workflow } from 'lucide-react';
import { Sidebar } from '@/components/sidebar';
import { EventDetail } from '@/components/run/event-detail';
import { Kpis } from '@/components/run/kpis';
import { Pipeline } from '@/components/run/pipeline';
import { RunHeader } from '@/components/run/run-header';
import { RunSummary } from '@/components/run/run-summary';
import { Timeline, type Range } from '@/components/run/timeline';
import { TrajectoryTable } from '@/components/run/trajectory-table';
import { Button } from '@/components/ui/button';
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from '@/components/ui/resizable';
import { Sheet, SheetContent, SheetDescription, SheetTitle } from '@/components/ui/sheet';
import { Skeleton } from '@/components/ui/skeleton';
import { clock } from '@/lib/format';
import { useHashRun, useMediaQuery } from '@/lib/hooks';
import { KIND_FILTERS, type KindFilter } from '@/lib/status';
import type { Run } from '@/lib/types';
import { usePreviewStore } from '@/lib/use-previews';
import { useNow, useSnapshot, type Connection } from '@/lib/use-snapshot';
import { cn } from '@/lib/utils';

export function App() {
  const [runKey, selectRun] = useHashRun();
  const { snapshot, connection, receivedAt, pending } = useSnapshot(runKey);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  // The run list stays docked from 1280px; below that it opens as a sheet so the run itself gets the width.
  const docked = useMediaQuery('(min-width: 1280px)');
  const wide = useMediaQuery('(min-width: 1024px)');
  const run = snapshot?.selected ?? null;

  // The hub falls back to the newest active run; pin whatever it shows so reloads keep it.
  useEffect(() => {
    if (!pending && run && run.key !== runKey) selectRun(run.key, { replace: true });
  }, [pending, run, runKey, selectRun]);

  useEffect(() => {
    const name = run ? run.task ?? run.title : null;
    document.title = name ? `${run?.active ? '● ' : ''}${name} · Agent Dispatch` : 'Agent Dispatch';
  }, [run]);

  const onSelectRun = useCallback((key: string) => { selectRun(key); setSidebarOpen(false); }, [selectRun]);
  const openSidebar = docked ? undefined : () => setSidebarOpen(true);
  const switching = pending && Boolean(runKey) && run?.key !== runKey;
  const sidebar = <Sidebar snapshot={snapshot} selected={run?.key ?? runKey} onSelect={onSelectRun} connection={connection} />;

  return (
    <div className="flex h-dvh overflow-hidden bg-background text-foreground">
      {docked
        ? <aside className="w-[284px] shrink-0 border-r">{sidebar}</aside>
        : (
          <Sheet open={sidebarOpen} onOpenChange={setSidebarOpen}>
            <SheetContent side="left" showCloseButton={false} className="p-0 data-[side=left]:w-[340px] data-[side=left]:max-w-[88vw]">
              <SheetTitle className="sr-only">Runs</SheetTitle>
              <SheetDescription className="sr-only">Running and recent delegated runs</SheetDescription>
              {sidebar}
            </SheetContent>
          </Sheet>
        )}
      <main className="flex min-w-0 flex-1 flex-col">
        <ConnectionBanner connection={connection} receivedAt={receivedAt} hasData={Boolean(snapshot)} />
        {!snapshot || switching ? <Loading onOpenSidebar={openSidebar} />
          : run ? <RunView key={run.key} run={run} online={connection === 'live'} wide={wide} onSelectRun={onSelectRun} onOpenSidebar={openSidebar} />
          : <EmptyState hasRecent={snapshot.recent.length > 0} onOpenSidebar={openSidebar} />}
      </main>
    </div>
  );
}

function RunView({ run, online, wide, onSelectRun, onOpenSidebar }: {
  run: Run; online: boolean; wide: boolean; onSelectRun: (key: string) => void; onOpenSidebar?: () => void;
}) {
  const now = useNow(1000, run.active);
  const previews = usePreviewStore(run.key);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [kind, setKind] = useState<KindFilter>('all');
  const [search, setSearch] = useState('');
  const [range, setRange] = useState<Range | null>(null);
  const [follow, setFollow] = useState(run.active);
  const events = run.trajectory.events;
  const selected = useMemo(() => events.find(event => event.id === selectedId) ?? null, [events, selectedId]);
  const roomy = useMediaQuery('(min-width: 1280px)');

  const onSelect = useCallback((id: string | null) => { setSelectedId(id); if (id) setFollow(false); }, []);
  const onRange = useCallback((next: Range | null) => { setRange(next); if (next) setFollow(false); }, []);
  // A timeline click reveals the event even when the table filters hide it.
  const jumpTo = useCallback((id: string) => {
    const event = events.find(e => e.id === id);
    if (event && !(KIND_FILTERS.find(f => f.value === kind)?.test(event) ?? true)) setKind('all');
    if (search) setSearch('');
    if (event && range && !(event.startedAt <= range.end && (event.endedAt ?? event.startedAt) >= range.start)) setRange(null);
    onSelect(id);
  }, [events, kind, search, range, onSelect]);

  const table = (
    <TrajectoryTable run={run} previews={previews} selectedId={selectedId} onSelect={onSelect} kind={kind} onKind={setKind}
      search={search} onSearch={setSearch} range={range} onRange={onRange} follow={follow} onFollow={setFollow} />
  );
  const inspector = selected
    ? <EventDetail key={selected.id} run={run} event={selected} previews={previews} onBack={() => setSelectedId(null)} onSelect={jumpTo} />
    : <RunSummary run={run} now={now} />;

  return (
    <>
      <RunHeader run={run} online={online} onOpenSidebar={onOpenSidebar} />
      <div className={cn('flex min-h-0 flex-1 flex-col', !wide && 'overflow-y-auto')}>
        <div className="space-y-3 px-4 pt-3 pb-3 lg:px-5">
          <Pipeline run={run} now={now} onSelect={onSelectRun} />
          {run.alert && (
            <div role="status" className="flex items-start gap-2 rounded-lg border border-warning/30 bg-warning/8 px-3 py-2 text-[12.5px]">
              <TriangleAlert className="mt-0.5 size-3.5 shrink-0 text-warning" aria-hidden />
              <span className="min-w-0">{run.alert}</span>
            </div>
          )}
          <Kpis run={run} now={now} />
          <Timeline run={run} events={events} selectedId={selectedId} onSelect={jumpTo} range={range} onRange={onRange} />
        </div>
        {wide ? (
          <div className="min-h-[360px] flex-1 border-t">
            <ResizablePanelGroup orientation="horizontal" id="agent-dispatch.workspace">
              <ResizablePanel id="events" defaultSize={roomy ? '62%' : '58%'} minSize="36%">{table}</ResizablePanel>
              <ResizableHandle />
              <ResizablePanel id="inspector" defaultSize={roomy ? '38%' : '42%'} minSize="26%" className="bg-card/40">{inspector}</ResizablePanel>
            </ResizablePanelGroup>
          </div>
        ) : (
          <>
            <div className="h-[70vh] min-h-[380px] shrink-0 border-y">{table}</div>
            <div className="min-h-[60vh] shrink-0"><RunSummary run={run} now={now} /></div>
            <Sheet open={Boolean(selected)} onOpenChange={open => { if (!open) setSelectedId(null); }}>
              <SheetContent side="right" className="p-0 data-[side=right]:w-full data-[side=right]:sm:max-w-[560px]">
                <SheetTitle className="sr-only">Event details</SheetTitle>
                <SheetDescription className="sr-only">Recorded content and fields of the selected event</SheetDescription>
                {selected && <EventDetail key={selected.id} run={run} event={selected} previews={previews} onBack={() => setSelectedId(null)} onSelect={jumpTo} />}
              </SheetContent>
            </Sheet>
          </>
        )}
      </div>
    </>
  );
}

function ConnectionBanner({ connection, receivedAt, hasData }: { connection: Connection; receivedAt: number; hasData: boolean }) {
  if (connection === 'live' || (connection === 'connecting' && !receivedAt)) return null;
  const offline = connection === 'offline' || connection === 'connecting';
  return (
    <div role="status" className={cn('flex items-center gap-2 border-b px-4 py-1.5 text-[11.5px]',
      offline ? 'bg-destructive/8 text-destructive' : 'bg-warning/8 text-warning')}>
      {offline ? <WifiOff className="size-3.5" aria-hidden /> : <CircleAlert className="size-3.5" aria-hidden />}
      {offline ? 'Connection to the dashboard hub lost — reconnecting.' : 'No update for a while — the hub may be busy.'}
      {hasData && receivedAt > 0 && <span className="text-muted-foreground">Showing data from {clock(receivedAt)}. Actions are paused.</span>}
    </div>
  );
}

function Loading({ onOpenSidebar }: { onOpenSidebar?: () => void }) {
  return (
    <div className="flex flex-1 flex-col" aria-busy="true" aria-label="Loading run">
      <div className="flex items-center gap-3 border-b px-4 py-3 lg:px-5">
        {onOpenSidebar && <Button variant="ghost" size="icon" onClick={onOpenSidebar} aria-label="Show runs"><Menu /></Button>}
        <div className="space-y-2"><Skeleton className="h-3 w-48" /><Skeleton className="h-5 w-80 max-w-[60vw]" /></div>
      </div>
      <div className="space-y-3 px-4 py-3 lg:px-5">
        <Skeleton className="h-9 w-96 max-w-full" />
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 xl:grid-cols-6">
          {Array.from({ length: 6 }, (_, i) => <Skeleton key={i} className="h-[62px]" />)}
        </div>
        <Skeleton className="h-28" />
      </div>
      <div className="flex-1 space-y-2 border-t px-4 py-3">
        {Array.from({ length: 8 }, (_, i) => <Skeleton key={i} className="h-9" style={{ opacity: 1 - i * 0.1 }} />)}
      </div>
    </div>
  );
}

function EmptyState({ hasRecent, onOpenSidebar }: { hasRecent: boolean; onOpenSidebar?: () => void }) {
  return (
    <div className="relative flex flex-1 items-center justify-center p-6">
      {onOpenSidebar && <Button variant="ghost" size="icon" className="absolute top-3 left-3" onClick={onOpenSidebar} aria-label="Show runs"><Menu /></Button>}
      <div className="max-w-md text-center">
        <span className="mx-auto grid size-11 place-items-center rounded-xl bg-gradient-to-br from-brand/25 to-kind-model/25 text-brand ring-1 ring-brand/25">
          <Workflow className="size-5" aria-hidden />
        </span>
        <h1 className="mt-4 text-[17px] font-semibold tracking-tight">{hasRecent ? 'Pick a run' : 'No delegated runs yet'}</h1>
        <p className="mt-1.5 text-[13px] text-muted-foreground">
          {hasRecent
            ? 'Nothing is running right now. Choose a recent run from the sidebar to review its trajectory, report and session log.'
            : 'Runs you delegate to ZCode, Codex or AGY show up here live, with every model request and tool call.'}
        </p>
        {!hasRecent && (
          <div className="mx-auto mt-4 inline-flex items-center gap-2 rounded-lg border bg-muted/40 px-3 py-2 font-mono text-[12px]">
            <TerminalSquare className="size-3.5 text-muted-foreground" aria-hidden />agent-dispatch launch --help
          </div>
        )}
        {hasRecent && onOpenSidebar && <Button variant="outline" size="sm" className="mt-4" onClick={onOpenSidebar}>Show runs</Button>}
      </div>
    </div>
  );
}
