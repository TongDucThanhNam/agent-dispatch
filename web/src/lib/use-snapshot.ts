import { startTransition, useEffect, useRef, useState } from 'react';
import { applySnapshotPatch, share, type SnapshotPatch } from '../../../shared/dashboard-protocol';
import { eventsUrl } from './api';
import type { Snapshot } from './types';

export type Connection = 'connecting' | 'live' | 'stale' | 'offline';

/** Full state on connect, patches thereafter; heartbeats never rerender the data view. */
export function useSnapshot(run: string | null) {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [connection, setConnection] = useState<Connection>('connecting');
  const receivedAt = useRef(0);
  const [pending, setPending] = useState(true);

  useEffect(() => {
    let source: EventSource | null = null, current: Snapshot | null = null;
    let retry: ReturnType<typeof setTimeout> | undefined, disposed = false;
    setPending(true); setConnection('connecting'); receivedAt.current = 0;
    const alive = () => { receivedAt.current = Date.now(); setConnection('live'); };
    const publish = (next: Snapshot) => {
      current = next; alive();
      startTransition(() => { setSnapshot(next); setPending(false); });
    };
    const recover = () => {
      source?.close(); source = null; setConnection('offline');
      clearTimeout(retry); retry = setTimeout(connect, 1000);
    };
    const connect = () => {
      if (disposed || document.hidden || source) return;
      setConnection('connecting');
      source = new EventSource(eventsUrl(run));
      source.onmessage = message => {
        try { publish(share(current, JSON.parse(message.data) as Snapshot)!); } catch { recover(); }
      };
      source.addEventListener('patch', message => {
        try {
          if (!current) throw new Error('Missing initial snapshot.');
          publish(applySnapshotPatch(current, JSON.parse((message as MessageEvent).data) as SnapshotPatch));
        } catch { recover(); }
      });
      source.addEventListener('heartbeat', alive);
      source.onerror = () => setConnection(source?.readyState === EventSource.CLOSED ? 'offline' : 'connecting');
    };
    const visibility = () => {
      if (document.hidden) { source?.close(); source = null; clearTimeout(retry); }
      else connect(); // A reconnect always gets a fresh full snapshot.
    };
    const timer = setInterval(() => {
      if (!document.hidden && Date.now() - receivedAt.current > 10_000) setConnection(state => state === 'live' ? 'stale' : state);
    }, 2000);
    document.addEventListener('visibilitychange', visibility); connect();
    return () => { disposed = true; clearTimeout(retry); clearInterval(timer); source?.close(); document.removeEventListener('visibilitychange', visibility); };
  }, [run]);

  return { snapshot, connection, receivedAt: receivedAt.current, pending };
}

/** Clocks sleep in background tabs and catch up as soon as the page is visible. */
export function useNow(ms = 1000, enabled = true) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (!enabled) return;
    let timer: ReturnType<typeof setInterval> | undefined;
    const update = () => {
      clearInterval(timer);
      if (!document.hidden) { setNow(Date.now()); timer = setInterval(() => setNow(Date.now()), ms); }
    };
    document.addEventListener('visibilitychange', update); update();
    return () => { clearInterval(timer); document.removeEventListener('visibilitychange', update); };
  }, [ms, enabled]);
  return now;
}
