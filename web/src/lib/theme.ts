import { useSyncExternalStore } from 'react';

export type Theme = 'dark' | 'light';
const KEY = 'agent-dispatch.theme';
const listeners = new Set<() => void>();

function read(): Theme {
  try { const saved = localStorage.getItem(KEY); if (saved === 'dark' || saved === 'light') return saved; } catch { /* storage blocked */ }
  return matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
}

let current: Theme = read();
const apply = () => { document.documentElement.classList.toggle('dark', current === 'dark'); document.documentElement.style.colorScheme = current; };
apply();

export function setTheme(theme: Theme) {
  current = theme;
  try { localStorage.setItem(KEY, theme); } catch { /* storage blocked */ }
  apply();
  for (const listener of listeners) listener();
}

const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };

export function useTheme() {
  const theme = useSyncExternalStore(subscribe, () => current);
  return { theme, setTheme, toggle: () => setTheme(theme === 'dark' ? 'light' : 'dark') };
}
