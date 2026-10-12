import type { TrajectoryEvent } from '../../web/src/lib/types';

const RUNNING_EVENT = ['running', 'pending', 'streaming', 'in_progress', 'started', 'ACTIVE'];
export const isRunning = (event: TrajectoryEvent) => !event.endedAt && RUNNING_EVENT.includes(event.status ?? '');
export const isFailed = (event: TrajectoryEvent) => Boolean(event.isError || event.error || ['error', 'failed'].includes(event.status ?? ''));
