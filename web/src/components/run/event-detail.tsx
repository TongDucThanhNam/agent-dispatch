import { useMemo, useState, type ReactNode } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { AlertCircle, ArrowLeft, ArrowUpLeft, Check, ChevronRight, Copy, Loader2, RefreshCw } from 'lucide-react';
import { KindChip } from '@/components/kind-chip';
import { Button } from '@/components/ui/button';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { fetchContent } from '@/lib/api';
import { duration, full, human, num, stamp } from '@/lib/format';
import { copyText } from '@/lib/hooks';
import { eventName, isFailed, isRunning, kindMeta } from '@/lib/status';
import type { ContentSection, Run, TrajectoryEvent } from '@/lib/types';
import type { PreviewStore } from '@/lib/use-previews';
import { cn } from '@/lib/utils';

type Pages = Record<string, { text: string; nextOffset: number | null }>;

/** Tools inherit the turn and step of the request that called them, which links the two both ways. */
function linkedEvents(events: TrajectoryEvent[], event: TrajectoryEvent) {
  if (event.step == null || (event.kind !== 'model' && event.kind !== 'tool')) return [];
  const same = (e: TrajectoryEvent) => e.step === event.step && e.turn === event.turn;
  return event.kind === 'model'
    ? events.filter(e => e.kind === 'tool' && same(e))
    : events.filter(e => e.kind === 'model' && same(e)).slice(-1);
}

