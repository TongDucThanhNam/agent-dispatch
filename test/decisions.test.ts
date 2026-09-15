import { test, expect } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Store } from "../src/store";
import { save, read } from "../src/paths";
import { tickWatches, attachWatch } from "../src/watches";
import {
  buildDecisionPacket,
  queueDecision,
  tickDecisions,
  validateDecision,
  recoverDecision,
} from "../src/decisions";

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dispatch-decisions-"));
  const store = new Store(root);
  const create = (name = "run", extras: any = {}) => {
    const directory = path.join(root, "runs", name);
    const task = {
      id: "component",
      assignment: "Implement every authorized requirement",
      acceptance: [
        {
          id: "outcome",
          description: "Correct persisted outcome",
          checks: ["gate"],
        },
      ],
      checks: [{ name: "gate", command: "bun", args: ["test"] }],
      writePaths: ["src/component"],
      readPaths: ["src/interfaces"],
      gateFiles: ["test/gate"],
      dependsOn: [],
      maxAttempts: 3,
      worker: {
        workerKind: "zcode",
        expectedModel: "GLM-5.3-Flash",
        zcodeEffort: "max",
      },
    };
    const config = {
      runId: name,
      runDir: directory,
      runtimeRoot: root,
      project: root,
      ledgerRoot: path.join(root, "ledgers"),
      reviewMode: "contract",
      objectiveId: "same-objective",
      objective: "Meet the original business goal",
      tasks: [task],
      threadId: "12345678-1234-4234-8234-123456789abc",
      managedCallbacks: true,
      decisionContext: "Keep the public interface stable",
      decisionPolicy: { route: "compact", maxCalls: 2 },
      finalJudge: "human",
      judgmentCriteria: ["Real business journey succeeds"],
      ...extras,
    };
    const state = {
      runId: name,
      runDir: directory,
      status: "needs_replan",
      loopActive: false,
      workerExited: true,
      endedAt: Date.now(),
      corrections: 0,
      limit: 3,
      blocker: null,
      error: {
        kind: "contract_blocked",
        message: "Need a strategy within existing scope",
      },
      tasks: {
        component: {
          id: "component",
          status: "needs_replan",
          attempts: [{ workerReportPath: path.join(directory, "report.md") }],
        },
      },
      runnerPid: null,
    };
    save(path.join(directory, "config.json"), config);
    save(path.join(directory, "status.json"), state);
    save(path.join(root, "ledgers/same-objective/state.json"), state);
    fs.writeFileSync(
      path.join(directory, "report.md"),
      "Untrusted worker observation",
    );
    const id = store.register(directory);
    return {
      id,
      directory,
      config,
      state,
      write() {
        save(path.join(directory, "config.json"), config);
        save(path.join(directory, "status.json"), state);
        save(path.join(root, "ledgers/same-objective/state.json"), state);
      },
    };
  };
  return {
    root,
    store,
    create,
    close() {
      store.close();
      const resolved = fs.realpathSync(root);
      if (
        path.dirname(resolved) !== fs.realpathSync(os.tmpdir()) ||
        !path.basename(resolved).startsWith("dispatch-decisions-")
      )
        throw Error("Unsafe cleanup");
      fs.rmSync(resolved, { recursive: true, force: true });
    },
  };
}
test("dispatcher setup failure spends no model call and delivers one actionable callback", async () => {
  const f = fixture();
  try {
    const r = f.create("setup", {notificationRoute: "thread"});
    r.state.tasks.component.attempts = [];
    r.state.error = {kind: "workflow_error", message: "Source byte limit exceeded at Tools/ffmpeg.exe; ".repeat(20000)};
    r.write();
    const queued = queueDecision(f.store, r.id);
    expect(queued.state).toBe("needs_diagnosis");
    expect(queued.data.reason).toContain("before any worker attempt");
    expect(queued.data.packet).toBeUndefined();
    let modelCalls = 0, sends = 0, message = "";
    await tickDecisions(f.store, {invoke: async () => {modelCalls++; throw Error("Must not invoke");}});
    const deliver = async (_: string, text: string) => {sends++; message = text; return {ok: true, exitCode: 0, stdout: "", stderr: ""};};
    await tickWatches(f.store, {deliver});
    await tickWatches(f.store, {deliver});
    expect(modelCalls).toBe(0); expect(sends).toBe(1);
    expect(message).toContain("Do not ask permission merely to diagnose");
    expect(message).toContain("Tools/ffmpeg.exe"); expect(message.length).toBeLessThan(2000);
  } finally {f.close();}
});

