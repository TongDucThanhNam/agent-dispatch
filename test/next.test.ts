import { test, expect } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Store } from "../src/store";
import { save } from "../src/paths";
import { nextAction } from "../src/next";

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dispatch-next-"));
  const store = new Store(root);
  function run(name: string, status = "needs_replan", objectiveId = "objective") {
    const directory = path.join(root, name);
    save(path.join(directory, "config.json"), { project: root, objectiveId, reviewMode: "contract", threadId: "12345678-1234-4234-8234-123456789abc", decisionPolicy: { route: "compact" }, managedCallbacks: true });
    save(path.join(directory, "status.json"), { status, loopActive: false, workerExited: true,
      corrections: 1, limit: 6, tasks: { part: { id: "part", status, attempts: [{ partialEvidence: true, gateReceipt: "receipt.json", acceptanceCoverage: [{ id: "local", status: "passed" }, { id: "external", status: "not_run" }] }] } } });
    return store.register(directory);
  }
  return { store, root, run, close() { store.close(); const target = fs.realpathSync(root); if (path.dirname(target) !== fs.realpathSync(os.tmpdir()) || !path.basename(target).startsWith("dispatch-next-")) throw Error("Unsafe cleanup"); fs.rmSync(target, { recursive: true, force: true }); } };
}

test("next reads bounded human guidance and evidence without transcripts, inference or state changes", () => {
  const f = fixture();
  try {
    const id = f.run("current");
    f.store.addDecision("decision", id, "objective", "needs_user", { reason: "Provider duration requires a decision", reportFile: "decision.md", packet: "large".repeat(50000), usage: [{ input_tokens: 10436 }] });
    const before = JSON.stringify(f.store.decision(id));
    const result = nextAction(f.store, id);
    expect(result.next.action).toBe("human_decision");
    expect(result.status).toBe("needs_replan");
    expect(result.next.reason).toContain("duration");
    expect(result.attention[0].coverage[1].status).toBe("not_run");
    expect(result.notification.route).toBe("local");
    expect(JSON.stringify(result).length).toBeLessThan(2000);
    expect(JSON.stringify(f.store.decision(id))).toBe(before);
    expect(f.store.notifications()).toEqual([]);
  } finally { f.close(); }
});

test("next diagnoses a zero-attempt dispatcher failure instead of repeating a stale human-decision label", () => {
  const f = fixture();
  try {
    const id = f.run("setup");
    const directory = f.store.run(id)!.directory;
    save(path.join(directory, "status.json"), {status: "needs_replan", loopActive: false, workerExited: true,
      error: {kind: "workflow_error", message: "Source byte limit exceeded at Tools/ffmpeg.exe; ".repeat(20000)},
      tasks: {part: {id: "part", status: "pending", attempts: []}}, corrections: 0, limit: 4});
    f.store.addDecision("setup-decision", id, "objective", "needs_user", {reason: "No tasks have attempts remaining"});
    const result = nextAction(f.store, id);
    expect(result.next.action).toBe("diagnose");
    expect(result.next.reason).toContain("before any worker attempt");
    expect(result.next.reason).toContain("Tools/ffmpeg.exe");
    expect(result.progress.attempts).toBe(0);
    expect(JSON.stringify(result).length).toBeLessThan(2500);
    expect(f.store.notifications()).toEqual([]);
  } finally {f.close();}
});

test("next follows a recorded same-objective continuation and refuses foreign targets or cycles", () => {
  const f = fixture();
  try {
    const old = f.run("old"), current = f.run("current", "awaiting_judgment"), foreign = f.run("foreign", "needs_replan", "another-objective");
    f.store.addDecision("old-decision", old, "objective", "superseded", { continuation: { id: current } });
    const next = nextAction(f.store, old);
    expect(next.id).toBe(current);expect(next.requestedId).toBe(old);expect(next.next.action).toBe("judge");
    f.store.updateDecision("old-decision", "superseded", { continuation: { id: foreign } });
    expect(() => nextAction(f.store, old)).toThrow("identity");
    f.store.updateDecision("old-decision", "superseded", { continuation: { id: old } });
    expect(() => nextAction(f.store, old)).toThrow("cycle");
  } finally { f.close(); }
});
