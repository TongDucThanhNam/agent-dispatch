import { Fragment } from 'react';
import { CircleDashed, Compass, Hammer, NotebookPen } from 'lucide-react';
import { StatusIcon } from '@/components/status-badge';
import { duration, stamp } from '@/lib/format';
import { runState, stateLabel } from '@/lib/status';
import type { Run, RunItem } from '@/lib/types';
import { cn } from '@/lib/utils';

type Step = { key: string; stage: 'discovery' | 'execution'; run: RunItem | null; index?: number };

/**
 * The two-stage flow: a discovery run reports, the orchestrator plans, execution runs implement.
 * Only runs launched with a stage show it.
 */
export function Pipeline({ run, now, onSelect }: { run: Run; now: number; onSelect: (key: string) => void }) {
  if (!run.stage) return null;
  const self: RunItem = { ...run, alert: Boolean(run.alert), activity: null };
  const discovery = run.stage === 'discovery' ? self : run.lineage?.discovery ?? null;
  const executions = run.lineage?.executions?.length ? run.lineage.executions : run.stage === 'execution' ? [self] : [];
  const steps: Step[] = [
    { key: 'discovery', stage: 'discovery', run: discovery },
    ...(executions.length ? executions.map((item, index) => ({ key: item.key, stage: 'execution' as const, run: item, index: executions.length > 1 ? index + 1 : undefined }))
      : [{ key: 'execution', stage: 'execution' as const, run: null }]),
  ];

  return (
    <nav aria-label="Delegation flow" className="flex min-w-0 items-center gap-0 overflow-x-auto">
      {steps.map((step, index) => (
        <Fragment key={step.key}>
          {index === 1 && <PlanConnector done={Boolean(step.run)} />}
          {index > 1 && <span className="mx-1.5 h-px w-4 shrink-0 bg-border" aria-hidden />}
          <StepCard step={step} current={step.run?.key === run.key} now={now} onSelect={onSelect} />
        </Fragment>
      ))}
    </nav>
  );
}

function StepCard({ step, current, now, onSelect }: { step: Step; current: boolean; now: number; onSelect: (key: string) => void }) {
  const Icon = step.stage === 'discovery' ? Compass : Hammer;
  const label = step.stage === 'discovery' ? 'Discovery' : `Execution${step.index ? ` ${step.index}` : ''}`;
  const run = step.run;
  if (!run) {
    return (
      <div className="flex h-9 shrink-0 items-center gap-2 rounded-lg border border-dashed px-2.5 text-[12px] text-muted-foreground">
        <CircleDashed className="size-3.5" aria-hidden />
        <span className="font-medium">{label}</span>
        <span className="text-[11px]">{step.stage === 'discovery' ? 'not linked' : 'not started'}</span>
      </div>
    );
  }
  const state = runState(run), end = run.endedAt ?? (run.active ? now : run.lastActivityAt ?? run.startedAt);
  return (
    <button type="button" disabled={current} onClick={() => onSelect(run.key)} aria-current={current ? 'step' : undefined}
      title={`${label} · ${run.workerLabel} · ${stateLabel(state)}\nStarted ${stamp(run.startedAt)}`}
      className={cn('flex h-9 shrink-0 items-center gap-2 rounded-lg border px-2.5 text-left text-[12px] transition-colors',
        current ? 'border-brand/45 bg-brand/8 ring-1 ring-brand/20' : 'bg-card/60 hover:bg-accent/70')}>
      <Icon className={cn('size-3.5', current ? 'text-brand' : 'text-muted-foreground')} aria-hidden />
      <span className="font-medium">{label}</span>
      <StatusIcon state={state} />
      <span className="text-[11px] whitespace-nowrap text-muted-foreground">
        <span className="hidden sm:inline">{run.workerLabel} · <span className="font-mono">{run.ref}</span> · </span><span className="tabular">{duration(end - run.startedAt)}</span>
      </span>
    </button>
  );
}

function PlanConnector({ done }: { done: boolean }) {
  return (
    <div className="flex shrink-0 items-center" title="The orchestrator reviews the discovery report and writes the execution brief.">
      <span className={cn('h-px w-4', done ? 'bg-border' : 'border-t border-dashed')} aria-hidden />
      <span className="flex items-center gap-1 rounded-full border border-dashed px-2 py-0.5 text-[10.5px] text-muted-foreground">
        <NotebookPen className="size-3" aria-hidden />Plan
      </span>
      <span className={cn('h-px w-4', done ? 'bg-border' : 'border-t border-dashed')} aria-hidden />
    </div>
  );
}
