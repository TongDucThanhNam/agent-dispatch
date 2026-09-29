import type { Run, RunItem, Snapshot } from '../web/src/lib/types';

/** Every member of a discovery family sees the same chronological execution chain. */
export function resolveRunLineage(selected: Pick<Run, 'key' | 'stage' | 'discoveryKey'>, items: RunItem[]): NonNullable<Run['lineage']> {
  const byKey = new Map(items.map(run => [run.key, run]));
  const discoveryKey = selected.discoveryKey ?? selected.key;
  const executions = [...byKey.values()].filter(run => run.discoveryKey === discoveryKey).sort((a, b) => a.startedAt - b.startedAt);
  const self = byKey.get(selected.key);
  if (selected.stage === 'execution' && self && !executions.some(run => run.key === self.key)) executions.push(self);
  return { discovery: selected.discoveryKey || selected.stage === 'discovery' ? byKey.get(discoveryKey) ?? null : null, executions };
}

/** Also works with an already-running hub that only supplies lineage from the discovery view. */
export function selectedSnapshotRun(snapshot: Snapshot | null): Run | null {
  if (!snapshot?.selected) return null;
  const run = snapshot.selected;
  const items = [...snapshot.recent, ...snapshot.runs, ...(run.lineage?.discovery ? [run.lineage.discovery] : []), ...(run.lineage?.executions ?? [])];
  if (!items.some(item => item.key === run.key)) items.push({ ...run, alert: Boolean(run.alert) });
  const lineage = resolveRunLineage(run, items);
  if (run.lineage?.discovery === lineage.discovery && run.lineage.executions.length === lineage.executions.length
    && run.lineage.executions.every((item, index) => item === lineage.executions[index])) return run;
  return { ...run, lineage };
}
