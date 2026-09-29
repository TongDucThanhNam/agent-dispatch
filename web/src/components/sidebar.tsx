import { useMemo, useState } from 'react';
import { ChevronRight, FolderClosed, Moon, Search, Sun, TriangleAlert, Workflow } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { Input } from '@/components/ui/input';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { LiveDot, StatusIcon } from '@/components/status-badge';
import { ago, duration, projectName } from '@/lib/format';
import { kindMeta, runState, stageLabel, stateLabel, tone, toneText, workerTitle } from '@/lib/status';
import { useTheme } from '@/lib/theme';
import type { RunItem, Snapshot } from '@/lib/types';
import type { Connection } from '@/lib/use-snapshot';
import { useNow } from '@/lib/use-snapshot';
import { cn } from '@/lib/utils';

interface Task { lead: RunItem; children: RunItem[]; latest: number }
interface Project { project: string; tasks: Task[]; latest: number; count: number }

const finishedAt = (run: RunItem) => run.endedAt ?? run.lastActivityAt ?? run.startedAt;

/** Recent runs by project; executions sit under the discovery run they came from. */
function groupRecent(recent: RunItem[]): Project[] {
  const byKey = new Map(recent.map(run => [run.key, run]));
  const tasks = new Map<string, Task>();
  for (const run of recent) if (!(run.discoveryKey && byKey.has(run.discoveryKey))) tasks.set(run.key, { lead: run, children: [], latest: finishedAt(run) });
  for (const run of recent) {
    const task = run.discoveryKey ? tasks.get(run.discoveryKey) : undefined;
    if (!task) continue;
    task.children.push(run);
    task.latest = Math.max(task.latest, finishedAt(run));
  }
  const projects = new Map<string, Project>();
  for (const task of tasks.values()) {
    task.children.sort((a, b) => a.startedAt - b.startedAt);
    const group = projects.get(task.lead.project) ?? { project: task.lead.project, tasks: [], latest: 0, count: 0 };
    group.tasks.push(task);
    group.latest = Math.max(group.latest, task.latest);
    group.count += 1 + task.children.length;
    projects.set(task.lead.project, group);
  }
  for (const group of projects.values()) group.tasks.sort((a, b) => b.latest - a.latest);
  return [...projects.values()].sort((a, b) => b.latest - a.latest);
}

const CONNECTION: Record<Connection, { label: string; className: string; hint: string }> = {
  live: { label: 'Live', className: 'text-success', hint: 'Receiving updates every 2 seconds.' },
  connecting: { label: 'Connecting', className: 'text-warning', hint: 'Reconnecting to the local dashboard hub…' },
  stale: { label: 'Stale', className: 'text-warning', hint: 'No update for over 10 seconds. Showing the last snapshot.' },
  offline: { label: 'Offline', className: 'text-destructive', hint: 'The dashboard hub is not reachable. Showing the last snapshot.' },
};

export function ConnectionBadge({ connection }: { connection: Connection }) {
  const meta = CONNECTION[connection];
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span role="status" className="inline-flex h-5 items-center gap-1.5 rounded-full bg-muted px-2 text-[11px] font-medium text-muted-foreground">
          <span className={cn('relative flex size-1.5', meta.className)}>
            {connection !== 'live' && <span className="absolute inline-flex size-full animate-ping rounded-full bg-current opacity-60" />}
            <span className="relative inline-flex size-1.5 rounded-full bg-current" />
          </span>
          {meta.label}
        </span>
      </TooltipTrigger>
      <TooltipContent side="bottom">{meta.hint}</TooltipContent>
    </Tooltip>
  );
}

