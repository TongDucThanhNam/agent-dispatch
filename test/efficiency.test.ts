import { test, expect } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Store } from "../src/store";
import { save } from "../src/paths";
import { snapshot } from "../src/catalog";
import { serve } from "../src/server";
import { runState } from "../engine/delegate-to-zcode/scripts/run-summary.mjs";

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dispatch-efficiency-"));
  return {
    root,
    clean() {
      const resolved = fs.realpathSync(root);
      if (
        path.dirname(resolved) !== fs.realpathSync(os.tmpdir()) ||
        !path.basename(resolved).startsWith("dispatch-efficiency-")
      )
        throw Error("Unsafe cleanup");
      fs.rmSync(resolved, { recursive: true, force: true });
    },
  };
}
function record(root: string, name: string) {
  const directory = path.join(root, name);
  save(path.join(directory, "config.json"), {
    runDir: directory,
    runId: name,
    project: root,
    reviewMode: "contract",
    expectedModel: "fixture",
  });
  save(path.join(directory, "status.json"), {
    runId: name,
    objective: "Audit fixture",
    status: "awaiting_judgment",
    workerExited: true,
    loopActive: false,
    startedAt: 1,
    updatedAt: 2,
    tasks: { a: { id: "a", status: "accepted", attempts: [] } },
  });
  fs.writeFileSync(
    path.join(directory, "worker-report.md"),
    "# Selected report\n" + "Detailed worker evidence. ".repeat(800),
  );
  return directory;
}
test("compact catalog excludes reports and invalidates changed/missing/restored records", async () => {
  const f = fixture(),
    store = new Store(f.root);
  try {
    const dir = record(f.root, "run"),
      id = store.register(dir);
    const first = await snapshot(store);
    expect(first.runs[0].id).toBe(id);
    expect(first.runs[0].tasks).toEqual([{ id: "a", status: "accepted" }]);
    expect(JSON.stringify(first)).not.toContain("Detailed worker evidence");
    expect(JSON.stringify(first).length).toBeLessThan(1200);
    const statePath = path.join(dir, "status.json"),
      saved = fs.readFileSync(statePath, "utf8");
    fs.unlinkSync(statePath);
    expect((await snapshot(store)).runs[0].status).toBe("unavailable");
    fs.writeFileSync(statePath, saved);
    expect((await snapshot(store)).runs[0].status).toBe("awaiting_judgment");
    save(path.join(dir, "review.json"), { verdict: "accepted" });
    expect((await snapshot(store)).runs[0].status).toBe("complete");
  } finally {
    store.close();
    f.clean();
  }
});
test("liveness is evaluated independently of saved file timestamps", () => {
  const config = { reviewMode: "contract" },
    state = {
      loopActive: true,
      status: "running",
      runnerPid: 123,
      updatedAt: 1000,
    };
  expect(
    runState(config, state, null, { now: 1001, alive: () => true }).status,
  ).toBe("running");
  expect(
    runState(config, state, null, { now: 1001, alive: () => false }).status,
  ).toBe("unconfirmed");
  expect(
    runState(config, state, null, { now: 62000, alive: () => false }).active,
  ).toBe(false);
  expect(
    runState(
      config,
      {
        ...state,
        loopActive: false,
        workerExited: true,
        status: "awaiting_judgment",
      },
      null,
      { now: 62000, alive: () => false },
    ).status,
  ).toBe("awaiting_judgment");
});
test("HTTP summaries and selected reports are separate, conditional and remain reachable", async () => {
  const f = fixture(),
    app = await serve(f.root, 0, { background: false, legacy: false });
  try {
    const a = app.store.register(record(f.root, "a"));
    app.store.register(record(f.root, "b"));
    const listing = await fetch(app.url + "api/snapshot"),
      summary = await listing.text();
    expect(JSON.parse(summary).runs).toHaveLength(2);
    expect(summary).not.toContain("Selected report");
    const unchanged = await fetch(app.url + "api/snapshot", {
      headers: { "If-None-Match": listing.headers.get("etag")! },
    });
    expect(unchanged.status).toBe(304);
    expect(await unchanged.text()).toBe("");
    const selected = await fetch(app.url + "api/runs/" + a),
      detail = (await selected.json()) as any;
    expect(detail.id).toBe(a);
    expect(detail.report).toContain("Selected report");
    expect(detail.documents).toContainEqual({ name: "worker-report.md" });
    expect(
      (
        await fetch(app.url + "api/runs/" + a, {
          headers: { "If-None-Match": selected.headers.get("etag")! },
        })
      ).status,
    ).toBe(304);
    expect((await fetch(app.url + "api/runs/" + "0".repeat(24))).status).toBe(
      404,
    );
  } finally {
    app.close();
    app.store.close();
    f.clean();
  }
});
test("callback candidate queries exclude recorded terminal events across restart without dropping retries", () => {
  const f = fixture();
  let store = new Store(f.root);
  try {
    const id = store.register(record(f.root, "run"));
    expect(store.runsAwaitingNotification()).toHaveLength(1);
    const key = `run:${id}:terminal`;
    store.enqueue(key, "fixture", "Recorded once");
    store.close();
    store = new Store(f.root);
    expect(store.runsAwaitingNotification()).toHaveLength(0);
    expect(store.notifications("pending")).toHaveLength(1);
    expect(store.claim(key)).toBe(true);
    store.delivery(key, "failed", "Fixture transport failure");
    expect(store.notifications("pending")).toHaveLength(0);
    store.retry(key, false);
    expect(store.notifications("pending")).toHaveLength(1);
    expect(store.runsAwaitingNotification()).toHaveLength(0);
    store.putWatch({ id: "done", done: true });
    store.putWatch({ id: "active", done: false });
    expect(store.watches(true).map((w) => w.id)).toEqual(["active"]);
  } finally {
    store.close();
    f.clean();
  }
});
