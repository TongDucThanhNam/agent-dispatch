const compact = new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 });

export const num = (value?: number | null) => value == null ? '—' : compact.format(value);
export const full = (value?: number | null) => value == null ? '—' : Number(value).toLocaleString('en');
export const pct = (value?: number | null) => value == null ? '—' : `${Math.round(value)}%`;
export const human = (value?: string | null) => String(value ?? '').replaceAll('_', ' ');

export function duration(ms?: number | null) {
  if (ms == null || !Number.isFinite(ms)) return '—';
  if (ms < 1000) return `${Math.max(0, Math.round(ms))}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m ${Math.floor(ms % 60_000 / 1000)}s`;
  return `${Math.floor(ms / 3_600_000)}h ${Math.floor(ms % 3_600_000 / 60_000)}m`;
}

export const clock = (at?: number | null) => at ? new Date(at).toLocaleTimeString([], { hour12: false }) : '—';
export const stamp = (at?: number | null) => at ? new Date(at).toLocaleString([], { hour12: false }) : '—';

/** "just now", "4m ago", "yesterday 14:02", "Sep 21". */
export function ago(at?: number | null, now = Date.now()) {
  if (!at) return '—';
  const diff = now - at;
  if (diff < 45_000) return 'just now';
  if (diff < 3_600_000) return `${Math.round(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.round(diff / 3_600_000)}h ago`;
  const date = new Date(at), today = new Date(now);
  const yesterday = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1);
  if (date >= yesterday) return `yesterday ${date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false })}`;
  return date.toLocaleDateString([], { month: 'short', day: 'numeric' });
}

/** Last path segment of a project directory: "D:\\work\\emc" → "emc". */
export const projectName = (project?: string | null) => String(project ?? '').split(/[\\/]+/).filter(Boolean).at(-1) ?? '—';
