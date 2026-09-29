import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  AlertCircle, ArrowLeft, ArrowUpLeft, ChevronLeft, ChevronRight, Circle, CircleCheck, CircleDot, CircleX, Crosshair, ExternalLink, Image, Loader2,
  Maximize2, Minimize2, RefreshCw, Repeat,
} from 'lucide-react';
import { CodeCard, CodeView, CopyButton, Markdown, PatchFileView, UnifiedDiff } from '@/components/code';
import { KindChip } from '@/components/kind-chip';
import { Button } from '@/components/ui/button';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { fetchContent, imageUrl } from '@/lib/api';
import { duration, full, human, num, stamp } from '@/lib/format';
import { langFromPath, langOf, shellLang, type Lang } from '@/lib/highlight';
import { sameCalls } from '@/lib/insights';
import { eventName, isFailed, isRunning, kindMeta } from '@/lib/status';
import {
  actionMs, actionsOf, execCommands, extractPatches, jsonObject, jsonValue, labelledCommands, outputView, parsePatch, parseToolError, parseToolOutput,
  shortPath, type ExecResult, type PatchFile, type ToolAction,
} from '@/lib/tool-content';
import type { ContentSection, EventFocus, Run, TrajectoryEvent } from '@/lib/types';
import { usePreviewVersion, type PreviewStore } from '@/lib/use-previews';
import { cn } from '@/lib/utils';
import { Fields, Heading } from './parts';

type Pages = Record<string, { text: string; nextOffset: number | null }>;

/** A content section with its loaded pages joined, and the control that loads the next one. */
interface Loaded { section: ContentSection; text: string; complete: boolean; more: ReactNode }

/** Tools inherit the turn and step of the request that called them, which links the two both ways. */
function linkedEvents(events: TrajectoryEvent[], event: TrajectoryEvent) {
  if (event.step == null || (event.kind !== 'model' && event.kind !== 'tool')) return [];
  const same = (e: TrajectoryEvent) => e.step === event.step && e.turn === event.turn;
  return event.kind === 'model'
    ? events.filter(e => e.kind === 'tool' && same(e))
    : events.filter(e => e.kind === 'model' && same(e)).slice(-1);
}

/** One trajectory event: its recorded content, a field summary and the raw record. Remount per event. */
export function EventDetail({ run, event, previews, onBack, onSelect, onFocus, maximized, onMaximize }: {
  run: Run; event: TrajectoryEvent; previews: PreviewStore | null; onBack: () => void; onSelect: (id: string) => void;
  onFocus: (focus: EventFocus | null) => void; maximized?: boolean; onMaximize?: () => void;
}) {
  const events = run.trajectory.events;
  const linked = useMemo(() => linkedEvents(events, event), [events, event]);
  const sub = [event.turn ? `Turn ${event.turn}` : null, event.step ? `step ${event.step}` : null, human(event.status)].filter(Boolean).join(' · ');
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="border-b px-4 pt-2.5 pb-3">
        <div className="-ml-2 flex items-center">
          <Button variant="ghost" size="xs" className="text-muted-foreground" onClick={onBack}><ArrowLeft />Run summary</Button>
          {onMaximize && (
            <Button variant="ghost" size="icon-xs" className="ml-auto text-muted-foreground" onClick={onMaximize}
              aria-label={maximized ? 'Restore the trajectory' : 'Widen the event panel'} title={maximized ? 'Restore the trajectory' : 'Widen the event panel'}>
              {maximized ? <Minimize2 /> : <Maximize2 />}
            </Button>
          )}
        </div>
        <div className="mt-1.5 flex min-w-0 items-center gap-2">
          <KindChip kind={event.kind} error={isFailed(event)} />
          <h2 className="min-w-0 truncate text-[14px] font-semibold" title={event.label}>{eventName(event)}</h2>
        </div>
        <div className="mt-1 truncate text-[11.5px] text-muted-foreground">
          {event.kind === 'model' && event.label !== eventName(event) ? `${event.label} · ` : ''}{sub}
          {isRunning(event) ? ' · running' : event.endedAt ? ` · ${duration(event.endedAt - event.startedAt)}` : ''}
        </div>
        {linked.length > 0 && <Linked event={event} linked={linked} onSelect={onSelect} />}
        {event.kind === 'tool' && <SameCalls events={events} event={event} previews={previews} onSelect={onSelect} onFocus={onFocus} />}
      </div>
      <Tabs defaultValue="content" className="flex min-h-0 flex-1 flex-col gap-0">
        <TabsList variant="line" className="h-9 w-full justify-start gap-3 border-b px-4">
          <TabsTrigger value="content" className="flex-none px-0.5">Content</TabsTrigger>
          <TabsTrigger value="details" className="flex-none px-0.5">Details</TabsTrigger>
          <TabsTrigger value="raw" className="flex-none px-0.5">Raw</TabsTrigger>
        </TabsList>
        <TabsContent value="content" className="min-h-0 flex-1 overflow-y-auto px-4 py-3"><Content run={run} event={event} /></TabsContent>
        <TabsContent value="details" className="min-h-0 flex-1 overflow-y-auto px-4 py-3"><Details event={event} previews={previews} /></TabsContent>
        <TabsContent value="raw" className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
          <CodeCard text={JSON.stringify(event, null, 2)} lang="json" title="Event record" maxLines={0} />
        </TabsContent>
      </Tabs>
    </div>
  );
}