function RunningCard({ run, active, onSelect, now }: { run: RunItem; active: boolean; onSelect: () => void; now: number }) {
  const state = runState(run), t = tone(state), activity = run.activity, Kind = activity ? kindMeta(activity.kind).icon : null;
  return (
    <button type="button" onClick={onSelect} data-active={active}
      className="group w-full rounded-lg border bg-card/50 p-2.5 text-left transition-colors hover:bg-accent/60 data-[active=true]:border-brand/40 data-[active=true]:bg-accent/80 data-[active=true]:shadow-sm">
      <div className="flex items-start gap-2.5">
        <LiveDot tone={t === 'running' ? 'running' : t} className="mt-[5px]" />
        <div className="min-w-0 flex-1">
          <div className="line-clamp-2 text-[13px] leading-snug font-medium">{run.task ?? run.title}</div>
          <div className="mt-1 flex items-center gap-1.5 text-[11px] text-muted-foreground">
            <span className="truncate">{workerTitle(run)}</span>
            <span className="shrink-0 font-mono text-[10.5px] opacity-80">{run.ref}</span>
            <span className="ml-auto shrink-0 whitespace-nowrap tabular">{duration(now - run.startedAt)}</span>
          </div>
          {activity && Kind && (
            <div className="mt-1.5 flex items-center gap-1.5 rounded-md bg-muted/60 px-1.5 py-1 text-[11px] text-muted-foreground">
              <Kind className={cn('size-3 shrink-0', activity.endedAt ? '' : 'text-running')} aria-hidden />
              <span className="truncate text-foreground/80">{activity.label}</span>
              <span className="ml-auto shrink-0 tabular">{activity.endedAt ? ago(activity.endedAt, now) : 'now'}</span>
            </div>
          )}
          {(run.alert || t !== 'running') && (
            <div className={cn('mt-1.5 flex items-center gap-1 text-[11px] font-medium', toneText[t])}>
              {run.alert && <TriangleAlert className="size-3" aria-hidden />}
              {stateLabel(state)}
            </div>
          )}
        </div>
      </div>
    </button>
  );
}

function RecentRow({ run, active, onSelect, now, nested, label }: { run: RunItem; active: boolean; onSelect: () => void; now: number; nested?: boolean; label?: string }) {
  const ms = run.endedAt ? run.endedAt - run.startedAt : null;
  return (
    <button type="button" onClick={onSelect} data-active={active} title={`${run.task ?? run.title}\n${workerTitle(run)} · ${stateLabel(run.status)} · ${run.runId}`}
      className={cn('group flex w-full items-start gap-2 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-accent/60 data-[active=true]:bg-accent',
        nested && 'py-1')}>
      <StatusIcon state={run.status} className="mt-0.5" />
      <div className="min-w-0 flex-1">
        <div className={cn('truncate text-[12.5px] leading-snug', active ? 'font-medium text-foreground' : 'text-foreground/85')}>{label ?? run.task ?? run.title}</div>
        <div className="mt-0.5 flex items-center gap-1.5 text-[11px] text-muted-foreground">
          <span className="truncate">{nested ? run.workerLabel : workerTitle(run)}</span>
          <span className="shrink-0 font-mono text-[10.5px] opacity-75">{run.ref}</span>
          {ms != null && <span className="shrink-0 whitespace-nowrap tabular opacity-75">· {duration(ms)}</span>}
          <span className="ml-auto shrink-0 tabular">{ago(finishedAt(run), now)}</span>
        </div>
      </div>
    </button>
  );
}

function ProjectGroup({ group, selected, onSelect, now }: { group: Project; selected: string | null; onSelect: (key: string) => void; now: number }) {
  const [open, setOpen] = useState(true);
  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger className="group flex w-full items-center gap-1.5 rounded-md px-2 py-1 text-[11px] font-medium text-muted-foreground hover:text-foreground" title={group.project}>
        <ChevronRight className="size-3 transition-transform group-data-[state=open]:rotate-90" aria-hidden />
        <FolderClosed className="size-3" aria-hidden />
        <span className="truncate">{projectName(group.project)}</span>
        <span className="ml-auto tabular opacity-70">{group.count}</span>
      </CollapsibleTrigger>
      <CollapsibleContent className="mt-0.5 space-y-0.5">
        {group.tasks.map(task => (
          <div key={task.lead.key}>
            <RecentRow run={task.lead} active={task.lead.key === selected} onSelect={() => onSelect(task.lead.key)} now={now} />
            {task.children.length > 0 && (
              <div className="ml-[15px] space-y-0.5 border-l pl-1.5">
                {task.children.map(child => (
                  <RecentRow key={child.key} run={child} nested label={stageLabel(child.stage) ?? child.task ?? child.title}
                    active={child.key === selected} onSelect={() => onSelect(child.key)} now={now} />
                ))}
              </div>
            )}
          </div>
        ))}
      </CollapsibleContent>
    </Collapsible>
  );
}

