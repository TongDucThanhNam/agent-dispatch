import type { RunItem, Snapshot } from './types';

interface Task { lead: RunItem; children: RunItem[]; latest: number }
export interface ProjectGroup { project: string; tasks: Task[]; latest: number; count: number }

export const finishedAt = (run: RunItem) => run.endedAt ?? run.lastActivityAt ?? run.startedAt;
export const matchesRun = (run: RunItem, q: string) => !q
  || [run.task, run.project, run.ref, run.runId, run.status, run.phase, run.workerLabel, run.stage, run.model].join(' ').toLowerCase().includes(q);

/** Recent task families include their running executions; filtering keeps the chain intact. */
export function groupRecent(snapshot: Snapshot | null, q = ''): ProjectGroup[] {
  if (!snapshot) return [];
  const lineage = snapshot.selected?.lineage;
  const context = [...(lineage?.discovery ? [lineage.discovery] : []), ...(lineage?.executions ?? [])];
  const byKey = new Map([...snapshot.recent, ...context].filter(run => !run.active).map(run => [run.key, run]));
  for (const run of [...snapshot.runs, ...context]) {
    if (run.active && run.discoveryKey && byKey.has(run.discoveryKey)) byKey.set(run.key, run);
  }
  const tasks = new Map<string, Task>();
  for (const run of byKey.values()) if (!(run.discoveryKey && byKey.has(run.discoveryKey))) tasks.set(run.key, { lead: run, children: [], latest: finishedAt(run) });
  for (const run of byKey.values()) {
    const task = run.discoveryKey ? tasks.get(run.discoveryKey) : undefined;
    if (!task) continue;
    task.children.push(run);
    task.latest = Math.max(task.latest, finishedAt(run));
  }
  const projects = new Map<string, ProjectGroup>();
  for (const task of tasks.values()) {
    if (!matchesRun(task.lead, q) && !task.children.some(run => matchesRun(run, q))) continue;
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