const response = (prompt: string, extra: any = {}) => ({
  ok: true,
  uncertain: false,
  error: null,
  toolUsed: false,
  usage: [{ input_tokens: 100, cached_input_tokens: 0, output_tokens: 10 }],
  response: {
    packetHash: JSON.parse(prompt).packetHash,
    action: "needs_user",
    taskId: null,
    reason: "Need a human decision",
    guidance: "",
    ...extra,
  },
});

test("real-world needs_user response can reference the affected task without assigning work", async () => {
  const f = fixture();
  try {
    const run = f.create();
    queueDecision(f.store, run.id);
    let continuations = 0;
    await tickDecisions(f.store, {
      invoke: async (_dir, prompt) => response(prompt, {
        taskId: "component",
        reason: "Required output is absent and further submissions are forbidden.",
        guidance: "Request human disposition without retrying the refused request.",
      }),
      continueRun: async () => { continuations++; throw Error("Must not launch"); },
    });
    const row = f.store.decision(run.id);
    expect(row.state).toBe("needs_user");
    expect(row.data.result.taskId).toBe("component");
    expect(row.data.reason).toContain("further submissions are forbidden");
    expect(fs.readFileSync(row.data.reportFile, "utf8")).toContain("human disposition");
    expect(continuations).toBe(0);
    const packet = buildDecisionPacket(run.directory).packet;
    expect(() => validateDecision({ ...row.data.result, taskId: "unknown" }, packet)).toThrow("unknown task");
  } finally { f.close(); }
});

test("saved human guidance recovers without another invocation and rejects stale or actionable output", () => {
  const f = fixture();
  try {
    const run = f.create();
    const row = queueDecision(f.store, run.id);
    f.store.claimDecision(row.id);
    f.store.updateDecision(row.id, "needs_user", { reason: "This decision cannot assign a task", usage: [{ input_tokens: 10436 }] });
    const answer = response(JSON.stringify(read(row.data.packetPath)), { taskId: "component" }).response;
    save(path.join(row.data.directory, "response.json"), answer);
    const result = recoverDecision(f.store, run.id);
    expect(result.modelCalls).toBe(0);
    expect(f.store.decision(run.id).data.usage).toEqual([{ input_tokens: 10436 }]);
    expect(f.store.decision(run.id).data.result).toEqual(answer);
    expect(f.store.notifications()).toHaveLength(0);
    save(path.join(row.data.directory, "response.json"), { ...answer, action: "retry", guidance: "Use another approach" });
    expect(() => recoverDecision(f.store, run.id)).toThrow("cannot execute");
    run.state.corrections++;
    run.write();
    expect(() => recoverDecision(f.store, run.id)).toThrow("stale");
  } finally { f.close(); }
});

test("compact strategy settles before one deduplicated callback to the rebound task", async () => {
  const f = fixture();
  try {
    const thread = "aaaaaaaa-1234-4234-8234-123456789abc";
    const run = f.create("attention", { notificationRoute: "thread", threadId: thread });
    const messages: string[] = [];
    const deliver = async (target: string, message: string) => {
      expect(target).toBe(thread);
      messages.push(message);
      return { ok: true, exitCode: 0, stdout: "accepted", stderr: "" };
    };
    await tickWatches(f.store, { deliver });
    expect(messages).toHaveLength(0);
    expect(f.store.notifications()).toHaveLength(0);
    await tickDecisions(f.store, { invoke: async (_dir, prompt) => response(prompt, { taskId: "component", reason: "External capability decision required" }) });
    await tickWatches(f.store, { deliver });
    await tickWatches(f.store, { deliver });
    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain("External capability decision required");
    expect(f.store.notifications()[0].attempts).toBe(1);
    expect(f.store.notifications()[0].state).toBe("delivered");
  } finally { f.close(); }
});

