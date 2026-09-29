import { useCallback, useEffect, useState } from 'react';

const readRun = () => new URLSearchParams(location.hash.slice(1)).get('run');

/** The selected run lives in the URL hash (`#run=<key>`), so reloads and back/forward keep it. */
export function useHashRun() {
  const [run, setRun] = useState(readRun);
  useEffect(() => {
    const sync = () => setRun(readRun());
    addEventListener('hashchange', sync);
    addEventListener('popstate', sync);
    return () => { removeEventListener('hashchange', sync); removeEventListener('popstate', sync); };
  }, []);
  const select = useCallback((key: string, { replace = false } = {}) => {
    if (key === readRun()) return;
    history[replace ? 'replaceState' : 'pushState'](null, '', `#run=${key}`);
    setRun(key);
  }, []);
  return [run, select] as const;
}

export function useMediaQuery(query: string) {
  const [matches, setMatches] = useState(() => matchMedia(query).matches);
  useEffect(() => {
    const list = matchMedia(query), update = () => setMatches(list.matches);
    update();
    list.addEventListener('change', update);
    return () => list.removeEventListener('change', update);
  }, [query]);
  return matches;
}

export async function copyText(text: string) {
  try { await navigator.clipboard.writeText(text); return true; } catch { return false; }
}
