import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { Store } from "./store";
import { read } from "./paths";
import { bridge } from "./workflow";
import { compactDecisions } from "./decisions";
import {
  readSavedRun,
  runState,
} from "../engine/delegate-to-zcode/scripts/run-summary.mjs";
export function importLegacy(store: Store) {
  const root = path.join(os.homedir(), ".zcode/monitor/runs");
  let count = 0;
  for (const file of fs.existsSync(root) ? fs.readdirSync(root) : []) {
    try {
      const e = read(path.join(root, file));
      if (typeof e.runDir === "string") {
        store.register(e.runDir);
        count++;
      }
    } catch {}
  }
  return count;
}
type Saved = { stamp: string; value: any };
const caches = new WeakMap<Store, Map<string, Saved>>();
function cacheFor(store: Store) {
  let cache = caches.get(store);
  if (!cache) caches.set(store, (cache = new Map()));
  return cache;
}
function stamp(directory: string) {
  return ["config.json", "status.json", "review.json"]
    .map((name) => {
      try {
        const s = fs.statSync(path.join(directory, name));
        return `${s.mtimeMs}:${s.ctimeMs}:${s.size}`;
      } catch {
        return "missing";
      }
    })
    .join("|");
}
function unavailable(entry: any) {
  return {
    id: entry.id,
    runId: path.basename(entry.directory),
    project: entry.directory.split(/[\\/]\.zcode-dispatch[\\/]/)[0],
    status: "unavailable",
    active: false,
    tasks: [],
  };
}
export async function snapshot(store: Store) {
  const entries = store.runs(),
    cache = cacheFor(store),
    runs: any[] = [];
  for (const entry of entries) {
    const version = stamp(entry.directory);
    if (cache.get(entry.id)?.stamp !== version) {
      try {
        cache.set(entry.id, {
          stamp: version,
          value: readSavedRun(entry.directory),
        });
      } catch {
        cache.set(entry.id, { stamp: version, value: null });
      }
    }
    const saved = cache.get(entry.id)?.value;
    if (!saved) {
      runs.push(unavailable(entry));
      continue;
    }
    const { config, state, review } = saved;
    // Process liveness and heartbeat age can change without a file write.
    const { active, status } = runState(config, state, review);
    runs.push({
      id: entry.id,
      runId: state.runId,
      project: config.project,
      objective: state.objective,
      status,
      active,
      startedAt: state.startedAt,
      tasks: Object.values(state.tasks ?? {}).map((t: any) => ({
        id: t.id,
        status: t.status,
      })),
    });
  }
  runs.sort(
    (a, b) =>
      Number(b.active) - Number(a.active) ||
      (b.startedAt ?? 0) - (a.startedAt ?? 0),
  );
  return {
    at: Date.now(),
    runs,
    watches: store.watches(),
    decisions: compactDecisions(store),
    notifications: store.notifications().map(({ message, ...n }: any) => n),
  };
}

// Detailed reports/telemetry are loaded for the selected run only. Completed
// history never opens hundreds of telemetry readers just to populate a list.
export async function runDetail(store: Store, id: string) {
  const entry = store.run(id);
  if (!entry) return null;
  return (await bridge({ op: "catalog", entries: [{ ...entry, id }] }))[0];
}