function Linked({ event, linked, onSelect }: { event: TrajectoryEvent; linked: TrajectoryEvent[]; onSelect: (id: string) => void }) {
  const shown = linked.slice(0, 8);
  return (
    <div className="mt-2 flex flex-wrap items-center gap-1 text-[11px] text-muted-foreground">
      <span className="mr-0.5">{event.kind === 'model' ? `Called ${linked.length} tool${linked.length > 1 ? 's' : ''}` : 'Called by'}</span>
      {shown.map(e => {
        const Icon = event.kind === 'model' ? kindMeta(e.kind).icon : ArrowUpLeft;
        return (
          <button key={e.id} type="button" onClick={() => onSelect(e.id)} title={e.label}
            className={cn('inline-flex max-w-44 items-center gap-1 rounded-md border bg-background/60 px-1.5 py-0.5 text-foreground/85 transition-colors hover:bg-accent',
              isFailed(e) && 'border-destructive/40 text-destructive', isRunning(e) && 'border-running/40')}>
            <Icon className="size-3 shrink-0 opacity-70" aria-hidden />
            <span className="truncate">{eventName(e)}</span>
          </button>
        );
      })}
      {linked.length > shown.length && <span>+{linked.length - shown.length} more</span>}
    </div>
  );
}

/** Repeats of this exact call (same tool, same input): a retry loop or a redundant check is visible at once. */
function SameCalls({ events, event, previews, onSelect, onFocus }: {
  events: TrajectoryEvent[]; event: TrajectoryEvent; previews: PreviewStore | null; onSelect: (id: string) => void; onFocus: (focus: EventFocus | null) => void;
}) {
  useEffect(() => { previews?.request(events.filter(e => e.kind === 'tool' && e.label === event.label)); }, [previews, events, event.label]);
  const version = usePreviewVersion(previews);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const same = useMemo(() => sameCalls(events, previews, event), [events, previews, version, event]);
  if (same.length < 2) return null;
  const at = same.findIndex(e => e.id === event.id), failed = same.filter(isFailed).length;
  const text = previews?.get(event.id)?.text ?? event.label;
  return (
    <div className={cn('mt-2 flex items-center gap-1.5 rounded-md border px-2 py-1 text-[11px]', failed > 1 ? 'border-destructive/30 bg-destructive/[0.04]' : 'bg-muted/30')}>
      <Repeat className={cn('size-3 shrink-0', failed > 1 ? 'text-destructive' : 'text-muted-foreground')} aria-hidden />
      <span className="min-w-0 truncate">
        Same call ran <span className="font-medium tabular">{same.length}×</span>
        {failed > 0 && <span className="text-destructive"> · {failed} failed</span>}
        <span className="text-muted-foreground tabular"> · #{at + 1}</span>
      </span>
      <span className="ml-auto flex shrink-0 items-center">
        <Button variant="ghost" size="icon-xs" className="size-5" disabled={at <= 0} onClick={() => onSelect(same[at - 1].id)} aria-label="Previous run of this call"><ChevronLeft /></Button>
        <Button variant="ghost" size="icon-xs" className="size-5" disabled={at >= same.length - 1} onClick={() => onSelect(same[at + 1].id)} aria-label="Next run of this call"><ChevronRight /></Button>
        <Button variant="ghost" size="xs" className="h-5 gap-1 px-1.5 text-[11px]" onClick={() => onFocus({ label: `${event.label} ×${same.length}: ${text}`, ids: new Set(same.map(e => e.id)) })}>
          <Crosshair className="size-3" aria-hidden />Show all
        </Button>
      </span>
    </div>
  );
}

// ── Content ──────────────────────────────────────────────────────────────────────────────────────

