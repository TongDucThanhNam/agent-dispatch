import { useEffect, useState, useSyncExternalStore } from 'react';
import { fetchPreviews } from './api';
import { PreviewStore } from './preview-store';
export { PreviewStore } from './preview-store';

export function usePreviewStore(run: string | null) {
  const [store, setStore] = useState<PreviewStore | null>(null);
  useEffect(() => {
    if (!run) { setStore(null); return; }
    const next = new PreviewStore(run, fetchPreviews);
    const visibility = () => next.setVisible(!document.hidden);
    document.addEventListener('visibilitychange', visibility); visibility();
    setStore(next);
    return () => { document.removeEventListener('visibilitychange', visibility); next.close(); };
  }, [run]);
  return store;
}

/** Subscribe only the components displaying previews, not the entire run view. */
export function usePreviewVersion(store: PreviewStore | null) {
  return useSyncExternalStore(store?.subscribe ?? noopSubscribe, store?.getVersion ?? zero);
}

const noopSubscribe = () => () => {};
const zero = () => 0;