test("successful compact continuation stays quiet until the resumed run needs attention", async () => {
  const f = fixture();
  try {
    const run = f.create("quiet-retry", { notificationRoute: "thread" });
    queueDecision(f.store, run.id);
    await tickDecisions(f.store, {
      invoke: async (_dir, prompt) => response(prompt, { action: "retry", taskId: "component", guidance: "Keep the interface; adjust the approach" }),
      continueRun: async () => ({ id: "continued-run" }),
    });
    await tickWatches(f.store, { deliver: async () => { throw Error("Must remain quiet"); } });
    expect(f.store.notifications()[0].state).toBe("local");
    expect(f.store.notifications()[0].detail).toContain("continued");
  } finally { f.close(); }
});

test("human-ready result notifies once without invoking Astra, and local policy remains quiet", async () => {
  const f = fixture();
  try {
    const run = f.create("ready", { notificationRoute: "thread" });
    run.state.status = "awaiting_judgment";
    (run.state as any).finalValidation = { passed: true };
    run.write();
    let calls = 0;
    const deliver = async () => { calls++; return { ok: true, exitCode: 0, stdout: "accepted", stderr: "" }; };
    await tickWatches(f.store, { deliver });
    await tickDecisions(f.store, { invoke: async () => { throw Error("No inference for human judgment"); } });
    await tickWatches(f.store, { deliver });
    expect(calls).toBe(1);
    expect(f.store.decision(run.id).started).toBeNull();
  } finally { f.close(); }
});

test("human-ready native result stays local, with zero original-thread callbacks and zero Astra calls", async () => {
  const f = fixture();
  try {
    const run = f.create();
    run.state.status = "awaiting_judgment";
    (run.state as any).finalValidation = { passed: true };
    run.write();
    let calls = 0,
      deliveries = 0;
    await tickWatches(f.store, {
      deliver: async () => {
        deliveries++;
        return { ok: true, exitCode: 0, stdout: "", stderr: "" };
      },
    });
    await tickDecisions(f.store, {
      invoke: async (_dir, prompt) => {
        calls++;
        return response(prompt);
      },
    });
    await tickWatches(f.store);
    expect(calls).toBe(0);
    expect(deliveries).toBe(0);
    expect(f.store.notifications()[0].state).toBe("local");
    expect(f.store.notifications()[0].attempts).toBe(0);
    expect(f.store.decision(run.id).data.reason).toContain("human judgment");
  } finally {
    f.close();
  }
});
test("bounded strategic retry preserves every task, gate, provider and budget and applies only once", async () => {
  const f = fixture();
  try {
    const run = f.create();
    queueDecision(f.store, run.id);
    let calls = 0,
      continuations = 0;
    const deps = {
      invoke: async (_dir: string, prompt: string) => {
        calls++;
        return response(prompt, {
          action: "retry",
          taskId: "component",
          reason: "Preserve the interface and change the approach",
          guidance:
            "Resolve the ambiguity using the existing persisted identifier, preserving every invariant.",
        });
      },
      continueRun: async (directory: string, patch: any) => {
        continuations++;
        expect(directory).toBe(run.directory);
        expect(Object.keys(patch).sort()).toEqual(["strategyChange", "tasks"]);
        expect(patch.tasks[0]).toEqual({
          ...run.config.tasks[0],
          strategyNotes: expect.any(String),
        });
        return { id: "next-run", runDir: "next-directory" };
      },
    };
    await tickDecisions(f.store, deps);
    await tickDecisions(f.store, deps);
    queueDecision(f.store, run.id);
    expect(calls).toBe(1);
    expect(continuations).toBe(1);
    expect(f.store.decision(run.id).state).toBe("applied");
    expect(f.store.decision(run.id).data.usage[0].input_tokens).toBe(100);
  } finally {
    f.close();
  }
});
test("decision allowance survives multiple runs and database restart", async () => {
  const f = fixture();
  try {
    const first = f.create("one", {
      decisionPolicy: { route: "compact", maxCalls: 1 },
    });
    queueDecision(f.store, first.id);
    let calls = 0;
    const invoke = async (_dir: string, prompt: string) => {
      calls++;
      return response(prompt);
    };
    await tickDecisions(f.store, { invoke });
    const second = f.create("two", {
      decisionPolicy: { route: "compact", maxCalls: 1 },
    });
    queueDecision(f.store, second.id);
    const reopened = new Store(f.root);
    try {
      await tickDecisions(reopened, { invoke });
      expect(reopened.decision(second.id).data.reason).toContain(
        "allowance exhausted",
      );
    } finally {
      reopened.close();
    }
    expect(calls).toBe(1);
  } finally {
    f.close();
  }
});
test("oversized authority is never truncated into a model request", async () => {
  const f = fixture();
  try {
    const run = f.create();
    run.config.tasks[0].assignment = "Required outcome. ".repeat(2000);
    run.write();
    expect(() => buildDecisionPacket(run.directory)).toThrow(
      "requirements were not truncated",
    );
    queueDecision(f.store, run.id);
    expect(f.store.decision(run.id).state).toBe("needs_user");
    expect(f.store.decision(run.id).started).toBeNull();
  } finally {
    f.close();
  }
});
test("quota, cancellation, exhausted worker budget and uncertain ownership do not spend Astra calls", async () => {
  for (const patch of [
    { blocker: "quota", status: "blocked" },
    { status: "cancelled" },
    { corrections: 3 },
    { workerExited: false },
  ]) {
    const f = fixture();
    try {
      const run = f.create();
      Object.assign(run.state, patch);
      run.write();
      queueDecision(f.store, run.id);
      await tickDecisions(f.store, {
        invoke: async () => {
          throw Error("must not invoke");
        },
      });
      expect(f.store.decision(run.id).started).toBeNull();
      expect(f.store.decision(run.id).state).toBe("needs_user");
    } finally {
      f.close();
    }
  }
});

