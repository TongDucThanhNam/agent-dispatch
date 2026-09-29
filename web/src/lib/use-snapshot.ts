import { useEffect, useRef, useState } from 'react';
import { eventsUrl } from './api';
import type { Snapshot } from './types';

export type Connection = 'connecting' | 'live' | 'stale' | 'offline';

/** Follows the hub's SSE stream for the selected run; identical payloads keep the previous object. */
export function useSnapshot(run: string | null) {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [connection, setConnection] = useState<Connection>('connecting');
  const [receivedAt, setReceivedAt] = useState(0);
  // True from a run switch until the new stream delivers its first snapshot.
  const [pending, setPending] = useState(true);
  const signature = useRef('');

  useEffect(() => {
    signature.current = '';
    setConnection('connecting');
    setPending(true);
    const source = new EventSource(eventsUrl(run));
    source.onmessage = message => {
      setReceivedAt(Date.now());
      setConnection('live');
      try {
        const next: Snapshot = JSON.parse(message.data);
        const key = JSON.stringify([next.runs, next.recent, next.selected]);
        if (key !== signature.current) { signature.current = key; setSnapshot(next); }
        setPending(false);
      } catch { setConnection('offline'); }
    };
    source.onerror = () => setConnection(source.readyState === EventSource.CLOSED ? 'offline' : 'connecting');
    return () => source.close();
  }, [run]);

  // The hub pushes every 2 s; a stream silent for 10 s is shown as stale.
  useEffect(() => {
    const timer = setInterval(() => setConnection(state => state === 'live' && Date.now() - receivedAt > 10_000 ? 'stale' : state), 2000);
    return () => clearInterval(timer);
  }, [receivedAt]);

  return { snapshot, connection, receivedAt, pending };
}

/** Re-renders every `ms` so elapsed times keep moving between snapshots. */
export function useNow(ms = 1000, enabled = true) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (!enabled) return;
    const timer = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(timer);
  }, [ms, enabled]);
  return now;
}