export function Sidebar({ snapshot, selected, onSelect, connection }: {
  snapshot: Snapshot | null; selected: string | null; onSelect: (key: string) => void; connection: Connection;
}) {
  const [filter, setFilter] = useState('');
  const now = useNow(1000);
  const { theme, toggle } = useTheme();
  const q = filter.trim().toLowerCase();
  const running = useMemo(() => (snapshot?.runs ?? []).filter(run => matches(run, q)), [snapshot?.runs, q]);
  const groups = useMemo(() => groupRecent((snapshot?.recent ?? []).filter(run => matches(run, q))), [snapshot?.recent, q]);

  return (
    <div className="flex h-full min-h-0 flex-col bg-sidebar text-sidebar-foreground">
      <div className="flex h-12 shrink-0 items-center gap-2 px-3">
        <span className="grid size-6 place-items-center rounded-md bg-gradient-to-br from-brand to-kind-model text-white shadow-sm">
          <Workflow className="size-3.5" aria-hidden />
        </span>
        <span className="text-[13px] font-semibold tracking-tight">Agent Dispatch</span>
        <span className="ml-auto"><ConnectionBadge connection={connection} /></span>
      </div>
      <div className="px-3 pb-2">
        <div className="relative">
          <Search className="pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-muted-foreground" aria-hidden />
          <Input value={filter} onChange={event => setFilter(event.target.value)} placeholder="Filter runs" aria-label="Filter runs by task, project, ref or status"
            className="h-7 bg-background/60 pl-7 text-xs" type="search" autoComplete="off" />
        </div>
      </div>
      <nav className="min-h-0 flex-1 overflow-y-auto px-2 pb-3" aria-label="Runs">
        <SectionLabel label="Running" count={running.length} />
        <div className="space-y-1.5 px-1">
          {running.map(run => <RunningCard key={run.key} run={run} active={run.key === selected} onSelect={() => onSelect(run.key)} now={now} />)}
          {!running.length && <p className="px-1 py-1.5 text-[11.5px] text-muted-foreground">{q ? 'No running runs match.' : 'Nothing running right now.'}</p>}
        </div>
        <SectionLabel label="Recent" count={groups.reduce((sum, group) => sum + group.count, 0)} className="mt-4" />
        <div className="space-y-2">
          {groups.map(group => <ProjectGroup key={group.project} group={group} selected={selected} onSelect={onSelect} now={now} />)}
          {!groups.length && <p className="px-3 py-1.5 text-[11.5px] text-muted-foreground">{q ? 'No finished runs match.' : 'Finished runs appear here.'}</p>}
        </div>
      </nav>
      <div className="flex h-10 shrink-0 items-center gap-2 border-t px-3 text-[11px] text-muted-foreground">
        <span className="truncate">Local records · no model calls</span>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button variant="ghost" size="icon-sm" className="ml-auto" onClick={toggle} aria-label="Switch colour theme">
              {theme === 'dark' ? <Sun /> : <Moon />}
            </Button>
          </TooltipTrigger>
          <TooltipContent side="top">{theme === 'dark' ? 'Light theme' : 'Dark theme'}</TooltipContent>
        </Tooltip>
      </div>
    </div>
  );
}

function SectionLabel({ label, count, className }: { label: string; count: number; className?: string }) {
  return (
    <div className={cn('flex items-center gap-2 px-2 pt-1 pb-1.5 text-[10.5px] font-semibold tracking-wider text-muted-foreground uppercase', className)}>
      {label}
      <span className="rounded-full bg-muted px-1.5 text-[10px] tabular normal-case">{count}</span>
    </div>
  );
}

const matches = (run: RunItem, q: string) => !q
  || [run.task, run.project, run.ref, run.runId, run.status, run.phase, run.workerLabel, run.stage, run.model].join(' ').toLowerCase().includes(q);
