import { Bell, Circle, CircleCheck, CircleDot, FileText, Info, ListTodo } from 'lucide-react';
import { Markdown } from '@/components/code';
import { Progress } from '@/components/ui/progress';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { clock, duration, full, human, num, pct, stamp } from '@/lib/format';
import { runState, stateLabel, workerTitle } from '@/lib/status';
import type { EventFocus, Run } from '@/lib/types';
import type { PreviewStore } from '@/lib/use-previews';
import { cn } from '@/lib/utils';
import { InsightsPanel } from './insights';
import { Fields, Heading } from './parts';

/** The inspector when no event is selected: what went wrong and where the time went, the run at a glance, its report and its plan. */
export function RunSummary({ run, now, previews, onFocus, onSelect }: {
  run: Run; now: number; previews: PreviewStore | null; onFocus: (focus: EventFocus | null) => void; onSelect: (id: string) => void;
}) {
  const done = run.todos.filter(todo => todo.status === 'completed').length;
  return (
    <Tabs defaultValue="insights" className="flex h-full min-h-0 flex-col gap-0">
      <div className="border-b px-4 pt-3">
        <div className="text-[10.5px] font-semibold tracking-wider text-muted-foreground uppercase">Run summary</div>
        <TabsList variant="line" className="mt-1 h-9 w-full justify-start gap-3 px-0">
          <TabsTrigger value="insights" className="flex-none px-0.5">Insights</TabsTrigger>
          <TabsTrigger value="overview" className="flex-none px-0.5">Overview</TabsTrigger>
          <TabsTrigger value="report" className="flex-none gap-1.5 px-0.5">
            Report{run.report && <span className="size-1.5 rounded-full bg-success" aria-label="available" />}
          </TabsTrigger>
          <TabsTrigger value="plan" className="flex-none gap-1.5 px-0.5">
            Plan{run.todos.length > 0 && <span className="text-[10.5px] text-muted-foreground tabular">{done}/{run.todos.length}</span>}
          </TabsTrigger>
        </TabsList>
      </div>
      <TabsContent value="insights" className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
        <InsightsPanel run={run} previews={previews} now={now} onFocus={onFocus} onSelect={onSelect} />
      </TabsContent>
      <TabsContent value="overview" className="min-h-0 flex-1 overflow-y-auto px-4 py-3"><Overview run={run} now={now} /></TabsContent>
      <TabsContent value="report" className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
        {run.report
          ? <Markdown text={run.report} />
          : <Empty icon={FileText} text={run.active ? 'The worker writes its report when it finishes.' : 'This run did not leave a report.'} />}
      </TabsContent>
      <TabsContent value="plan" className="min-h-0 flex-1 overflow-y-auto px-4 py-3"><Plan run={run} /></TabsContent>
    </Tabs>
  );
}

function Empty({ icon: Icon, text }: { icon: typeof Info; text: string }) {
  return (
    <div className="flex flex-col items-center gap-2 py-10 text-center text-xs text-muted-foreground">
      <Icon className="size-5 opacity-60" aria-hidden />{text}
    </div>
  );
}

function Stat({ label, value, sub, danger }: { label: string; value: string; sub?: string; danger?: boolean }) {
  return (
    <div className="rounded-lg border bg-muted/20 px-2.5 py-2">
      <div className="text-[10px] font-medium tracking-wider text-muted-foreground uppercase">{label}</div>
      <div className="mt-0.5 text-[14px] font-semibold tabular">{value}</div>
      {sub && <div className={cn('truncate text-[11px]', danger ? 'text-destructive' : 'text-muted-foreground')}>{sub}</div>}
    </div>
  );
}