test("caller-selected human blocker bypasses Astra and retains partial acceptance evidence", async () => {
  const f = fixture();
  try {
    const run = f.create();
    (run.config.tasks[0] as any).onBlocked = "human";
    (run.state.tasks.component as any).blockedDecision = { route: "human", reason: "Provider cannot supply the required duration" };
    (run.state.tasks.component.attempts[0] as any).partialEvidence = true;
    run.write();
    queueDecision(f.store, run.id);
    await tickDecisions(f.store, { invoke: async () => { throw Error("No model call for a required human disposition"); } });
    expect(f.store.decision(run.id).started).toBeNull();
    expect(f.store.decision(run.id).data.reason).toContain("required duration");
    expect(buildDecisionPacket(run.directory).packet.authority.eligibleRetryTasks).toEqual([]);
  } finally { f.close(); }
});
test("malformed output, extra authority fields and wrong hash cannot trigger continuation", async () => {
  const f = fixture();
  try {
    const run = f.create(),
      { packet } = buildDecisionPacket(run.directory);
    const valid = response(JSON.stringify(packet)).response;
    expect(() => validateDecision({ ...valid, maxCalls: 100 }, packet)).toThrow(
      "fields",
    );
    expect(() =>
      validateDecision({ ...valid, packetHash: "old" }, packet),
    ).toThrow("Stale");
    expect(() =>
      validateDecision({ ...valid, action: "accept" }, packet),
    ).toThrow("unauthorized");
    expect(() =>
      validateDecision(
        {
          ...valid,
          action: "retry",
          taskId: "invented",
          guidance: "Change scope",
        },
        packet,
      ),
    ).toThrow("eligible");
    queueDecision(f.store, run.id);
    await tickDecisions(f.store, {
      invoke: async (_dir, prompt) => response(prompt, { maxCalls: 100 }),
      continueRun: async () => {
        throw Error("must not continue");
      },
    });
    expect(f.store.decision(run.id).state).toBe("needs_user");
  } finally {
    f.close();
  }
});
test("state changed while deciding cannot be applied", async () => {
  const f = fixture();
  try {
    const run = f.create();
    queueDecision(f.store, run.id);
    await tickDecisions(f.store, {
      invoke: async (_dir, prompt) => {
        run.state.corrections++;
        run.write();
        return response(prompt);
      },
    });
    expect(f.store.decision(run.id).data.reason).toContain("changed while");
  } finally {
    f.close();
  }
});
test("timeout and crash remain unconfirmed and do not automatically invoke again", async () => {
  const f = fixture();
  try {
    const run = f.create();
    queueDecision(f.store, run.id);
    let calls = 0;
    const invoke = async (_dir: string, prompt: string) => {
      calls++;
      return {
        ...response(prompt),
        ok: false,
        uncertain: true,
        error: "timeout",
      };
    };
    await tickDecisions(f.store, { invoke });
    await tickDecisions(f.store, { invoke });
    expect(calls).toBe(1);
    expect(f.store.decision(run.id).state).toBe("unconfirmed");
    const other = f.create("other");
    queueDecision(f.store, other.id);
    expect(f.store.claimDecision(`decision-${other.id}`)).toBe(true);
    f.store.recover();
    expect(f.store.decision(other.id).state).toBe("unconfirmed");
  } finally {
    f.close();
  }
});
test("explicit Astra final judge uses the existing independent judgment guard", async () => {
  const f = fixture();
  try {
    const run = f.create("final", { finalJudge: "astra" });
    run.state.status = "awaiting_judgment";
    (run.state as any).finalValidation = {
      passed: true,
      receipts: [],
      fingerprint: "fixture",
    };
    run.write();
    queueDecision(f.store, run.id);
    let judges = 0;
    await tickDecisions(f.store, {
      invoke: async (_dir, prompt) =>
        response(prompt, {
          action: "accept",
          reason: "Fixture evidence supports the final criteria",
        }),
      judge: async (payload) => {
        judges++;
        expect(payload.options.actor).toBe("astra");
        expect(payload.options.verdict).toBe("accepted");
        expect(fs.existsSync(payload.options["report-file"])).toBe(true);
        return { status: "complete" };
      },
    });
    expect(judges).toBe(1);
    expect(f.store.decision(run.id).state).toBe("applied");
  } finally {
    f.close();
  }
});
test("new local IDLE route records completion without waking the original conversation", async () => {
  const f = fixture();
  try {
    attachWatch(f.store, {
      job: "idle-fixture",
      thread: "12345678-1234-4234-8234-123456789abc",
      project: f.root,
      callbackRoute: "local",
    });
    let calls = 0;
    await tickWatches(f.store, {
      probe: async (id) => ({
        ok: true,
        exitCode: 0,
        stdout: JSON.stringify({ id, status: "completed" }),
        stderr: "",
      }),
      deliver: async () => {
        calls++;
        throw Error("must not send");
      },
    });
    expect(calls).toBe(0);
    expect(f.store.notifications()[0].state).toBe("local");
    expect(f.store.watch("idle-fixture").done).toBe(true);
  } finally {
    f.close();
  }
});

test("large future task assignments do not bloat a failed task's decision or bypass its exhausted budget", () => {
  const f = fixture();
  try {
    const run = f.create();
    for (let i = 0; i < 20; i++) {
      const id = `future-${i}`;
      run.config.tasks.push({...run.config.tasks[0], id, assignment: "Future implementation detail. ".repeat(250), dependsOn: ["component"]});
      (run.state.tasks as any)[id] = {id, status: "pending", attempts: []};
    }
    run.write();
    const built = buildDecisionPacket(run.directory);
    expect(built.packet.authority.tasks.map((t: any) => t.id)).toEqual(["component"]);
    expect(built.packet.authority.otherTasks).toHaveLength(20);
    expect(built.bytes).toBeLessThan(6000);
    run.state.tasks.component.attempts.push(...run.state.tasks.component.attempts, ...run.state.tasks.component.attempts);
    run.write(); queueDecision(f.store, run.id);
    expect(f.store.decision(run.id).started).toBeNull();
    expect(f.store.decision(run.id).data.reason).toContain("No failed");
  } finally {f.close();}
});
