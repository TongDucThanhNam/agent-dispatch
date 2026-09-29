import { test, expect } from 'bun:test';
import { applySnapshotPatch, share, snapshotUpdate } from '../shared/dashboard-protocol.ts';
import { PreviewStore } from '../web/src/lib/preview-store.ts';
import { serveDashboard } from '../src/monitor/hub.ts';
import type { Snapshot, TrajectoryEvent } from '../web/src/lib/types.ts';

const event = (id: string, status = 'completed'): TrajectoryEvent => ({ id, kind: 'tool', label: 'Read', status, startedAt: 10 });
const snapshot = (events = [event('a'), event('b')]): Snapshot => ({ at: 1, runs: [], recent: [], selected: {
  key: 'a'.repeat(24), runId: 'fixture', ref: 'fixture', title: 'Fixture', project: '.', status: 'running', active: true,
  startedAt: 1, workerKind: 'codex', workerLabel: 'Codex', canStop: false, canRetryNotification: false,
  todos: [], notifications: [], trajectory: { events, stats: { toolErrors: 0 } },
} });
const wire = <T>(value: T): T => JSON.parse(JSON.stringify(value));

test('unchanged snapshots produce no patch and preserve all data identities', () => {
  const previous = snapshot(), next = { ...wire(previous), at: 2 };
  const update = snapshotUpdate(previous, next);
  expect(update.patch).toBeNull();
  expect(update.snapshot.selected).toBe(previous.selected);
  expect(update.snapshot.runs).toBe(previous.runs);
  expect(share([1, { a: 2 }], [1, { a: 3 }])).toEqual([1, { a: 3 }]);
  const rows = [{ id: 'a' }, { id: 'b' }];
  expect(share(rows, [{ id: 'a' }, { id: 'changed' }])[0]).toBe(rows[0]);
});

test('one changed event sends only that event and preserves unchanged client rows', () => {
  const previous = snapshot(Array.from({ length: 2000 }, (_, i) => event(String(i))));
  const next = wire(previous); next.at++;
  next.selected!.trajectory.events[1999].status = 'error';
  const { patch } = snapshotUpdate(previous, next);
  expect(patch!.run!.events!.upsert).toHaveLength(1);
  expect(patch!.run!.events!.order).toBeUndefined();
  expect(JSON.stringify(patch).length).toBeLessThan(500);
  const applied = applySnapshotPatch(previous, wire(patch!));
  expect(applied).toEqual(next);
  expect(applied.selected!.trajectory.events[0]).toBe(previous.selected!.trajectory.events[0]);
  expect(applied.selected!.trajectory.stats).toBe(previous.selected!.trajectory.stats);
});

test('patches round-trip additions, removals, reordering, cleared fields, run switches and null selection', () => {
  let previous = snapshot();
  const changes: Snapshot[] = [];
  const next = wire(previous); next.selected!.alert = 'warning'; next.selected!.trajectory.events = [event('b'), event('c')]; changes.push(next);
  const cleared = wire(next); delete cleared.selected!.alert; cleared.selected!.trajectory.events.reverse(); changes.push(cleared);
  const switched = wire(cleared); switched.selected!.key = 'b'.repeat(24); changes.push(switched);
  changes.push({ ...switched, selected: null }); changes.push(snapshot());
  for (const current of changes) {
    const { patch } = snapshotUpdate(previous, current);
    expect(patch).not.toBeNull();
    previous = applySnapshotPatch(previous, wire(patch!));
    expect(wire(previous)).toEqual(wire(current));
  }
  expect(() => applySnapshotPatch({ ...previous, selected: null }, { at: 2, run: { key: previous.selected!.key, fields: { set: {}, unset: [] } } })).toThrow();
});

test('sliding the 2000-event window sends only new events, not every shifted row', () => {
  const previous = snapshot(Array.from({ length: 2000 }, (_, i) => event(String(i))));
  const next = wire(previous);
  next.selected!.trajectory.events.shift(); next.selected!.trajectory.events.push(event('2000'));
  const update = snapshotUpdate(previous, next);
  expect(update.patch!.run!.events!.upsert.map(event => event.id)).toEqual(['2000']);
  expect(update.patch!.run!.events!.remove).toEqual(['0']);
  expect(update.snapshot.selected!.trajectory.events[0]).toBe(previous.selected!.trajectory.events[1]);
  const applied = applySnapshotPatch(previous, wire(update.patch!));
  expect(applied).toEqual(next);
  expect(applied.selected!.trajectory.events[0]).toBe(previous.selected!.trajectory.events[1]);
});