function Overview({ run, now }: { run: Run; now: number }) {
  const t = run.trajectory, s = t.stats ?? {}, usage = run.usage ?? {};
  const elapsed = (run.endedAt ?? (run.active ? now : run.lastActivityAt ?? run.startedAt)) - run.startedAt;
  const input = s.inputTokens ?? usage.inputTokens, output = s.outputTokens ?? usage.outputTokens;
  const finish = Object.entries(s.finishReasons ?? {}).sort((a, b) => b[1] - a[1]);
  return (
    <div className="@container">
      {run.telemetryAvailable === false && (
        <p className="mb-3 flex gap-2 rounded-md bg-muted/60 px-2.5 py-2 text-[11.5px] text-muted-foreground">
          <Info className="mt-px size-3.5 shrink-0" aria-hidden />{run.telemetryReason ?? 'Detailed telemetry is not available for this worker.'}
        </p>
      )}
      <Fields fields={[
        ['Worker', workerTitle(run)], ['State', stateLabel(runState(run))], ['Model', run.model && <span className="font-mono text-[11.5px]">{run.model}</span>],
        ['Run', <span className="font-mono text-[11.5px]">{run.runId}</span>], ['Session', run.sessionId && <span className="font-mono text-[11.5px] break-all">{run.sessionId}</span>],
        ['Project', <span className="break-all">{run.project}</span>], ['Started', stamp(run.startedAt)],
        ['Ended', run.endedAt ? stamp(run.endedAt) : run.active ? 'Running' : null], ['Elapsed', duration(elapsed)],
        ['Last activity', run.lastActivityAt ? stamp(run.lastActivityAt) : null],
      ]} />

      <Heading>Model</Heading>
      <div className="grid grid-cols-2 gap-2 @md:grid-cols-3">
        <Stat label="Requests" value={num(s.requests ?? usage.modelCalls)} sub={t.turns != null ? `${t.turns} turns` : undefined} />
        <Stat label="Avg TTFT" value={duration(s.avgTtftMs)} sub="time to first token" />
        <Stat label="Decode" value={s.decodeTokensPerSecond != null ? `${s.decodeTokensPerSecond}/s` : '—'} sub="output tokens per second" />
        <Stat label="Model time" value={duration(s.modelMs)} sub={elapsed > 0 && s.modelMs ? `${Math.round(s.modelMs / elapsed * 100)}% of elapsed` : undefined} />
        <Stat label="Errors" value={full(s.requestErrors ?? 0)} sub={`${s.retries ?? usage.retries ?? 0} retries`} danger={Boolean(s.requestErrors)} />
        <Stat label="Compactions" value={full(s.compactions ?? 0)} sub={s.subagents ? `${s.subagents} sub-sessions` : undefined} />
      </div>

      <Heading aside={s.cacheHitRate != null ? `${pct(s.cacheHitRate)} cache hit` : undefined}>Tokens</Heading>
      <Fields fields={[
        ['Input', full(input)], ['Cache read', full(s.cacheReadTokens ?? usage.cacheReadTokens)], ['Cache write', s.cacheWriteTokens ? full(s.cacheWriteTokens) : null],
        ['Output', full(output)], ['Reasoning', s.reasoningTokens ? full(s.reasoningTokens) : null], ['Peak context', s.peakInputTokens ? full(s.peakInputTokens) : null],
      ]} />
      {s.cacheHitRate != null && <Progress value={s.cacheHitRate} className="mt-2 h-1.5" aria-label="Cache hit rate" />}

      {finish.length > 0 && (
        <>
          <Heading>Finish reasons</Heading>
          <div className="flex flex-wrap gap-1.5">
            {finish.map(([reason, count]) => (
              <span key={reason} className="inline-flex items-center gap-1.5 rounded-md border px-2 py-0.5 text-[11px]">
                {human(reason)}<span className="text-muted-foreground tabular">{full(count)}</span>
              </span>
            ))}
          </div>
        </>
      )}

      {run.notifications.length > 0 && (
        <>
          <Heading>Notifications</Heading>
          <ul className="space-y-1">
            {run.notifications.map((n, index) => (
              <li key={index} className="flex items-center gap-2 text-[12px]">
                <Bell className="size-3.5 text-muted-foreground" aria-hidden />{human(n.kind)}
                <span className={cn('ml-auto text-[11px]', /fail|error/.test(n.state) ? 'text-destructive' : 'text-muted-foreground')}>{human(n.state)}</span>
              </li>
            ))}
          </ul>
        </>
      )}
      <p className="mt-5 text-[11px] text-muted-foreground">
        Read from local run records{run.updatedAt ? ` · updated ${clock(run.updatedAt)}` : ''}. Viewing makes no model requests.
      </p>
    </div>
  );
}

function Plan({ run }: { run: Run }) {
  if (!run.todos.length) return <Empty icon={ListTodo} text="The worker has not shared a plan." />;
  const done = run.todos.filter(todo => todo.status === 'completed').length;
  return (
    <div>
      <div className="mb-3 flex items-center gap-3">
        <Progress value={done / run.todos.length * 100} className="h-1.5 flex-1" aria-label="Plan progress" />
        <span className="text-[11px] text-muted-foreground tabular">{done} of {run.todos.length} done</span>
      </div>
      <ol className="space-y-0.5">
        {run.todos.map((todo, index) => {
          const Icon = todo.status === 'completed' ? CircleCheck : todo.status === 'in_progress' ? CircleDot : Circle;
          return (
            <li key={index} className={cn('flex gap-2 rounded-md px-1.5 py-1 text-[12.5px]', todo.status === 'in_progress' && 'bg-running/8')}>
              <Icon className={cn('mt-0.5 size-3.5 shrink-0', todo.status === 'completed' ? 'text-success' : todo.status === 'in_progress' ? 'text-running' : 'text-muted-foreground')} aria-hidden />
              <span className={cn(todo.status === 'completed' && 'text-muted-foreground line-through decoration-muted-foreground/40')}>{todo.content}</span>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
