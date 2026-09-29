import type { Preview, TrajectoryEvent } from './types';

interface Entry extends Preview { at: number; final: boolean; stamp: string }
interface Request { final: boolean; stamp: string; priority: boolean }
type ReadPreviews = (run: string, ids: string[], signal: AbortSignal) => Promise<{ previews: Record<string, Preview> }>;

/** Bounded, cancellable batching. Visible rows take precedence over background diagnostics. */
export class PreviewStore {
  private entries = new Map<string, Entry>();
  private wanted = new Map<string, Request>();
  private inflight = new Map<string, Request>();
  private listeners = new Set<() => void>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private controller: AbortController | null = null;
  private closed = false;
  private visible = true;
  private failures = 0;
  version = 0;

  constructor(readonly run: string, private read: ReadPreviews, private delay = 80) {}

  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  getVersion = () => this.version;
  get = (id: string) => this.entries.get(id);
  close() {
    this.closed = true; this.controller?.abort();
    if (this.timer) clearTimeout(this.timer);
    this.wanted.clear(); this.entries.clear(); this.listeners.clear();
  }
  setVisible(visible: boolean) {
    this.visible = visible;
    if (!visible) { if (this.timer) clearTimeout(this.timer); this.timer = null; this.controller?.abort(); }
    else this.schedule();
  }

  request(events: TrajectoryEvent[], priority = true) {
    if (this.closed) return;
    const now = Date.now();
    for (const event of events) {
      const entry = this.entries.get(event.id);
      const running = !event.endedAt && ['running', 'pending', 'in_progress', 'streaming', 'started', 'ACTIVE'].includes(event.status ?? '');
      const final = !running && (event.kind !== 'model' || Boolean(event.endedAt));
      const stamp = `${event.status ?? ''}:${event.endedAt ?? ''}`;
      if (entry?.stamp === stamp && (entry.final || now - entry.at <= 4000) || this.inflight.get(event.id)?.stamp === stamp) continue;
      this.wanted.set(event.id, { final, stamp, priority: priority || Boolean(this.wanted.get(event.id)?.priority) });
    }
    this.schedule();
  }

  private schedule() {
    if (!this.closed && this.visible && this.wanted.size && !this.timer && !this.controller)
      this.timer = setTimeout(() => void this.flush(), this.failures ? Math.min(30_000, 1000 * 2 ** (this.failures - 1)) : this.delay);
  }

  private async flush() {
    this.timer = null;
    if (this.closed || !this.visible || this.controller) return;
    const batch = [...this.wanted].sort((a, b) => Number(b[1].priority) - Number(a[1].priority)).slice(0, 100);
    if (!batch.length) return;
    for (const [id] of batch) this.wanted.delete(id);
    this.inflight = new Map(batch);
    const controller = this.controller = new AbortController();
    try {
      const { previews } = await this.read(this.run, batch.map(([id]) => id), controller.signal);
      if (this.closed) return;
      const at = Date.now(); let changed = false;
      for (const [id, { final, stamp }] of batch) {
        const preview = previews[id] ?? { text: '' }, old = this.entries.get(id);
        if (old && old.text === preview.text && old.result === preview.result) Object.assign(old, { at, final, stamp });
        else { this.entries.delete(id); this.entries.set(id, { ...preview, at, final, stamp }); changed = true; }
      }
      while (this.entries.size > 2200) this.entries.delete(this.entries.keys().next().value!);
      this.failures = 0;
      if (changed) { this.version++; for (const listener of this.listeners) listener(); }
    } catch {
      if (!this.closed) {
        if (!controller.signal.aborted) this.failures++;
        for (const [id, request] of batch) if (!this.wanted.has(id)) this.wanted.set(id, request);
      }
    } finally { this.controller = null; this.inflight.clear(); this.schedule(); }
  }
}
