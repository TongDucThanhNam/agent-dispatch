import { useEffect, useState, useSyncExternalStore } from 'react';
import { fetchPreviews } from './api';
import { isRunning } from './status';
import type { Preview, TrajectoryEvent } from './types';

interface Entry extends Preview { at: number; final: boolean }

const BATCH = 120;

/**
 * Row previews are read lazily for rows on screen, in batches.
 * Finished events are read once; running ones refresh every 4 s while visible.
 */
export class PreviewStore {
  private entries = new Map<string, Entry>();
  private wanted = new Map<string, boolean>();
  private listeners = new Set<() => void>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private busy = false;
  private closed = false;
  version = 0;

  constructor(readonly run: string) {}

  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  getVersion = () => this.version;
  get = (id: string) => this.entries.get(id);
  close() { this.closed = true; if (this.timer) clearTimeout(this.timer); }

  request(events: TrajectoryEvent[]) {
    const now = Date.now();
    for (const event of events) {
      const entry = this.entries.get(event.id);
      if (!entry || (!entry.final && now - entry.at > 4000)) {
        this.wanted.set(event.id, !isRunning(event) && (event.kind !== 'model' || Boolean(event.endedAt)));
      }
    }
    this.schedule();
  }

  private schedule() {
    if (!this.closed && this.wanted.size && !this.timer) this.timer = setTimeout(() => void this.flush(), BATCH);
  }

  private async flush() {
    this.timer = null;
    if (this.busy) return this.schedule();
    const batch = [...this.wanted].slice(0, 100);
    for (const [id] of batch) this.wanted.delete(id);
    if (!batch.length) return;
    this.busy = true;
    try {
      const { previews } = await fetchPreviews(this.run, batch.map(([id]) => id));
      if (this.closed) return;
      const at = Date.now();
      for (const [id, final] of batch) this.entries.set(id, { ...(previews[id] ?? { text: '' }), at, final });
      this.version++;
      for (const listener of this.listeners) listener();
    } catch { /* previews are optional; the next request retries */ }
    finally { this.busy = false; this.schedule(); }
  }
}

export function usePreviewStore(run: string | null) {
  const [store, setStore] = useState<PreviewStore | null>(null);
  useEffect(() => {
    if (!run) { setStore(null); return; }
    const next = new PreviewStore(run);
    setStore(next);
    return () => next.close();
  }, [run]);
  useSyncExternalStore(store?.subscribe ?? noopSubscribe, store?.getVersion ?? zero);
  return store;
}

const noopSubscribe = () => () => {};
const zero = () => 0;
