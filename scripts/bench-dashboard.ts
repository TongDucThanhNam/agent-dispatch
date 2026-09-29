// Repeatable local transport benchmark; synthetic records, no workers or model requests.
import { serveDashboard } from '../src/monitor/hub.ts';

const count = 2000, clients = 4, pollMs = 50, durationMs = 1000;
const key = 'a'.repeat(24);
const events = Array.from({ length: count }, (_, i) => ({ id: `part:${i}`, kind: 'tool', label: 'Read', status: 'completed',
  startedAt: i * 1000, endedAt: i * 1000 + 100, source: 'part', recordId: String(i) }));

async function measure(changing: boolean) {
  let refreshes = 0, snapshots = 0;
  const catalog = {
    refresh() { refreshes++; },
    get() { return null; }, hydrate() { return null; },
    snapshot() {
      snapshots++;
      return { at: Date.now(), runs: [], recent: [], selected: { key, active: true, trajectory: {
        events: changing ? [...events.slice(0, -1), { ...events.at(-1), label: `Read ${refreshes}` }] : events,
      } } };
    },
  };
  const panel = await serveDashboard({ catalog: catalog as any, pollMs });
  const abort = new AbortController();
  const meters = Array.from({ length: clients }, () => ({ bytes: 0, frames: 0, initialBytes: 0 }));
  const pumps: Promise<void>[] = [];
  try {
    await Promise.all(meters.map(async meter => {
      const response = await fetch(panel.url + `events?v=2&run=${key}`, { signal: abort.signal });
      const reader = response.body!.getReader();
      let buffer = '';
      let ready!: () => void;
      const initial = new Promise<void>(resolve => { ready = resolve; });
      pumps.push((async () => {
        try {
          const decoder = new TextDecoder();
          while (true) {
            const chunk = await reader.read();
            if (chunk.done) break;
            meter.bytes += chunk.value.length;
            buffer += decoder.decode(chunk.value, { stream: true });
            let end;
            while ((end = buffer.indexOf('\n\n')) >= 0) {
              const frame = buffer.slice(0, end + 2); buffer = buffer.slice(end + 2);
              meter.frames++;
              if (meter.frames === 1) { meter.initialBytes = Buffer.byteLength(frame); ready(); }
            }
          }
        } catch (error) { if (!abort.signal.aborted) throw error; }
        finally { ready(); reader.releaseLock(); }
      })());
      await initial;
    }));
    const start = performance.now(), cpu = process.cpuUsage();
    await Bun.sleep(durationMs);
    const elapsedMs = performance.now() - start, used = process.cpuUsage(cpu);
    abort.abort(); await Promise.all(pumps);
    return { scenario: changing ? 'one event changes per tick' : 'unchanged', clients, events: count, pollMs,
      elapsedMs: Math.round(elapsedMs), refreshes, snapshots,
      initialBytes: meters.reduce((n, m) => n + m.initialBytes, 0),
      updateBytes: meters.reduce((n, m) => n + m.bytes - m.initialBytes, 0),
      frames: meters.reduce((n, m) => n + m.frames, 0), cpuMs: (used.user + used.system) / 1000 };
  } finally { abort.abort(); await panel.close(); }
}

const result = { bun: Bun.version, results: [await measure(false), await measure(true)] };
console.log(JSON.stringify(result, null, 2));
if (process.argv[2]) await Bun.write(process.argv[2], JSON.stringify(result, null, 2) + '\n');