/** One trajectory event: its recorded content, a field summary and the raw record. Remount per event. */
export function EventDetail({ run, event, previews, onBack, onSelect }: {
  run: Run; event: TrajectoryEvent; previews: PreviewStore | null; onBack: () => void; onSelect: (id: string) => void;
}) {
  const linked = useMemo(() => linkedEvents(run.trajectory.events, event), [run.trajectory.events, event]);
  const sub = [event.turn ? `Turn ${event.turn}` : null, event.step ? `step ${event.step}` : null, human(event.status)].filter(Boolean).join(' · ');
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="border-b px-4 pt-2.5 pb-3">
        <Button variant="ghost" size="xs" className="-ml-2 text-muted-foreground" onClick={onBack}><ArrowLeft />Run summary</Button>
        <div className="mt-1.5 flex min-w-0 items-center gap-2">
          <KindChip kind={event.kind} error={isFailed(event)} />
          <h2 className="min-w-0 truncate text-[14px] font-semibold" title={event.label}>{eventName(event)}</h2>
        </div>
        <div className="mt-1 truncate text-[11.5px] text-muted-foreground">
          {event.kind === 'model' && event.label !== eventName(event) ? `${event.label} · ` : ''}{sub}
          {isRunning(event) ? ' · running' : event.endedAt ? ` · ${duration(event.endedAt - event.startedAt)}` : ''}
        </div>
        {linked.length > 0 && <Linked event={event} linked={linked} onSelect={onSelect} />}
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
          <CodeBlock text={JSON.stringify(event, null, 2)} label="event record" />
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

function Content({ run, event }: { run: Run; event: TrajectoryEvent }) {
  const client = useQueryClient();
  const [pages, setPages] = useState<Pages>({});
  const [loadingMore, setLoadingMore] = useState<string | null>(null);
  const [moreError, setMoreError] = useState<string | null>(null);
  // Expanded sections stay stable until the user refreshes them.
  const frozen = Object.keys(pages).length > 0;
  const live = run.active && (isRunning(event) || !event.endedAt);
  const query = useQuery({
    queryKey: ['content', run.key, event.id],
    queryFn: ({ signal }) => fetchContent(run.key, event.id, undefined, signal),
    refetchInterval: live && !frozen ? 3000 : false,
    staleTime: live ? 0 : Infinity,
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
    <div className="space-y-4">
      {content.note && <p className="rounded-md bg-muted/60 px-2.5 py-2 text-[11.5px] text-muted-foreground">{content.note}</p>}
      {!content.sections.length && !content.note && <p className="text-xs text-muted-foreground">No content was recorded for this event.</p>}
      {content.sections.map(section => {
        const extra = pages[section.field];
        const text = section.text + (extra?.text ?? ''), nextOffset = extra ? extra.nextOffset : section.nextOffset ?? null;
        return (
          <Section key={section.field} section={section} text={text} markdown={section.field === 'text' || event.kind === 'input'}
            footer={nextOffset != null && (
              <div className="mt-2 flex items-center gap-2 text-[11px] text-muted-foreground">
                <span className="tabular">{full(nextOffset)} of {full(section.totalChars)} characters</span>
                <Button variant="outline" size="xs" disabled={loadingMore !== null} onClick={() => void loadMore(section, nextOffset)}>
                  {loadingMore === section.field && <Loader2 className="animate-spin" />}Load more
                </Button>
              </div>
            )} />
        );
      })}
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

/** A complete JSON object (tool arguments, mostly), or null for anything else, including a partly loaded one. */
function jsonObject(text: string): Record<string, unknown> | null {
  if (!/^\s*\{/.test(text)) return null;
  try {
    const value = JSON.parse(text);
    return value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length ? value : null;
  } catch { return null; }
}

function Section({ section, text, markdown, footer }: { section: ContentSection; text: string; markdown: boolean; footer?: ReactNode }) {
  const [rendered, setRendered] = useState(markdown);
  const [open, setOpen] = useState(false);
  const object = useMemo(() => (markdown ? null : jsonObject(text)), [markdown, text]);
  const [asFields, setAsFields] = useState(true);
  const heading = (
    <div className="mb-1.5 flex items-center gap-2">
      <h3 className="text-[10.5px] font-semibold tracking-wider text-muted-foreground uppercase">{section.title}</h3>
      {section.totalChars > 2000 && <span className="text-[10.5px] text-muted-foreground/70 tabular">{num(section.totalChars)} chars</span>}
      <span className="ml-auto flex items-center gap-0.5">
        {markdown && (
          <Button variant="ghost" size="xs" className="h-5 px-1.5 text-[10.5px] text-muted-foreground" onClick={() => setRendered(!rendered)}>
            {rendered ? 'Plain' : 'Rendered'}
          </Button>
        )}
        {object && (
          <Button variant="ghost" size="xs" className="h-5 px-1.5 text-[10.5px] text-muted-foreground" onClick={() => setAsFields(!asFields)}>
            {asFields ? 'JSON' : 'Fields'}
          </Button>
        )}
        <CopyButton text={text} label={section.title.toLowerCase()} />
      </span>
    </div>
  );
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
        <CollapsibleContent className="px-2.5 pb-2.5">
          <pre className="max-h-[50vh] overflow-auto text-[11.5px] leading-relaxed whitespace-pre-wrap text-muted-foreground">{text}</pre>
          {footer}
        </CollapsibleContent>
      </Collapsible>
    );
  }
  return (
    <section>
      {heading}
      {object && asFields ? <JsonFields value={object} />
        : rendered
        ? <div className={cn('markdown rounded-lg border bg-muted/20 px-3 py-2', section.field === 'error' && 'border-destructive/30')}><ReactMarkdown remarkPlugins={[remarkGfm]}>{text}</ReactMarkdown></div>
        : <pre className={cn('max-h-[60vh] overflow-auto rounded-lg border bg-muted/30 px-3 py-2 font-mono text-[11.5px] leading-relaxed whitespace-pre-wrap break-words',
            section.field === 'error' && 'border-destructive/30 text-destructive')}>{text || ' '}</pre>}
      {footer}
    </section>
  );
}

/** Top-level arguments one by one, with string values shown as the text they hold rather than escaped. */
function JsonFields({ value }: { value: Record<string, unknown> }) {
  return (
    <div className="max-h-[60vh] divide-y divide-border/60 overflow-auto rounded-lg border bg-muted/30">
      {Object.entries(value).map(([key, item]) => (
        <div key={key} className="px-3 py-2">
          <div className="mb-0.5 font-mono text-[10.5px] text-muted-foreground">{key}</div>
          <pre className="font-mono text-[11.5px] leading-relaxed whitespace-pre-wrap break-words">
            {typeof item === 'string' ? item || ' ' : JSON.stringify(item, null, 2)}
          </pre>
        </div>
      ))}
    </div>
  );
}

function CopyButton({ text, label }: { text: string; label: string }) {
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle');
  const copy = async () => {
    setState(await copyText(text) ? 'copied' : 'failed');
    setTimeout(() => setState('idle'), 1400);
  };
  return (
    <Button variant="ghost" size="icon-xs" className="size-5 text-muted-foreground" onClick={() => void copy()} aria-label={`Copy ${label}`}
      title={state === 'failed' ? 'Clipboard unavailable — select the text to copy' : `Copy ${label}`}>
      {state === 'copied' ? <Check className="text-success" /> : state === 'failed' ? <AlertCircle className="text-destructive" /> : <Copy />}
    </Button>
  );
}

export function CodeBlock({ text, label }: { text: string; label: string }) {
  return (
    <div className="relative">
      <div className="absolute top-1.5 right-1.5"><CopyButton text={text} label={label} /></div>
      <pre className="overflow-auto rounded-lg border bg-muted/30 px-3 py-2 font-mono text-[11px] leading-relaxed">{text}</pre>
    </div>
  );
}

export function Fields({ fields }: { fields: [string, ReactNode][] }) {
  const shown = fields.filter(([, value]) => value !== undefined && value !== null && value !== '' && value !== '—');
  if (!shown.length) return null;
  return (
    <dl className="grid grid-cols-[minmax(96px,auto)_1fr] gap-x-4 gap-y-1.5 text-[12px]">
      {shown.map(([key, value]) => (
        <div key={key} className="contents">
          <dt className="text-muted-foreground">{key}</dt>
          <dd className="min-w-0 break-words tabular">{value}</dd>
        </div>
      ))}
    </dl>
  );
}

export function Heading({ children, aside }: { children: ReactNode; aside?: ReactNode }) {
  return (
    <div className="mt-5 mb-2 flex items-baseline gap-2 first:mt-0">
      <h3 className="text-[10.5px] font-semibold tracking-wider text-muted-foreground uppercase">{children}</h3>
      {aside && <span className="text-[11px] text-muted-foreground/80">{aside}</span>}
    </div>
  );
}

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
