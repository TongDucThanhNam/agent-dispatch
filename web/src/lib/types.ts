// Shapes served by the dashboard hub (src/monitor/hub.ts). Absent fields mean "not recorded".

export type EventKind = 'input' | 'context' | 'model' | 'tool' | 'compaction' | 'retry';

export interface TrajectoryEvent {
  id: string;
  kind: EventKind;
  label: string;
  status?: string;
  startedAt: number;
  endedAt?: number | null;
  source?: string;
  recordId?: string;
  messageId?: string;
  turn?: number;
  step?: number;
  opensTurn?: boolean;
  origin?: string;
  isError?: boolean;
  error?: string | null;
  // Model requests
  request?: number;
  inputTokens?: number | null;
  outputTokens?: number | null;
  cacheReadTokens?: number | null;
  cacheWriteTokens?: number | null;
  reasoningTokens?: number | null;
  ttftMs?: number | null;
  durationMs?: number | null;
  finishReason?: string | null;
  toolCallCount?: number | null;
  querySource?: string | null;
  variant?: string | null;
  retries?: number | null;
  attempt?: number | null;
  // Compaction
  reason?: string | null;
  preTokens?: number | null;
  postTokens?: number | null;
}

export interface ToolStat { name: string; calls: number; errors: number; ms: number }

export interface TrajectoryStats {
  requests?: number;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  reasoningTokens?: number;
  avgTtftMs?: number | null;
  modelMs?: number;
  peakInputTokens?: number;
  decodeTokensPerSecond?: number | null;
  requestErrors?: number;
  retries?: number;
  cacheHitRate?: number | null;
  finishReasons?: Record<string, number>;
  tools?: ToolStat[];
  compactions?: number;
  toolErrors?: number;
  subagents?: number;
}

export interface Trajectory {
  events: TrajectoryEvent[];
  truncated?: boolean;
  turns?: number | null;
  requests?: number | null;
  toolCalls?: number | null;
  stats?: TrajectoryStats;
}

export interface Activity { kind: EventKind; label: string; status?: string; startedAt: number; endedAt?: number | null }

/** A sidebar entry. */
export interface RunItem {
  key: string;
  ref: string;
  /** Last two project path segments, e.g. "D: / emc". */
  title: string;
  /** First heading of the saved brief, e.g. "Run 4: Simple mode …". */
  task?: string | null;
  project: string;
  runId: string;
  model?: string;
  status: string;
  phase?: string;
  active: boolean;
  startedAt: number;
  endedAt?: number | null;
  lastActivityAt?: number | null;
  workerLabel: string;
  stage?: 'discovery' | 'execution' | null;
  discoveryKey?: string | null;
  alert: boolean;
  activity?: Activity | null;
}

export interface Todo { content: string; status: string }

/** The selected run in full. */
export interface Run extends Omit<RunItem, 'alert' | 'activity'> {
  workerKind: string;
  updatedAt?: number;
  usage?: { modelCalls?: number; inputTokens?: number; outputTokens?: number; cacheReadTokens?: number; retries?: number };
  todos: Todo[];
  trajectory: Trajectory;
  telemetryAvailable?: boolean;
  telemetryReason?: string | null;
  report?: string | null;
  alert?: string | null;
  notifications: { kind: string; state: string }[];
  canStop: boolean;
  canRetryNotification: boolean;
  sessionId?: string | null;
  lineage?: { discovery: RunItem | null; executions: RunItem[] };
}

export interface Snapshot {
  at: number;
  runs: RunItem[];
  recent: RunItem[];
  selected: Run | null;
}

export interface ContentSection {
  field: string;
  title: string;
  text: string;
  totalChars: number;
  offset?: number;
  nextOffset?: number | null;
  expanded?: boolean;
}

export interface EventContent { note?: string; sections: ContentSection[] }

export interface Preview { text?: string; result?: string }

/** A set of events to show on their own in the trajectory, with what they have in common. */
export interface EventFocus { label: string; ids: ReadonlySet<string> }
