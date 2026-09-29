import type { Run, Snapshot, Trajectory, TrajectoryEvent } from '../web/src/lib/types.ts';

type Fields<T> = { set: Partial<T>; unset: (keyof T)[] };
export interface SnapshotPatch {
  at: number;
  runs?: Snapshot['runs'];
  recent?: Snapshot['recent'];
  selected?: Run | null;
  run?: {
    key: string;
    fields: Fields<Run>;
    trajectory?: Fields<Trajectory>;
    events?: { upsert: TrajectoryEvent[]; remove: string[]; order?: string[] };
  };
}

/** JSON-only structural sharing: unchanged subtrees retain their identity in React. */
export function share<T>(previous: T, next: T): T {
  if (previous === next) return previous;
  if (!previous || !next || typeof previous !== 'object' || typeof next !== 'object' || Array.isArray(previous) !== Array.isArray(next)) return next;
  if (Array.isArray(previous) && Array.isArray(next)) {
    let result: unknown[] | null = previous.length === next.length ? null : next.slice();
    for (let i = 0; i < next.length; i++) {
      const value = share(previous[i], next[i]);
      if (value !== previous[i] && !result) result = previous.slice();
      if (result) result[i] = value;
    }
    return (result ?? previous) as T;
  }
  const a = previous as Record<string, unknown>, b = next as Record<string, unknown>;
  const keys = Object.keys(b);
  let equal = Object.keys(a).length === keys.length;
  const result: Record<string, unknown> = {};
  for (const key of keys) {
    result[key] = share(a[key], b[key]);
    if (!Object.hasOwn(a, key) || result[key] !== a[key]) equal = false;
  }
  return equal ? previous : result as T;
}

function fields<T extends object>(previous: T, next: T, omit: keyof T): Fields<T> {
  const set: Partial<T> = {}, unset: (keyof T)[] = [];
  for (const key of new Set([...Object.keys(previous), ...Object.keys(next)]) as Set<keyof T>) {
    if (key === omit || previous[key] === next[key]) continue;
    if (next[key] === undefined) unset.push(key); else set[key] = next[key];
  }
  return { set, unset };
}
const changed = (value: { unset: readonly PropertyKey[]; set: object }) => value.unset.length > 0 || Object.keys(value.set).length > 0;
function applyFields<T>(value: T, patch: Fields<T>): T {
  if (!changed(patch)) return value;
  const next = { ...value, ...patch.set };
  for (const key of patch.unset) delete next[key];
  return next;
}

/** One update per selected run, shared by all its clients. Only changed events cross the wire. */
export function snapshotUpdate(previous: Snapshot, input: Snapshot): { snapshot: Snapshot; patch: SnapshotPatch | null } {
  let selected = input.selected;
  if (previous.selected && selected?.key === previous.selected.key) {
    const before = previous.selected.trajectory.events;
    let events = selected.trajectory.events;
    if (events !== before) {
      let old: Map<string, TrajectoryEvent> | undefined;
      events = events.map((event, index) => {
        if (before[index]?.id === event.id) return share(before[index], event);
        old ??= new Map(before.map(item => [item.id, item]));
        return share(old.get(event.id), event)!;
      });
      if (events.length === before.length && events.every((event, index) => event === before[index])) events = before;
    }
    // Reconcile metadata separately: index-based sharing would copy every event when the 2000-row window slides.
    let trajectory = share(previous.selected.trajectory, { ...selected.trajectory, events: before });
    if (events !== before) trajectory = { ...trajectory, events };
    selected = share(previous.selected, { ...selected, trajectory: previous.selected.trajectory });
    if (trajectory !== previous.selected.trajectory) selected = { ...selected, trajectory };
  } else {
    selected = share(previous.selected, selected);
  }
  const snapshot: Snapshot = { at: input.at, runs: share(previous.runs, input.runs), recent: share(previous.recent, input.recent),
    selected };
  const patch: SnapshotPatch = { at: snapshot.at };
  if (snapshot.runs !== previous.runs) patch.runs = snapshot.runs;
  if (snapshot.recent !== previous.recent) patch.recent = snapshot.recent;
  if (snapshot.selected !== previous.selected) {
    const before = previous.selected, after = snapshot.selected;
    if (!before || !after || before.key !== after.key) patch.selected = after;
    else {
      const run: NonNullable<SnapshotPatch['run']> = { key: after.key, fields: fields(before, after, 'trajectory') };
      const trajectory = fields(before.trajectory, after.trajectory, 'events');
      if (changed(trajectory)) run.trajectory = trajectory;
      if (before.trajectory.events !== after.trajectory.events) {
        const old = new Map(before.trajectory.events.map(event => [event.id, event]));
        const ids = new Set(after.trajectory.events.map(event => event.id));
        const upsert = after.trajectory.events.filter(event => event !== old.get(event.id));
        const remove = before.trajectory.events.filter(event => !ids.has(event.id)).map(event => event.id);
        const reordered = before.trajectory.events.length !== after.trajectory.events.length || after.trajectory.events.some((event, i) => event.id !== before.trajectory.events[i]?.id);
        run.events = { upsert, remove, ...(reordered ? { order: after.trajectory.events.map(event => event.id) } : {}) };
      }
      patch.run = run;
    }
  }
  return { snapshot, patch: Object.keys(patch).length > 1 ? patch : null };
}

export function applySnapshotPatch(previous: Snapshot, patch: SnapshotPatch): Snapshot {
  let selected = patch.selected === undefined ? previous.selected : patch.selected;
  if (patch.run) {
    if (!selected || selected.key !== patch.run.key) throw new Error('Snapshot patch belongs to another run.');
    selected = applyFields(selected, patch.run.fields);
    let trajectory = patch.run.trajectory ? applyFields(selected.trajectory, patch.run.trajectory) : selected.trajectory;
    if (patch.run.events) {
      const delta = patch.run.events, events = new Map(trajectory.events.map(event => [event.id, event]));
      for (const id of delta.remove) events.delete(id);
      for (const event of delta.upsert) events.set(event.id, event);
      const ordered = delta.order ? delta.order.map(id => {
        const event = events.get(id);
        if (!event) throw new Error('Snapshot patch is incomplete.');
        return event;
      }) : [...events.values()];
      trajectory = { ...trajectory, events: ordered };
    }
    selected = { ...selected, trajectory };
  }
  return { at: patch.at, runs: patch.runs ?? previous.runs, recent: patch.recent ?? previous.recent, selected };
}