test('preview batches prioritize visible rows, deduplicate requests and abort on close', async () => {
  const calls: string[][] = [];
  let signal: AbortSignal | undefined;
  const store = new PreviewStore('run', async (_run, ids, abort) => {
    calls.push(ids); signal = abort;
    return { previews: Object.fromEntries(ids.map(id => [id, { text: id }])) };
  }, 1);
  try {
    store.request(Array.from({ length: 120 }, (_, i) => event(`background:${i}`)), false);
    store.request([event('visible')]); store.request([event('visible')]);
    await Bun.sleep(30);
    expect(calls[0][0]).toBe('visible');
    expect(calls.flat().filter(id => id === 'visible')).toHaveLength(1);
    expect(store.get('visible')?.text).toBe('visible');
    store.request([event('visible')]); await Bun.sleep(10);
    expect(calls).toHaveLength(2);
    expect(signal).toBeDefined();
  } finally { store.close(); }
  let aborted = false;
  const pending = new PreviewStore('run', async (_run, _ids, abort) => {
    await new Promise<void>((_resolve, reject) => abort.addEventListener('abort', () => { aborted = true; reject(new Error('aborted')); }));
    return { previews: {} };
  }, 1);
  pending.request([event('pending')]); await Bun.sleep(10); pending.close(); await Bun.sleep(1);
  expect(aborted).toBe(true);
});

test('preview completion refetches immediately, unchanged text keeps identity, and hidden pages defer work', async () => {
  let calls = 0;
  const store = new PreviewStore('run', async () => { calls++; return { previews: { a: { text: 'same' } } }; }, 1);
  try {
    store.setVisible(false); store.request([event('a', 'running')]); await Bun.sleep(10); expect(calls).toBe(0);
    store.setVisible(true); await Bun.sleep(10);
    const old = store.get('a'), version = store.version;
    store.request([event('a')]); await Bun.sleep(10);
    expect(calls).toBe(2); expect(store.get('a')).toBe(old); expect(store.version).toBe(version);
    expect(store.get('a')?.final).toBe(true);
  } finally { store.close(); }
});

test('v2 SSE shares snapshots, sends heartbeats/deltas, resumes fresh and does no idle polling', async () => {
  let value = snapshot(), refreshes = 0, snapshots = 0;
  const catalog = { refresh() { refreshes++; }, snapshot() { snapshots++; return { ...value, at: Date.now() }; }, get() {}, hydrate() {}, idle() {}, close() {} };
  const panel = await serveDashboard({ catalog: catalog as any, pollMs: 20 });
  const abort = new AbortController();
  const open = async () => {
    const response = await fetch(panel.url + 'events?v=2', { signal: abort.signal });
    const reader = response.body!.getReader(); let buffer = '';
    return { reader, async next() {
      while (!buffer.includes('\n\n')) { const chunk = await reader.read(); if (chunk.done) throw new Error('Stream closed'); buffer += new TextDecoder().decode(chunk.value); }
      const end = buffer.indexOf('\n\n'), text = buffer.slice(0, end); buffer = buffer.slice(end + 2);
      return { event: text.match(/^event: (.+)/)?.[1] ?? 'message', data: JSON.parse(text.split('\n').find(line => line.startsWith('data: '))!.slice(6)) };
    } };
  };
  try {
    await Bun.sleep(60); expect(refreshes).toBe(1);
    const a = await open(), initial = await a.next(), b = await open(); await b.next();
    expect((await a.next()).event).toBe('heartbeat');
    expect(snapshots).toBeLessThanOrEqual(refreshes);
    value = wire(value); value.selected!.trajectory.events[1].label = 'Write';
    let update;
    for (let i = 0; i < 10; i++) { const next = await a.next(); if (next.event === 'patch') { update = next; break; } }
    expect(update).toBeDefined();
    const applied = applySnapshotPatch(initial.data, update!.data);
    expect(applied.selected).toEqual(value.selected);
    await a.reader.cancel(); await b.reader.cancel(); await Bun.sleep(40);
    const idle = refreshes; await Bun.sleep(60); expect(refreshes).toBe(idle);
    value = wire(value); value.selected!.status = 'complete';
    const resumed = await open(); expect((await resumed.next()).data.selected.status).toBe('complete'); await resumed.reader.cancel();
  } finally { abort.abort(); await panel.close(); }
});
