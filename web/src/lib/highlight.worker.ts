import { tokenizeLocal, type Lang } from './highlight-core';

// Only token data crosses the boundary. No HTML, eval or WASM is required by the worker.
self.addEventListener('message', async (event: MessageEvent<{ id: number; text: string; lang: Lang }>) => {
  const { id, text, lang } = event.data;
  try { self.postMessage({ id, tokens: await tokenizeLocal(text, lang) }); }
  catch (error) { self.postMessage({ id, error: error instanceof Error ? error.message : 'Highlighting failed.' }); }
});