function Content({ run, event }: { run: Run; event: TrajectoryEvent }) {
  const client = useQueryClient();
  const [pages, setPages] = useState<Pages>({});
  const [loadingMore, setLoadingMore] = useState<string | null>(null);
  const [moreError, setMoreError] = useState<string | null>(null);
  // Expanded sections stay stable until the user refreshes them.
  const frozen = Object.keys(pages).length > 0;
  const live = run.active && (isRunning(event) || event.kind === 'model' && !event.endedAt);
  const query = useQuery({
    // Completion changes the key so the last streamed response is not cached as the final result.
    queryKey: ['content', run.key, event.id, event.status, event.endedAt ?? null, run.active],
    queryFn: ({ signal }) => fetchContent(run.key, event.id, undefined, signal),
    refetchInterval: live && !frozen ? 3000 : false,
    staleTime: live ? 0 : Infinity,
    gcTime: 120_000,
  });

  const loadMore = async (section: ContentSection, nextOffset: number) => {
    setLoadingMore(section.field);
    setMoreError(null);
    try {
      const result = await fetchContent(run.key, event.id, { field: section.field, offset: nextOffset });
      const page = result.sections.find(s => s.field === section.field);
      if (page) setPages(current => ({ ...current, [section.field]: { text: (current[section.field]?.text ?? '') + page.text, nextOffset: page.nextOffset ?? null } }));
    } catch (error) { setMoreError((error as Error).message); }
    finally { setLoadingMore(null); }
  };

  const refresh = () => { setPages({}); void client.invalidateQueries({ queryKey: ['content', run.key, event.id] }); };

  const sections = useMemo<Loaded[]>(() => (query.data?.sections ?? []).map(section => {
    const extra = pages[section.field];
    const text = section.text + (extra?.text ?? ''), nextOffset = extra ? extra.nextOffset : section.nextOffset ?? null;
    return {
      section, text, complete: nextOffset == null,
      more: nextOffset != null && (
        <div className="mt-2 flex items-center gap-2 text-[11px] text-muted-foreground">
          <span className="tabular">{full(nextOffset)} of {full(section.totalChars)} characters</span>
          <Button variant="outline" size="xs" disabled={loadingMore !== null} onClick={() => void loadMore(section, nextOffset)}>
            {loadingMore === section.field && <Loader2 className="animate-spin" />}Load more
          </Button>
        </div>
      ),
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }), [query.data, pages, loadingMore]);

  if (query.isPending) {
    return <div className="space-y-2.5"><Skeleton className="h-4 w-28" /><Skeleton className="h-24 w-full" /><Skeleton className="h-4 w-20" /><Skeleton className="h-16 w-full" /></div>;
  }
  if (query.isError) {
    return (
      <div className="flex flex-col items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-xs">
        <span className="flex items-center gap-1.5 text-destructive"><AlertCircle className="size-3.5" />{(query.error as Error).message}</span>
        <Button variant="outline" size="xs" onClick={() => void query.refetch()}><RefreshCw />Retry</Button>
      </div>
    );
  }
  const content = query.data;
  return (
    <div className="space-y-5">
      {content.note && <p className="rounded-md bg-muted/60 px-2.5 py-2 text-[11.5px] text-muted-foreground">{content.note}</p>}
      {!content.sections.length && !content.note && <p className="text-xs text-muted-foreground">No content was recorded for this event.</p>}
      {event.kind === 'tool'
        ? <ToolContent run={run} event={event} sections={sections} />
        : sections.map(loaded => <MessageSection key={loaded.section.field} loaded={loaded} />)}
      {moreError && <p className="text-[11.5px] text-destructive">{moreError}</p>}
      <div className="flex items-center gap-2 border-t pt-3 text-[11px] text-muted-foreground">
        <Button variant="ghost" size="xs" onClick={refresh} disabled={query.isFetching}>
          <RefreshCw className={cn(query.isFetching && 'animate-spin')} />Refresh
        </Button>
        <span>{frozen && live ? 'Auto refresh paused while expanded · ' : live ? 'Refreshing every 3s · ' : ''}Read from the local session; no model requests.</span>
      </div>
    </div>
  );
}

/** Section heading with its own controls. */
function Part({ title, aside, controls, children }: { title: string; aside?: ReactNode; controls?: ReactNode; children: ReactNode }) {
  return (
    <section className="min-w-0">
      <div className="mb-1.5 flex min-h-5 items-center gap-2">
        <h3 className="shrink-0 text-[10.5px] font-semibold tracking-wider text-muted-foreground uppercase">{title}</h3>
        <span className="flex min-w-0 items-center gap-1.5 overflow-hidden">{aside}</span>
        <span className="ml-auto flex shrink-0 items-center gap-0.5">{controls}</span>
      </div>
      <div className="space-y-2">{children}</div>
    </section>
  );
}

const Toggle = ({ on, onChange, children }: { on: boolean; onChange: (on: boolean) => void; children: ReactNode }) => (
  <Button variant="ghost" size="xs" aria-pressed={on} className={cn('h-5 px-1.5 text-[10.5px]', on ? 'bg-muted text-foreground' : 'text-muted-foreground')} onClick={() => onChange(!on)}>
    {children}
  </Button>
);

const Chip = ({ children, tone, title }: { children: ReactNode; tone?: 'danger' | 'success' | 'warning'; title?: string }) => (
  <span title={title} className={cn('inline-flex h-[18px] shrink-0 items-center rounded px-1.5 text-[10.5px] font-medium tabular',
    tone === 'danger' ? 'bg-destructive/12 text-destructive' : tone === 'success' ? 'bg-success/12 text-success' : tone === 'warning' ? 'bg-warning/14 text-warning' : 'bg-muted text-muted-foreground')}>
    {children}
  </span>
);

const ExitChip = ({ code, running }: { code?: number | null; running?: boolean }) =>
  running ? <Chip>running</Chip> : code == null ? null : <Chip tone={code === 0 ? 'success' : 'danger'}>exit {code}</Chip>;

/** Output size matters for context: big outputs are what later forces compaction. */
const TokensChip = ({ tokens }: { tokens?: number }) => tokens == null ? null : (
  <Chip tone={tokens >= 8000 ? 'warning' : undefined} title={`${full(tokens)} tokens of output returned to the model`}>{num(tokens)} tok</Chip>
);

// ── Messages ─────────────────────────────────────────────────────────────────────────────────────

function MessageSection({ loaded }: { loaded: Loaded }) {
  const { section, text, more } = loaded;
  const json = useMemo(() => (jsonValue(text) !== undefined ? JSON.stringify(jsonValue(text), null, 2) : null), [text]);
  const [source, setSource] = useState(false);
  const [open, setOpen] = useState(false);
  if (section.field === 'reasoning') {
    return (
      <Collapsible open={open} onOpenChange={setOpen} className="rounded-lg border border-dashed">
        <div className="flex items-center gap-2 px-2.5 py-1.5">
          <CollapsibleTrigger className="flex flex-1 items-center gap-1.5 text-[11.5px] text-muted-foreground hover:text-foreground">
            <ChevronRight className={cn('size-3.5 transition-transform', open && 'rotate-90')} />{open ? 'Hide thinking' : 'Show thinking'}
            <span className="text-muted-foreground/70 tabular">· {num(section.totalChars)} chars</span>
          </CollapsibleTrigger>
          <CopyButton text={text} label="thinking" />
        </div>
        <CollapsibleContent className="px-3 pb-2.5">
          <Markdown text={text} className="text-muted-foreground" />
          {more}
        </CollapsibleContent>
      </Collapsible>
    );
  }
  return (
    <Part title={section.title} aside={section.totalChars > 2000 && <span className="text-[10.5px] text-muted-foreground/70 tabular">{num(section.totalChars)} chars</span>}
      controls={<>
        {!json && <Toggle on={source} onChange={setSource}>Source</Toggle>}
        <CopyButton text={text} label={section.title.toLowerCase()} />
      </>}>
      {json ? <CodeCard text={json} lang="json" title="JSON" maxLines={40} />
        : source ? <CodeCard text={text} lang="markdown" title="Markdown" maxLines={0} />
        : <Markdown text={text} className={cn('rounded-lg border bg-background/50 px-3.5 py-2.5', section.field === 'error' && 'border-destructive/30')} />}
      {more}
    </Part>
  );
}

// ── Tool calls ───────────────────────────────────────────────────────────────────────────────────

function ToolContent({ run, event, sections }: { run: Run; event: TrajectoryEvent; sections: Loaded[] }) {
  const input = sections.find(s => s.section.field === 'input');
  const output = sections.find(s => s.section.field === 'output');
  const error = sections.find(s => s.section.field === 'error');
  const args = useMemo(() => (input?.complete ? jsonObject(input.text) : null), [input?.text, input?.complete]);
  const code = typeof args?.code === 'string' ? args.code : '';
  const labels = useMemo(() => labelledCommands(code), [code]);
  const actions = actionsOf(args);
  const command = typeof args?.command === 'string' ? args.command : undefined;
  // The command a lone result belongs to, for choosing how to show its output.
  const soleCommand = useMemo(() => {
    if (command && actions.length <= 1) return command;
    if (!command && !labels.size) { const cmds = execCommands(code); if (cmds.length === 1) return cmds[0]; }
    return undefined;
  }, [command, actions.length, labels, code]);
  return (
    <>
      {error && <ErrorCallout loaded={error} command={command} project={run.project} />}
      {input && <CallView loaded={input} args={args} labels={labels} project={run.project} />}
      {output && <ResultView loaded={output} labels={labels} soleCommand={soleCommand} failed={isFailed(event)}
        imageSrc={index => imageUrl(run.key, event.id, index)} />}
    </>
  );
}

const PATCH_MISS = /^(?:Failed to find expected lines in|Failed to find context .*? in) (.+?):\s*\n([\s\S]*)$/;

function ErrorCallout({ loaded, command, project }: { loaded: Loaded; command?: string; project: string }) {
  const error = useMemo(() => parseToolError(loaded.text), [loaded.text]);
  const miss = error.detail ? PATCH_MISS.exec(error.detail) : null;
  const showCommand = error.command && error.command.trim() !== command?.trim();
  return (
    <div className="min-w-0 overflow-hidden rounded-lg border border-destructive/35 bg-destructive/[0.05]">
      <div className="flex min-h-8 items-center gap-2 py-1 pr-1 pl-3">
        <CircleX className="size-3.5 shrink-0 text-destructive" aria-hidden />
        <span className="min-w-0 truncate text-[12.5px] font-medium text-destructive" title={error.title}>{error.title}</span>
        <ExitChip code={error.exitCode} />
        <CopyButton text={loaded.text} label="error" className="ml-auto" />
      </div>
      {miss ? (
        <div className="border-t border-destructive/20 px-3 pt-2 pb-2.5">
          <p className="mb-1.5 text-[11.5px] text-muted-foreground">
            These lines were not found in <span className="font-mono text-foreground">{shortPath(miss[1], project)}</span> — the file changed or was never read.
          </p>
          <div className="overflow-hidden rounded-md border bg-background/70"><CodeView text={miss[2].replace(/\n+$/, '')} lang={langFromPath(miss[1])} maxLines={14} /></div>
        </div>
      ) : showCommand ? (
        <div className="border-t border-destructive/20 bg-background/40"><CodeView text={error.command!} lang={shellLang(error.command!)} maxLines={10} /></div>
      ) : error.detail ? (
        <div className="border-t border-destructive/20 bg-background/40"><CodeView text={error.detail} lang={jsonValue(error.detail) !== undefined ? 'json' : null} maxLines={16} /></div>
      ) : null}
      {loaded.more && <div className="px-3 pb-2">{loaded.more}</div>}
    </div>
  );
}

const CONSUMED = new Set(['actions', 'command', 'code', 'description', 'cwd', 'workdir', 'exitCode', 'duration_ms', 'path', 'todos',
  'oldString', 'newString', 'old_string', 'new_string', 'filePath', 'file_path', 'replaceAll', 'replace_all']);
const PROSE_KEY = /^(prompt|description|message|text|instructions?|content|summary|reason|explanation|plan|query|question)$/i;

function CallView({ loaded, args, labels, project }: { loaded: Loaded; args: Record<string, unknown> | null; labels: Map<string, string>; project: string }) {
  const [raw, setRaw] = useState(false);
  const structured = args && Object.keys(args).length > 0;
  return (
    <Part title="Call" controls={<>
      {structured && <Toggle on={raw} onChange={setRaw}>Raw</Toggle>}
      <CopyButton text={loaded.text} label="tool input" />
    </>}>
      {!structured || raw
        ? <CodeCard text={loaded.text} lang={/^\s*[[{]/.test(loaded.text) ? 'json' : null} title="Input" maxLines={raw ? 0 : 40} />
        : <Arguments args={args} labels={labels} project={project} />}
      {loaded.more}
    </Part>
  );
}

function Arguments({ args, labels, project }: { args: Record<string, unknown>; labels: Map<string, string>; project: string }) {
  const actions = actionsOf(args);
  const str = (key: string) => (typeof args[key] === 'string' && (args[key] as string).trim() ? args[key] as string : undefined);
  const command = str('command'), code = str('code') ?? '', description = str('description');
  const patches = useMemo(() => Object.entries(args).flatMap(([key, value]) =>
    typeof value === 'string' && value.includes('*** Begin Patch') ? extractPatches(value).flatMap(parsePatch).map(file => ({ key, file })) : []), [args]);
  const editFile = str('filePath') ?? str('file_path') ?? str('path');
  const oldText = str('oldString') ?? str('old_string'), newText = typeof (args.newString ?? args.new_string) === 'string' ? (args.newString ?? args.new_string) as string : undefined;
  const replacement: PatchFile | null = newText != null && (oldText != null || editFile) ? {
    op: oldText ? 'update' : 'add', path: editFile ?? 'file',
    lines: [...(oldText ?? '').split('\n').filter((_, i, all) => oldText != null && (i < all.length - 1 || all[i])).map(text => ({ type: 'del' as const, text })),
      ...newText.split('\n').map(text => ({ type: 'add' as const, text }))],
    added: newText.split('\n').length, removed: oldText ? oldText.split('\n').length : 0,
  } : null;
  const commands: [string | null, string][] = !command && code ? (labels.size ? [...labels] : execCommands(code).map(c => [null, c])) : [];
  const single = actions.length <= 1 ? actions[0] : undefined;
  const cwd = str('cwd') ?? str('workdir') ?? single?.cwd;
  const exit = typeof args.exitCode === 'number' ? args.exitCode : single?.exitCode;
  const ms = single ? actionMs(single) : null;
  const shown = Boolean(command || patches.length || replacement || commands.length);
  const extra = Object.entries(args).filter(([key, value]) => !CONSUMED.has(key) && !patches.some(p => p.key === key) && value !== undefined && value !== null && value !== '');
  const scalars = extra.filter(([, value]) => typeof value !== 'object' && !(typeof value === 'string' && (value.includes('\n') || value.length > 100)));
  const blocks = extra.filter(entry => !scalars.includes(entry));
  const fields: [string, ReactNode][] = [
    ['Path', !patches.length && !replacement && str('path') ? <span className="font-mono text-[11.5px] break-all">{shortPath(str('path')!, project)}</span> : null],
    ['Working dir', cwd && !command ? <span className="font-mono text-[11.5px] break-all">{cwd}</span> : null],
    ['Duration', typeof args.duration_ms === 'number' ? duration(args.duration_ms) : null],
    ...scalars.map(([key, value]): [string, ReactNode] => [key, <span className="font-mono text-[11.5px] break-all">{String(value)}</span>]),
  ];

  return (
    <>
      {description && !code.includes(description) && <p className="text-[12.5px] leading-relaxed">{description}</p>}
      {command && (actions.length > 1 && actions.every(a => a.command)
        ? <ActionList actions={actions} labels={labels} />
        : (
          <CodeCard text={command} lang={shellLang(command)} title="Command" maxLines={16}
            meta={cwd && <span className="truncate font-mono" title={cwd}>{shortPath(cwd, project) === cwd ? cwd : shortPath(cwd, project) || '.'}</span>}
            actions={<><ExitChip code={exit} />{ms != null && <Chip>{duration(ms)}</Chip>}</>} />
        ))}
      {commands.length > 0 && <CommandList commands={commands} />}
      {patches.length > 0 && (
        <div className="space-y-2">
          {patches.length > 1 && (
            <p className="text-[11px] text-muted-foreground tabular">
              {patches.length} files · <span className="text-success">+{patches.reduce((n, p) => n + p.file.added, 0)}</span>{' '}
              <span className="text-destructive">−{patches.reduce((n, p) => n + p.file.removed, 0)}</span>
            </p>
          )}
          {patches.map(({ file }, i) => <PatchFileView key={i} file={file} project={project} />)}
        </div>
      )}
      {replacement && <PatchFileView file={replacement} project={project} />}
      {Array.isArray(args.todos) && <TodoList todos={args.todos} />}
      <Fields fields={fields} />
      {blocks.map(([key, value]) => typeof value === 'string'
        ? PROSE_KEY.test(key)
          ? <div key={key}><div className="mb-1 font-mono text-[10.5px] text-muted-foreground">{key}</div><Markdown text={value} className="rounded-lg border bg-background/50 px-3.5 py-2.5" /></div>
          : <CodeCard key={key} text={value} lang={langFor(key, value, editFile)} title={key} maxLines={30} />
        : <CodeCard key={key} text={JSON.stringify(value, null, 2)} lang="json" title={key} maxLines={30} />)}
      {code && (shown || fields.some(([, v]) => v) ? <Script code={code} /> : <CodeCard text={code} lang="javascript" title="Script" maxLines={40} />)}
    </>
  );
}

function langFor(key: string, value: string, file?: string): Lang | null {
  if (/content|text|source|code|new|old/i.test(key) && file) return langFromPath(file);
  if (/^(code|script|js)$/i.test(key)) return 'javascript';
  if (/command|cmd/i.test(key)) return shellLang(value);
  if (/patch|diff/i.test(key)) return 'diff';
  return jsonValue(value) !== undefined ? 'json' : langOf(key);
}

/** The code-mode script that ran the calls above, collapsed: the command and patch views already show what it did. */
function Script({ code }: { code: string }) {
  const [open, setOpen] = useState(false);
  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger className="flex items-center gap-1.5 text-[11.5px] text-muted-foreground hover:text-foreground">
        <ChevronRight className={cn('size-3.5 transition-transform', open && 'rotate-90')} />
        {open ? 'Hide script' : 'Show script'}<span className="text-muted-foreground/70 tabular">· {code.split('\n').length} lines of JavaScript</span>
      </CollapsibleTrigger>
      <CollapsibleContent className="pt-1.5"><CodeCard text={code} lang="javascript" title="Script" maxLines={40} /></CollapsibleContent>
    </Collapsible>
  );
}

const ACTION_ICON = { completed: CircleCheck, failed: CircleX, running: CircleDot } as const;

function ActionList({ actions, labels }: { actions: ToolAction[]; labels: Map<string, string> }) {
  const byCommand = useMemo(() => new Map([...labels].map(([label, command]) => [command.trim(), label])), [labels]);
  const all = actions.map(a => a.command).join('\n');
  return (
    <div className="min-w-0 overflow-hidden rounded-lg border bg-background/70">
      <div className="flex min-h-7 items-center gap-2 border-b bg-muted/45 py-0.5 pr-1 pl-2.5 text-[11px]">
        <span className="font-medium text-foreground/85">Commands</span>
        <span className="text-muted-foreground tabular">{actions.length} in one call</span>
        <CopyButton text={all} label="commands" className="ml-auto" />
      </div>
      {actions.map((action, i) => {
        const failed = action.status === 'failed' || (action.exitCode != null && action.exitCode !== 0);
        const Icon = failed ? ACTION_ICON.failed : ACTION_ICON[action.status as keyof typeof ACTION_ICON] ?? Circle;
        const label = byCommand.get(action.command!.trim()), ms = actionMs(action);
        return (
          <div key={i} className={cn('border-b border-border/60 last:border-0', failed && 'bg-destructive/[0.035]')}>
            <div className="flex items-center gap-1.5 px-2.5 pt-1.5 text-[11px]">
              <Icon className={cn('size-3 shrink-0', failed ? 'text-destructive' : action.status === 'completed' ? 'text-success' : 'text-muted-foreground')} aria-hidden />
              <span className="font-medium text-muted-foreground tabular">{i + 1}</span>
              {label && <span className="truncate font-medium">{label}</span>}
              <span className="ml-auto flex items-center gap-1"><ExitChip code={action.exitCode} />{ms != null && <Chip>{duration(ms)}</Chip>}</span>
            </div>
            <CodeView text={action.command!} lang={shellLang(action.command!)} maxLines={8} className="pt-0.5 pb-1.5" />
          </div>
        );
      })}
    </div>
  );
}

function CommandList({ commands }: { commands: [string | null, string][] }) {
  return (
    <div className="min-w-0 overflow-hidden rounded-lg border bg-background/70">
      <div className="flex min-h-7 items-center gap-2 border-b bg-muted/45 py-0.5 pr-1 pl-2.5 text-[11px]">
        <span className="font-medium text-foreground/85">{commands.length > 1 ? 'Commands' : 'Command'}</span>
        {commands.length > 1 && <span className="text-muted-foreground tabular">{commands.length} from the script</span>}
        <CopyButton text={commands.map(([, c]) => c).join('\n')} label="commands" className="ml-auto" />
      </div>
      {commands.map(([label, command], i) => (
        <div key={i} className="border-b border-border/60 last:border-0">
          {label && <div className="px-2.5 pt-1.5 text-[11px] font-medium">{label}</div>}
          <CodeView text={command} lang={shellLang(command)} maxLines={8} className={cn(label && 'pt-0.5')} />
        </div>
      ))}
    </div>
  );
}

function TodoList({ todos }: { todos: unknown[] }) {
  return (
    <ol className="space-y-0.5 rounded-lg border px-2 py-1.5">
      {todos.map((todo, i) => {
        const item = (todo ?? {}) as { content?: string; status?: string };
        const Icon = item.status === 'completed' ? CircleCheck : item.status === 'in_progress' ? CircleDot : Circle;
        return (
          <li key={i} className="flex gap-2 px-1 py-0.5 text-[12px]">
            <Icon className={cn('mt-0.5 size-3.5 shrink-0', item.status === 'completed' ? 'text-success' : item.status === 'in_progress' ? 'text-running' : 'text-muted-foreground')} aria-hidden />
            <span className={cn(item.status === 'completed' && 'text-muted-foreground')}>{item.content ?? JSON.stringify(todo)}</span>
          </li>
        );
      })}
    </ol>
  );
}

function ResultView({ loaded, labels, soleCommand, failed, imageSrc }: {
  loaded: Loaded; labels: Map<string, string>; soleCommand?: string; failed: boolean; imageSrc: (index: number) => string;
}) {
  const [raw, setRaw] = useState(false);
  const output = useMemo(() => parseToolOutput(loaded.text), [loaded.text]);
  const execs = output.parts.filter(p => p.type === 'exec').length;
  const images = output.parts.flatMap(p => (p.type === 'image' ? [p.index] : []));
  return (
    <Part title="Result"
      aside={<>
        {output.status && (
          <Chip tone={output.status === 'failed' ? 'danger' : undefined} title="The code-mode script that ran the call; commands inside it report their own exit codes">
            script {output.status}
          </Chip>
        )}
        {output.wallSeconds != null && <Chip title="Wall time of the whole call">{duration(output.wallSeconds * 1000)}</Chip>}
        {execs > 1 && <Chip>{execs} results</Chip>}
      </>}
      controls={<>
        <Toggle on={raw} onChange={setRaw}>Raw</Toggle>
        <CopyButton text={loaded.text} label="tool result" />
      </>}>
      {raw ? <CodeCard text={loaded.text} title="Output" maxLines={0} />
        : !output.parts.length ? <p className="rounded-lg border border-dashed px-3 py-2 text-[11.5px] text-muted-foreground">No output.</p>
        : output.parts.map((part, i) => {
          if (part.type === 'exec') return <ExecBlock key={i} exec={part.exec} command={part.exec.label ? labels.get(part.exec.label) : execs === 1 ? soleCommand : undefined} />;
          if (part.type === 'json') return <CodeCard key={i} text={part.text} lang="json" title="JSON" maxLines={30} />;
          if (part.type === 'error') return <CodeCard key={i} text={part.text} title="Script error" tone="danger" maxLines={20} />;
          // Consecutive images share one gallery, placed where the first of them appears.
          if (part.type === 'image') {
            if (output.parts[i - 1]?.type === 'image') return null;
            const group: number[] = [];
            for (let j = i; output.parts[j]?.type === 'image'; j++) group.push((output.parts[j] as { index: number }).index);
            return <ImageGallery key={i} indexes={group} all={images} src={imageSrc} />;
          }
          return <OutputBlock key={i} text={part.text} command={soleCommand} title="Output" tone={failed && output.parts.length === 1 ? 'danger' : undefined} />;
        })}
      {loaded.more}
    </Part>
  );
}

// ── Images ───────────────────────────────────────────────────────────────────────────────────────

/** Images a tool returned to the model, as the model saw them. Codex keeps them in its session log; other workers do not. */
function ImageGallery({ indexes, all, src }: { indexes: number[]; all: number[]; src: (index: number) => string }) {
  const [open, setOpen] = useState<number | null>(null);
  const [missing, setMissing] = useState(false);
  if (missing) {
    return (
      <p className="flex items-center gap-2 rounded-lg border border-dashed px-3 py-2 text-[11.5px] text-muted-foreground">
        <Image className="size-3.5" aria-hidden />
        Returned {indexes.length > 1 ? `${indexes.length} images` : 'an image'} to the model; this run's session log did not keep {indexes.length > 1 ? 'them' : 'it'}.
      </p>
    );
  }
  const single = indexes.length === 1;
  const label = (index: number) => (all.length > 1 ? `Image ${index + 1} of ${all.length}` : 'Image');
  return (
    <>
      <div className={cn('grid gap-2', !single && 'grid-cols-[repeat(auto-fill,minmax(10rem,1fr))]')}>
        {indexes.map(index => (
          <ImageThumb key={index} src={src(index)} label={label(index)} single={single} onOpen={() => setOpen(index)} onMissing={() => setMissing(true)} />
        ))}
      </div>
      <ImageViewer open={open} all={all} src={src} label={label} onOpen={setOpen} />
    </>
  );
}

function ImageThumb({ src, label, single, onOpen, onMissing }: { src: string; label: string; single: boolean; onOpen: () => void; onMissing: () => void }) {
  const [size, setSize] = useState<string | null>(null);
  return (
    <button type="button" onClick={onOpen} title="Open full size"
      className="group/image relative flex min-h-24 items-center justify-center overflow-hidden rounded-lg border bg-muted/40 outline-none transition-colors hover:border-primary/50 focus-visible:ring-2 focus-visible:ring-ring/40">
      <img src={src} alt={label} loading="lazy" decoding="async" onError={onMissing}
        onLoad={e => setSize(`${e.currentTarget.naturalWidth}×${e.currentTarget.naturalHeight}`)}
        className={cn('block w-full object-contain', single ? 'max-h-96' : 'aspect-[4/3]')} />
      <span className="pointer-events-none absolute bottom-1.5 left-1.5 rounded bg-background/85 px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
        {label}{size && ` · ${size}`}
      </span>
      <Maximize2 className="pointer-events-none absolute top-1.5 right-1.5 size-6 rounded bg-background/85 p-1 text-muted-foreground opacity-0 transition-opacity group-hover/image:opacity-100" aria-hidden />
    </button>
  );
}

/** Full-size view; ←/→ step through the call's images. */
function ImageViewer({ open, all, src, label, onOpen }: {
  open: number | null; all: number[]; src: (index: number) => string; label: (index: number) => string; onOpen: (index: number | null) => void;
}) {
  const [size, setSize] = useState<string | null>(null);
  useEffect(() => setSize(null), [open]);
  const at = open == null ? -1 : all.indexOf(open);
  const go = (step: number) => { if (at >= 0) onOpen(all[(at + step + all.length) % all.length]); };
  return (
    <Dialog open={open != null} onOpenChange={value => { if (!value) onOpen(null); }}>
      {/* Centred by inset + auto margins: a box placed at left 50% could only grow to half the screen. */}
      <DialogContent className="inset-0 m-auto flex h-fit max-h-[94vh] w-fit max-w-[96vw] translate-x-0 translate-y-0 flex-col gap-2 p-2 sm:max-w-[96vw]"
        onKeyDown={e => { if (all.length > 1 && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) { e.preventDefault(); go(e.key === 'ArrowRight' ? 1 : -1); } }}>
        <div className="flex min-h-7 items-center gap-2 pr-9 pl-1">
          <DialogTitle className="flex items-center gap-1.5 text-xs font-medium"><Image className="size-3.5" aria-hidden />{open != null && label(open)}</DialogTitle>
          {size && <span className="font-mono text-[11px] text-muted-foreground">{size}</span>}
          <DialogDescription className="sr-only">The image as the tool returned it to the model.</DialogDescription>
          <span className="ml-auto flex items-center gap-0.5">
            {all.length > 1 && (
              <>
                <Button variant="ghost" size="icon-sm" aria-label="Previous image" onClick={() => go(-1)}><ChevronLeft /></Button>
                <Button variant="ghost" size="icon-sm" aria-label="Next image" onClick={() => go(1)}><ChevronRight /></Button>
              </>
            )}
            {open != null && (
              <Button variant="ghost" size="sm" asChild>
                <a href={src(open)} target="_blank" rel="noreferrer">Open in tab<ExternalLink data-icon="inline-end" /></a>
              </Button>
            )}
          </span>
        </div>
        {open != null && (
          <img key={open} src={src(open)} alt={label(open)} onLoad={e => setSize(`${e.currentTarget.naturalWidth}×${e.currentTarget.naturalHeight}`)}
            className="mx-auto block max-h-[calc(94vh-3.25rem)] max-w-full rounded-md object-contain" />
        )}
      </DialogContent>
    </Dialog>
  );
}

function OutputBlock({ text, command, title, meta, actions, tone }: {
  text: string; command?: string; title: ReactNode; meta?: ReactNode; actions?: ReactNode; tone?: 'danger';
}) {
  const view = useMemo(() => outputView(text, command), [text, command]);
  if (view.kind === 'diff') return <UnifiedDiff text={text} title={title} meta={meta} actions={actions} maxLines={40} />;
  // A failure explains itself at the end of the output, so a failed block shows its last lines.
  return <CodeCard text={view.lang === 'json' ? JSON.stringify(jsonValue(text), null, 2) : text} lang={view.lang} title={title} meta={meta} actions={actions} tone={tone}
    maxLines={30} tail={tone === 'danger' && view.lang !== 'json'} />;
}

function ExecBlock({ exec, command }: { exec: ExecResult; command?: string }) {
  const failed = exec.rejected || (exec.exitCode != null && exec.exitCode !== 0);
  const meta = command && <span className="truncate font-mono" title={command}>{command.replace(/\s+/g, ' ')}</span>;
  const actions = <>
    <ExitChip code={exec.exitCode} running={exec.running} />
    {exec.rejected && <Chip tone="danger">rejected</Chip>}
    {exec.wallSeconds != null && <Chip>{duration(exec.wallSeconds * 1000)}</Chip>}
    <TokensChip tokens={exec.tokens} />
  </>;
  if (!exec.output.trim()) {
    return (
      <div className={cn('flex min-h-7 min-w-0 items-center gap-2 rounded-lg border bg-muted/30 py-0.5 pr-2 pl-2.5 text-[11px]', failed && 'border-destructive/35')}>
        <span className="shrink-0 font-medium text-foreground/85">{exec.label ?? 'Output'}</span>
        <span className="flex min-w-0 flex-1 items-center overflow-hidden text-muted-foreground">{meta}</span>
        <span className="shrink-0 text-muted-foreground italic">no output</span>
        {actions}
      </div>
    );
  }
  return <OutputBlock text={exec.output} command={command} title={exec.label ?? 'Output'} meta={meta} actions={actions} tone={failed ? 'danger' : undefined} />;
}

// ── Details ──────────────────────────────────────────────────────────────────────────────────────

function Details({ event, previews }: { event: TrajectoryEvent; previews: PreviewStore | null }) {
  const ms = event.endedAt == null ? null : event.endedAt - event.startedAt;
  const fields: [string, ReactNode][] = [
    ['Started', stamp(event.startedAt)],
    ['Finished', event.endedAt ? stamp(event.endedAt) : isRunning(event) ? 'In progress' : 'Not recorded'],
    ['Duration', duration(ms)],
    ['Turn', event.turn ? `${event.turn}${event.step ? ` · step ${event.step}` : ''}` : null],
  ];
  const decode = event.ttftMs != null && ms != null ? ms - event.ttftMs : null;
  if (event.kind === 'model') {
    const cached = event.cacheReadTokens;
    const cacheShare = cached != null && event.inputTokens ? Math.round(cached / (cached > event.inputTokens ? event.inputTokens + cached : event.inputTokens) * 100) : null;
    fields.push(
      ['Request', event.request ? `#${event.request}` : null], ['TTFT', duration(event.ttftMs)], ['Decoding', duration(decode)],
      ['Decode speed', decode && decode > 0 && event.outputTokens ? `${(event.outputTokens / decode * 1000).toFixed(1)} tok/s` : null],
      ['Input tokens', full(event.inputTokens)], ['Cache read', cached != null ? `${full(cached)}${cacheShare != null ? ` (${cacheShare}%)` : ''}` : null],
      ['Cache write', event.cacheWriteTokens ? full(event.cacheWriteTokens) : null], ['Output tokens', full(event.outputTokens)],
      ['Reasoning tokens', event.reasoningTokens ? full(event.reasoningTokens) : null], ['Finish reason', event.finishReason ? human(event.finishReason) : null],
      ['Tool calls', event.toolCallCount], ['Query source', event.querySource ? human(event.querySource) : null], ['Effort', event.variant],
      ['Attempt', event.attempt], ['Retries', event.retries || null],
    );
  }
  if (event.kind === 'compaction') {
    fields.push(['Reason', event.reason ? human(event.reason) : null], ['Before', full(event.preTokens)], ['After', full(event.postTokens)],
      ['Saved', event.preTokens != null && event.postTokens != null ? full(event.preTokens - event.postTokens) : null]);
  }
  if (event.kind === 'tool') fields.push(['Result', event.isError ? <span className="text-destructive">Error</span> : human(event.status)]);
  if (event.origin) fields.push(['Origin', human(event.origin)]);
  if (event.error) fields.push(['Error', <span className="text-destructive">{event.error}</span>]);
  const preview = previews?.get(event.id);

  return (
    <div>
      <Fields fields={fields} />
      {event.kind === 'model' && event.ttftMs != null && ms ? (
        <>
          <Heading aside={`${duration(event.ttftMs)} waiting · ${duration(decode)} decoding`}>Waiting vs decoding</Heading>
          <div className="flex h-2 overflow-hidden rounded-full bg-muted">
            <i className="bg-kind-model-wait" style={{ width: `${Math.min(100, event.ttftMs / ms * 100)}%` }} />
            <i className="flex-1 bg-kind-model" />
          </div>
        </>
      ) : null}
      {(preview?.text || preview?.result) && (
        <>
          <Heading>Preview</Heading>
          <div className="space-y-1.5">
            {preview.text && <pre className="rounded-lg border bg-muted/30 px-3 py-2 text-[11.5px] whitespace-pre-wrap">{preview.text}</pre>}
            {preview.result && <pre className={cn('rounded-lg border bg-muted/30 px-3 py-2 text-[11.5px] whitespace-pre-wrap', isFailed(event) && 'text-destructive')}>{preview.result}</pre>}
          </div>
        </>
      )}
      <Heading>Record</Heading>
      <Fields fields={[['Source', event.source], ['Record', event.recordId && <span className="font-mono text-[11px]">{event.recordId}</span>], ['Message', event.messageId && <span className="font-mono text-[11px]">{event.messageId}</span>]]} />
    </div>
  );
}
