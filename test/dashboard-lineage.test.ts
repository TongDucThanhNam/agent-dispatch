import { expect, test } from 'bun:test';
import { resolveRunLineage, selectedSnapshotRun } from '../shared/run-lineage.ts';
import { groupRecent } from '../web/src/lib/run-groups.ts';
import type { Run, RunItem, Snapshot } from '../web/src/lib/types.ts';

const item = (key: string, extra: Partial<RunItem> = {}): RunItem => ({
  key, runId: key, ref: key, title: key, task: key, project: 'project', workerLabel: 'Codex',
  stage: 'execution', active: false, status: 'complete', startedAt: 10, endedAt: 20, alert: false, ...extra,
});
const discovery = item('discovery', { stage: 'discovery', startedAt: 1, endedAt: 5 });
const first = item('first', { discoveryKey: discovery.key });
const second = item('second', { discoveryKey: discovery.key, startedAt: 30, endedAt: null, active: true, status: 'running' });
const unrelated = item('unrelated', { active: true, endedAt: null, status: 'running' });
const run = (item: RunItem, lineage?: Run['lineage']): Run => ({
  ...item, alert: null, workerKind: 'codex', todos: [], notifications: [], trajectory: { events: [] },
  canStop: false, canRetryNotification: false, lineage,
});
const snapshot = (selected: Run | null = run(first, { discovery, executions: [] })): Snapshot => ({
  at: 40, runs: [unrelated, second], recent: [first, discovery], selected,
});

test('discovery and either execution resolve the same ordered, deduplicated family', () => {
  const items = [second, unrelated, discovery, first, second];
  for (const selected of [discovery, first, second]) {
    const lineage = resolveRunLineage(selected, items);
    expect(lineage.discovery).toBe(discovery);
    expect(lineage.executions).toEqual([first, second]);
  }
});

test('execution selection recovers siblings from an already-running older hub without mutating its snapshot', () => {
  const original = snapshot();
  const selected = selectedSnapshotRun(original)!;
  expect(selected.key).toBe(first.key);
  expect(selected.lineage).toEqual({ discovery, executions: [first, second] });
  expect(original.selected!.lineage!.executions).toEqual([]);
  const fromSecond = selectedSnapshotRun(snapshot(run(second, { discovery, executions: [] })))!;
  expect(fromSecond.lineage).toEqual(selected.lineage);
});

test('complete lineage keeps the selected run identity when only an unrelated run changes', () => {
  const selected = run(first, { discovery, executions: [first, second] });
  expect(selectedSnapshotRun(snapshot(selected))).toBe(selected);
  expect(selectedSnapshotRun({ ...snapshot(selected), runs: [{ ...unrelated, phase: 'using_tool' }, second] })).toBe(selected);
});

test('unlinked execution stays standalone and missing discovery does not discard siblings', () => {
  expect(resolveRunLineage(unrelated, [discovery, first, second, unrelated])).toEqual({ discovery: null, executions: [unrelated] });
  expect(resolveRunLineage(first, [first, second])).toEqual({ discovery: null, executions: [first, second] });
  expect(selectedSnapshotRun(null)).toBeNull();
  expect(selectedSnapshotRun(snapshot(null))).toBeNull();
});

test('the recent project tree includes a running sibling but not unrelated running work', () => {
  const groups = groupRecent(snapshot());
  expect(groups).toHaveLength(1);
  expect(groups[0].count).toBe(3);
  expect(groups[0].tasks).toHaveLength(1);
  expect(groups[0].tasks[0].lead).toBe(discovery);
  expect(groups[0].tasks[0].children).toEqual([first, second]);
  expect(groupRecent({ ...snapshot(null), recent: [] })).toEqual([]);
});

test('filtering an execution preserves its discovery and siblings so numbering remains stable', () => {
  for (const query of ['second', 'running', 'discovery']) {
    const group = groupRecent(snapshot(), query)[0];
    expect(group.count).toBe(3);
    expect(group.tasks[0].lead).toBe(discovery);
    expect(group.tasks[0].children).toEqual([first, second]);
  }
  expect(groupRecent(snapshot(), 'no-match')).toEqual([]);
});

test('selected lineage restores family context outside the recent limit without duplicate rows', () => {
  const selected = run(first, { discovery, executions: [first, second] });
  for (const recent of [[], [discovery, first]]) {
    const groups = groupRecent({ ...snapshot(selected), recent });
    expect(groups[0].count).toBe(3);
    expect(groups[0].tasks[0].children).toEqual([first, second]);
  }
});
