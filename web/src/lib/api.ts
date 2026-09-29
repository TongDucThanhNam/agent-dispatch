import type { EventContent, Preview } from './types';

// The hub serves the page at /<token>/; the Vite dev server proxies /api/ to the dev hub.
const here = location.pathname.endsWith('/') ? location.pathname : location.pathname.replace(/[^/]*$/, '');
export const BASE = import.meta.env.DEV ? '/api/' : here;

async function json<T>(response: Response): Promise<T> {
  let body: any = null;
  try { body = await response.json(); } catch { /* empty body */ }
  if (!response.ok) throw new Error(body?.error ?? `Request failed (${response.status}).`);
  return body as T;
}

export const eventsUrl = (run?: string | null) => `${BASE}events${run ? `?run=${encodeURIComponent(run)}` : ''}`;

export const fetchPreviews = (run: string, ids: string[], signal?: AbortSignal) =>
  fetch(`${BASE}runs/${run}/previews?ids=${encodeURIComponent(ids.join(','))}`, { signal })
    .then(r => json<{ previews: Record<string, Preview> }>(r));

export function fetchContent(run: string, event: string, page?: { field: string; offset: number }, signal?: AbortSignal) {
  const query = new URLSearchParams({ event });
  if (page) { query.set('field', page.field); query.set('offset', String(page.offset)); }
  return fetch(`${BASE}runs/${run}/content?${query}`, { signal }).then(r => json<EventContent>(r));
}

export const runAction = (run: string, name: 'stop' | 'retry-notification') =>
  fetch(`${BASE}runs/${run}/${name}`, { method: 'POST' }).then(r => json<{ message: string }>(r));

/** HEAD reports preparation errors; the browser download manager then takes the stream. */
export async function downloadSessionLog(run: string) {
  const url = `${BASE}runs/${run}/export`;
  const head = await fetch(url, { method: 'HEAD' });
  if (!head.ok) {
    let message = `Session log could not be prepared (${head.status}).`;
    try { message = (await (await fetch(url)).json()).error ?? message; } catch { /* keep the status message */ }
    throw new Error(message);
  }
  const link = document.createElement('a');
  link.href = url;
  link.download = '';
  document.body.append(link);
  link.click();
  link.remove();
}

/** An image a tool returned to the model; 404 when the worker's session log did not keep it. */
export const imageUrl = (run: string, event: string, index: number) =>
  `${BASE}runs/${run}/image?event=${encodeURIComponent(event)}&index=${index}`;
