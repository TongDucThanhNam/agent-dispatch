import { useEffect, useState } from "react";

export function useLiveJson(url: string | null) {
  const [value, setValue] = useState<any>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    if (!url) return;
    const controller = new AbortController();
    let etag: string | null = null,
      busy = false;
    const load = async () => {
      if (document.hidden || busy || controller.signal.aborted) return;
      busy = true;
      try {
        const response = await fetch(url, {
          signal: controller.signal,
          cache: "no-store",
          headers: etag ? { "If-None-Match": etag } : {},
        });
        if (response.status !== 304) {
          if (!response.ok) throw Error(`HTTP ${response.status}`);
          const next = await response.json();
          if (controller.signal.aborted) return;
          etag = response.headers.get("etag");
          setValue(next);
          setError(next.catalogError ?? "");
        } else setError("");
      } catch (e) {
        if (!controller.signal.aborted)
          setError(
            `Connection lost. Recover with agent-dispatch dashboard. ${e}`,
          );
      } finally {
        busy = false;
      }
    };
    void load();
    const timer = setInterval(load, 5000);
    document.addEventListener("visibilitychange", load);
    return () => {
      controller.abort();
      clearInterval(timer);
      document.removeEventListener("visibilitychange", load);
    };
  }, [url]);
  return { value, error };
}
