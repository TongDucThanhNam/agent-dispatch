import { test, expect } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Store } from "../src/store";
import { parseIdle, attachWatch, tickWatches } from "../src/watches";
import { selection, prepare, prepareResume } from "../src/workflow";
import { save } from "../src/paths";
const thread = "12345678-1234-4234-8234-123456789abc";
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dispatch-test-"));
  const store = new Store(root);
  return {
    root,
    store,
    close() {
      this.store.close();
      if (!path.basename(root).startsWith("dispatch-test-"))
        throw Error("Unsafe cleanup");
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}
const response = (id: string, status: string) => ({
  ok: true,
  exitCode: 0,
  stdout: JSON.stringify({
    off_peak_task_id: id,
    status,
    model: "GLM-5.3",
    thought_level: "max",
  }),
  stderr: "",
});

test("continuation preview preserves objective/history while rebinding notification ownership explicitly", () => {
  const f = fixture();
  try {
    const runDir = path.join(f.root, "prior");
    const input = { project: f.root, objectiveId: "audit", objective: "Audit regressions", threadId: thread,
      worker: { provider: "agy" }, tasks: [{ id: "audit", promptFile: path.join(f.root, "assignment.md") }],
    };
    const prior = prepare(input, f.root, f.root);
    expect(prior.notificationRoute).toBe("thread");
    delete prior.notificationRoute; // Saved compact run predates notification separation.
    save(path.join(runDir, "config.json"), prior);
    save(path.join(runDir, "status.json"), { loopActive: false, workerExited: true, ownershipUncertain: false });
    const target = "aaaaaaaa-1234-4234-8234-123456789abc";
    const next = prepareResume(runDir, { threadId: target, notificationRoute: "thread", project: f.root, objectiveId: "audit", objective: "Audit regressions" }, f.root);
    expect(next.threadId).toBe(target);
    expect(next.notificationRoute).toBe("thread");
    expect(next.resumeFrom).toBe(runDir);
    expect(next.ledgerRoot).toBe(prior.ledgerRoot);
    expect(next.tasks).toEqual(prior.tasks);
    const revised = prepareResume(runDir, { taskPatches: { audit: { strategyNotes: "Check supported runtime configuration", worker: { effort: "high" } } }, strategyChange: "Focused task adjustment" }, f.root);
    expect(revised.tasks[0].worker.workerKind).toBe("agy");
    expect(revised.tasks[0].strategyNotes).toContain("runtime configuration");
    expect(revised.tasks[0].promptFile).toBe(prior.tasks[0].promptFile);
    expect(revised.tasks[0].id).toBe("audit");
    expect(() => prepareResume(runDir, { taskPatches: { invented: {} } }, f.root)).toThrow("cannot invent");
    expect(() => prepareResume(runDir, { taskPatches: { audit: { id: "renamed" } } }, f.root)).toThrow("rename");
    expect(() => prepareResume(runDir, { taskPatches: { audit: { promptFiel: "typo.md" } } }, f.root)).toThrow("promptFiel");
    expect(() => prepareResume(runDir, { taskPatches: {}, tasks: [] }, f.root)).toThrow("either tasks");
    expect(fs.existsSync(next.runDir)).toBe(false);
    expect(prepareResume(runDir, {}, f.root).notificationRoute).toBe("local");
    expect(prepareResume(runDir, {}, f.root).threadId).toBe(thread);
    expect(() => prepareResume(runDir, { objectiveId: "reset" }, f.root)).toThrow("cannot change objectiveId");
    expect(() => prepareResume(runDir, { unexplained: true, runDir: "other" }, f.root)).toThrow("unexplained, runDir");
    expect(() => prepareResume(runDir, { notificationRoute: "invisible" }, f.root)).toThrow("Notification route");
  } finally { f.close(); }
});
test("strict IDLE parsing refuses unrelated, nested and unknown states", () => {
  expect(parseIdle(response("job", "completed").stdout, "job").status).toBe(
    "completed",
  );
  expect(() => parseIdle(response("other", "completed").stdout, "job")).toThrow(
    "identity",
  );
  expect(() =>
    parseIdle('{"id":"job","result":{"status":"completed"}}', "job"),
  ).toThrow();
  expect(() => parseIdle("completed", "job")).toThrow();
});
test("a persisted watch resumes after restart and delivers only once", async () => {
  const f = fixture();
  let sends = 0;
  try {
    attachWatch(f.store, { job: "job", thread, project: f.root });
    f.store.close();
    f.store = new Store(f.root);
    const deps = {
      probe: async (id: string) => response(id, "completed"),
      deliver: async () => {
        sends++;
        return { ok: true, exitCode: 0, stdout: "ok", stderr: "" };
      },
    };
    await tickWatches(f.store, deps);
    await tickWatches(f.store, deps);
    expect(sends).toBe(1);
    expect(f.store.watch("job").done).toBe(true);
    expect(f.store.notifications()[0].state).toBe("delivered");
  } finally {
    f.close();
  }
});
test("unknown probe failure does not produce false completion or terminate the watch", async () => {
  const f = fixture();
  try {
    attachWatch(f.store, { job: "job", thread, project: f.root });
    await tickWatches(f.store, {
      probe: async () => response("other", "completed"),
    });
    expect(f.store.watch("job").done).toBe(false);
    expect(f.store.notifications()).toHaveLength(0);
  } finally {
    f.close();
  }
});
test("deadline warning does not stop later completion callback", async () => {
  const f = fixture();
  let now = 2000,
    sends = 0;
  try {
    attachWatch(f.store, {
      job: "job",
      thread,
      project: f.root,
      deadline: new Date(1000).toISOString(),
    });
    const deliver = async () => {
      sends++;
      return { ok: true, exitCode: 0, stdout: "", stderr: "" };
    };
    await tickWatches(f.store, {
      now: () => now,
      probe: async (id) => response(id, "running"),
      deliver,
    });
    expect(f.store.watch("job").done).toBe(false);
    await tickWatches(f.store, {
      now: () => now,
      probe: async (id) => response(id, "running"),
      deliver,
    });
    expect(sends).toBe(1);
    await tickWatches(f.store, {
      probe: async (id) => response(id, "completed"),
      deliver,
    });
    expect(sends).toBe(2);
    expect(f.store.watch("job").done).toBe(true);
  } finally {
    f.close();
  }
});
test("failed callbacks require explicit retry; uncertain crash is never resent automatically", async () => {
  const f = fixture();
  try {
    f.store.enqueue("n", thread, "message");
    expect(f.store.claim("n")).toBe(true);
    expect(f.store.claim("n")).toBe(false);
    f.store.recover();
    expect(f.store.notifications()[0].state).toBe("unconfirmed");
    expect(() => f.store.retry("n", false)).toThrow("Reconcile");
    let sends = 0;
    await tickWatches(f.store, {
      deliver: async () => {
        sends++;
        return { ok: false, exitCode: 1, stdout: "", stderr: "failed" };
      },
    });
    expect(sends).toBe(0);
    f.store.retry("n", true);
    await tickWatches(f.store, {
      deliver: async () => ({
        ok: false,
        exitCode: 1,
        stdout: "",
        stderr: "failed",
      }),
    });
    expect(f.store.notifications()[0].state).toBe("failed");
    f.store.retry("n", false);
    await tickWatches(f.store, {
      deliver: async () => ({ ok: true, exitCode: 0, stdout: "", stderr: "" }),
    });
    expect(f.store.notifications()[0].state).toBe("delivered");
  } finally {
    f.close();
  }
});
test("IDLE attachment preserves origin and legacy delivery without duplicate callbacks", async () => {
  const f = fixture();
  try {
    const file = path.join(f.root, "legacy.json");
    save(file, { job: "job", thread, callback: { succeeded: true } });
    attachWatch(f.store, {
      job: "job",
      thread,
      project: f.root,
      legacyRecord: file,
    });
    expect(f.store.watch("job").done).toBe(true);
    expect(() =>
      attachWatch(f.store, {
        job: "job",
        thread: "ffffffff-ffff-ffff-ffff-ffffffffffff",
        project: f.root,
      }),
    ).toThrow("different");
  } finally {
    f.close();
  }
});
test("one project/night reservation is atomic and persists", () => {
  const f = fixture();
  try {
    f.store.reserve(f.root, "2026-09-15", "first");
    expect(() => f.store.reserve(f.root, "2026-09-15", "second")).toThrow();
    f.store.reserve(f.root, "2026-09-16", "next");
    expect(() => f.store.reserve(f.root, "2026-02-30", "invalid")).toThrow();
  } finally {
    f.close();
  }
});

test("recovered delivery marks the legacy receipt so its old watcher cannot replay it", async () => {
  const f = fixture();
  try {
    const file = path.join(f.root, "legacy-undelivered.json");
    save(file, {
      job: "job",
      thread,
      callback: { succeeded: false, attempts: [] },
      terminal: false,
      status: "watching",
    });
    attachWatch(f.store, {
      job: "job",
      thread,
      project: f.root,
      legacyRecord: file,
    });
    await tickWatches(f.store, {
      probe: async (id) => response(id, "completed"),
      deliver: async () => ({ ok: true, exitCode: 0, stdout: "", stderr: "" }),
    });
    const legacy = JSON.parse(fs.readFileSync(file, "utf8"));
    expect(legacy.callback.succeeded).toBe(true);
    expect(legacy.callback.attempts).toHaveLength(1);
    expect(legacy.status).toBe("completed");
  } finally {
    f.close();
  }
});
test("provider switch resets incompatible model and effort fields", () => {
  expect(selection({ workerKind: "zcode", expectedModel: "GLM-5.3-Flash", expectedProvider: "builtin:zai-coding-plan", zcodeEffort: "max" }).model).toBe("builtin:zai-coding-plan/GLM-5.3-Flash");
  expect(selection({ workerKind: "zcode", expectedModel: "GLM-5.3-Flash", expectedProvider: "zai", zcodeEffort: "high" }).model).toBe("zai/GLM-5.3-Flash");
  expect(
    selection(
      { provider: "zcode" },
      { workerKind: "agy", model: "claude", agyEffort: "high" },
    ),
  ).toEqual({
    workerKind: "zcode",
    model: "builtin:zai-coding-plan/GLM-5.3-Flash",
    zcodeEffort: "max",
  });
  expect(
    selection(
      { provider: "agy" },
      { workerKind: "zcode", model: "GLM-5.3-Flash", zcodeEffort: "max" },
    ),
  ).toEqual({ workerKind: "agy" });
  expect(
    selection({ provider: "zcode", model: "GLM-5.3-Flash", effort: "high" })
      .zcodeEffort,
  ).toBe("high");
  expect(() => selection({ provider: "agy", effort: "max" })).toThrow();
});
test("native terminal callback survives engine exit and deduplicates", async () => {
  const f = fixture();
  let sends = 0;
  try {
    const run = path.join(f.root, "run");
    save(path.join(run, "config.json"), {
      managedCallbacks: true,
      threadId: thread,
      objective: "Example",
      finalJudge: "human",
    });
    save(path.join(run, "status.json"), {
      loopActive: false,
      workerExited: true,
      endedAt: 1,
      status: "awaiting_judgment",
    });
    f.store.register(run);
    const deliver = async () => {
      sends++;
      return { ok: true, exitCode: 0, stdout: "", stderr: "" };
    };
    await tickWatches(f.store, { deliver });
    await tickWatches(f.store, { deliver });
    expect(sends).toBe(1);
  } finally {
    f.close();
  }
});
