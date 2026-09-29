import {
  Bot, CircleCheck, CircleDot, CircleSlash, CircleX, FileStack, Loader, MessageSquare, RotateCcw, Shrink, TriangleAlert, Wrench, type LucideIcon,
} from 'lucide-react';
import type { EventKind, RunItem, TrajectoryEvent } from './types';

export type Tone = 'running' | 'success' | 'warning' | 'danger' | 'neutral' | 'info';

const RUNNING = ['running', 'starting', 'working', 'using_tool'];
const SUCCESS = ['completed', 'complete', 'ready_for_review', 'finished'];
const WARNING = ['quiet', 'waiting_retry', 'possibly_stalled', 'repeated_tool_error', 'monitor_limited', 'unconfirmed'];
const DANGER = ['blocked', 'worker_failed', 'missing_report', 'changes_required', 'monitor_offline', 'retry_exhausted'];

export function tone(state?: string | null): Tone {
  const value = state ?? '';
  if (RUNNING.includes(value)) return 'running';
  if (SUCCESS.includes(value)) return 'success';
  if (DANGER.includes(value) || /blocked|failed|exhausted/.test(value)) return 'danger';
  if (WARNING.includes(value)) return 'warning';
  if (value === 'cancelled') return 'neutral';
  return 'info';
}

const LABELS: Record<string, string> = {
  using_tool: 'Using tool', ready_for_review: 'Ready for review', changes_required: 'Changes required', worker_failed: 'Worker failed',
  missing_report: 'Missing report', monitor_offline: 'Monitor offline', monitor_limited: 'Monitor limited', repeated_tool_error: 'Repeated tool errors',
  retry_exhausted: 'Retries exhausted', waiting_retry: 'Waiting to retry', possibly_stalled: 'Possibly stalled',
};

export const stateLabel = (state?: string | null) => {
  if (!state) return 'Unknown';
  const text = LABELS[state] ?? state.replaceAll('_', ' ');
  return text.charAt(0).toUpperCase() + text.slice(1);
};

/** Active runs report their live phase; finished runs report their outcome. */
export const runState = (run: Pick<RunItem, 'active' | 'phase' | 'status'>) => run.active ? run.phase ?? run.status : run.status;

export const TONE_ICON: Record<Tone, LucideIcon> = {
  running: Loader, success: CircleCheck, warning: TriangleAlert, danger: CircleX, neutral: CircleSlash, info: CircleDot,
};

export const toneText: Record<Tone, string> = {
  running: 'text-running', success: 'text-success', warning: 'text-warning', danger: 'text-destructive', neutral: 'text-muted-foreground', info: 'text-info',
};

export const toneSoft: Record<Tone, string> = {
  running: 'bg-running/12 text-running ring-running/25',
  success: 'bg-success/12 text-success ring-success/25',
  warning: 'bg-warning/12 text-warning ring-warning/25',
  danger: 'bg-destructive/12 text-destructive ring-destructive/25',
  neutral: 'bg-muted text-muted-foreground ring-border',
  info: 'bg-info/12 text-info ring-info/25',
};

export const stageLabel = (stage?: string | null) => stage === 'discovery' ? 'Discovery' : stage === 'execution' ? 'Execution' : null;
export const workerTitle = (run: Pick<RunItem, 'workerLabel' | 'stage'>) => [run.workerLabel ?? 'ZCode', stageLabel(run.stage)].filter(Boolean).join(' ');

export interface KindMeta { label: string; role: string; icon: LucideIcon; color: string; soft: string }

export const KIND: Record<EventKind, KindMeta> = {
  input: { label: 'User', role: 'User', icon: MessageSquare, color: 'bg-kind-input', soft: 'bg-kind-input/14 text-kind-input' },
  context: { label: 'Context', role: 'Context', icon: FileStack, color: 'bg-kind-context', soft: 'bg-kind-context/14 text-kind-context' },
  model: { label: 'Assistant', role: 'Assistant', icon: Bot, color: 'bg-kind-model', soft: 'bg-kind-model/14 text-kind-model' },
  tool: { label: 'Tool', role: 'Tool', icon: Wrench, color: 'bg-kind-tool', soft: 'bg-kind-tool/14 text-kind-tool' },
  compaction: { label: 'Compaction', role: 'Compacted', icon: Shrink, color: 'bg-kind-compaction', soft: 'bg-kind-compaction/14 text-kind-compaction' },
  retry: { label: 'Retry', role: 'Retry', icon: RotateCcw, color: 'bg-kind-retry', soft: 'bg-kind-retry/14 text-kind-retry' },
};

export const kindMeta = (kind: string): KindMeta => KIND[kind as EventKind] ?? { ...KIND.context, label: kind, role: kind };

const RUNNING_EVENT = ['running', 'pending', 'streaming', 'in_progress', 'started', 'ACTIVE'];
export const isRunning = (event: TrajectoryEvent) => !event.endedAt && RUNNING_EVENT.includes(event.status ?? '');
export const isFailed = (event: TrajectoryEvent) => Boolean(event.isError || event.error || ['error', 'failed'].includes(event.status ?? ''));
export const eventName = (event: TrajectoryEvent) =>
  event.kind === 'model' && event.request ? `Request #${event.request}${event.step ? ` · step ${event.step}` : ''}` : event.label;

export type KindFilter = 'all' | 'conversation' | 'model' | 'tool' | 'context' | 'errors';
export const KIND_FILTERS: { value: KindFilter; label: string; test: (event: TrajectoryEvent) => boolean }[] = [
  { value: 'all', label: 'All', test: () => true },
  { value: 'conversation', label: 'Conversation', test: e => ['input', 'context', 'model'].includes(e.kind) },
  { value: 'model', label: 'Assistant', test: e => e.kind === 'model' },
  { value: 'tool', label: 'Tools', test: e => e.kind === 'tool' },
  { value: 'context', label: 'Context', test: e => ['context', 'compaction', 'retry'].includes(e.kind) },
  { value: 'errors', label: 'Errors', test: isFailed },
];
