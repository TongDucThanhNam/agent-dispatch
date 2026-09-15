import { test, expect } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Store } from "../src/store";
import { save, read, node } from "../src/paths";
import { prepare, launch, bridge } from "../src/workflow";
import { serve } from "../src/server";
import { submitIdle, idleArgs } from "../src/idle";
import { queueDecision, tickDecisions } from "../src/decisions";
const temp = () =>
  fs.mkdtempSync(path.join(os.tmpdir(), "dispatch-integration-"));
const clean = (root: string) => {
  if (!path.basename(root).startsWith("dispatch-integration-"))
    throw Error("Unsafe cleanup");
  fs.rmSync(root, { recursive: true, force: true });
};
test("prepared provider switch does not inherit the previous root model into AGY", async () => {
  const root = temp();
  try {
    fs.mkdirSync(path.join(root, "src"));
    fs.mkdirSync(path.join(root, "test"));
    const assignment = path.join(root, "task.md");
    fs.writeFileSync(assignment, "Implement required behavior");
    const plan = prepare(
      {
        project: root,
        objective: "Provider change",
        notify: false,
        expectedModel: "GLM-5.3-Flash",
        expectedProvider: "builtin:zai-coding-plan",
        zcodeEffort: "max",
        resumeSessionId: "sess_old",
        worker: { provider: "agy" },
        auditPaths: ["src", "test"],
        tasks: [
          {
            id: "a",
            promptFile: assignment,
            writePaths: ["src"],
            checks: [
              { name: "check", command: node, args: ["-e", "process.exit(0)"] },
            ],
            acceptance: [{ id: "a", description: "Check", checks: ["check"] }],
          },
        ],
      },
      root,
      path.join(root, "runtime"),
    );
    const result = await bridge({ op: "validate", plan });
    expect(result.tasks[0].worker).toBe("agy");
    expect(result.tasks[0].model).toBe("pending-selection");
    expect(result.tasks[0].effort).toBeNull();
  } finally {
    clean(root);
  }
});
test("Bun server serves permanent deep links and document links after restart and refuses arbitrary files", async () => {
  const root = temp();
  let app = await serve(root, 0, { background: false, legacy: false });
  try {
    const run = path.join(root, "run"),
      docs = path.join(root, "docs");
    save(path.join(run, "config.json"), { docsDir: docs });
    fs.mkdirSync(docs);
    fs.writeFileSync(path.join(docs, "report.md"), "# Verified report");
    const id = app.store.register(run),
      url = app.url + "runs/" + id;
    const html = await (await fetch(url)).text();
    expect(html).toContain('<base href="' + new URL(app.url).pathname + '">');
    const asset = html.match(/src="(.+?\.js)"/)![1];
    expect((await fetch(new URL(asset, app.url))).status).toBe(200);
    expect(
      await (
        await fetch(app.url + "api/documents/" + id + "/report.md")
      ).text(),
    ).toBe("# Verified report");
    expect(
      (await fetch(app.url + "api/documents/" + id + "/config.json")).status,
    ).not.toBe(200);
    expect(
      (
        await fetch(app.url + "api/stop", {
          method: "POST",
          headers: { Origin: "https://example.com" },
          body: "{}",
        })
      ).status,
    ).toBe(403);
    app.close();
    app.store.close();
    app = await serve(root, undefined, { background: false, legacy: false });
    expect(app.url + "runs/" + id).toBe(url);
    expect((await fetch(url)).status).toBe(200);
    expect(
      (await fetch(app.url + "api/documents/" + id + "/report.md")).status,
    ).toBe(200);
  } finally {
    app.close();
    app.store.close();
    clean(root);
  }
});
test("IDLE submission is one explicit call followed by durable watch; duplicate night cannot submit", async () => {
  const root = temp(),
    store = new Store(root),
    assignment = path.join(root, "task.md");
  fs.writeFileSync(assignment, "Implement the authorized task");
  let submissions = 0;
  const raw = {
    project: root,
    assignment,
    title: "Task with spaces",
    thread: "12345678-1234-4234-8234-123456789abc",
    night: "2026-09-15",
    model: "GLM-5.3",
    effort: "max",
  };
  try {
    const result = await submitIdle(store, raw, async (argv) => {
      submissions++;
      expect(argv).toContain("--thought");
      expect(argv).toContain("max");
      expect(argv).toContain(assignment);
      return {
        ok: true,
        exitCode: 0,
        stdout: '{"id":"offpeak-fixture","state":"queued"}',
        stderr: "",
      };
    });
    expect(result.watchRegistered).toBe(true);
    expect(store.watch("offpeak-fixture").thread).toBe(raw.thread);
    await expect(
      submitIdle(store, raw, async () => {
        throw Error("must not submit");
      }),
    ).rejects.toThrow();
    expect(submissions).toBe(1);
  } finally {
    store.close();
    clean(root);
  }
});
test("ambiguous IDLE submission keeps reservation and never silently resubmits", async () => {
  const root = temp(),
    store = new Store(root),
    assignment = path.join(root, "task.md");
  fs.writeFileSync(assignment, "Task");
  const raw = {
    project: root,
    assignment,
    title: "Task",
    thread: "12345678-1234-4234-8234-123456789abc",
    night: "2026-09-15",
    model: "GLM-5.3",
  };
  try {
    await expect(
      submitIdle(store, raw, async () => ({
        ok: false,
        exitCode: null,
        stdout: "",
        stderr: "timeout",
        uncertain: true,
      })),
    ).rejects.toThrow("Reservation retained");
    expect(() => store.reserve(root, raw.night, "duplicate")).toThrow();
    expect(store.watches()).toHaveLength(0);
  } finally {
    store.close();
    clean(root);
  }
});
test("Bun entrypoint launches fake native adapter, executes real gates, stores Markdown separately and uses external checkpoints", async () => {
  const root = temp(),
    project = path.join(root, "project"),
    runtime = path.join(root, "runtime");
  fs.mkdirSync(path.join(project, "src"), { recursive: true });
  fs.mkdirSync(path.join(project, "test"));
  const store = new Store(runtime),
    assignment = path.join(root, "task.md"),
    adapter = path.join(root, "fake.mjs"),
    catalog = path.join(root, "models.json");
  fs.writeFileSync(
    assignment,
    "Implement the acceptance behavior and test it.",
  );
  fs.writeFileSync(path.join(project, "src/user.txt"), "existing dirty work");
  fs.writeFileSync(
    path.join(project, "test/gate.mjs"),
    `import fs from 'node:fs';import assert from 'node:assert/strict';assert.equal(fs.readFileSync('src/result.txt','utf8'),'good');console.log('acceptance passed');`,
  );
  fs.writeFileSync(
    adapter,
    `import fs from 'node:fs';const a=process.argv.slice(2),p=a[a.indexOf('--prompt')+1],cwd=a[a.indexOf('--cwd')+1];fs.writeFileSync(cwd+'/src/result.txt','good');console.log(JSON.stringify({sessionId:'sess_fixture',response:p.match(/^Stage: .+$/m)[0]+'\\n'+p.match(/^Contract: .+$/m)[0]+'\\nVerified'}));`,
  );
  save(catalog, { provider: { fixture: { models: { model: {} } } } });
  let runDir: string | undefined;
  try {
    const plan = prepare(
      {
        project,
        objective: "Complete the known fixture",
        objectiveId: "fixture",
        notify: false,
        worker: { provider: "zcode", model: "fixture/model" },
        adapter,
        cliConfig: catalog,
        pollMs: 100,
        quietMs: 500,
        stallMs: 2000,
        auditPaths: ["src", "test"],
        tasks: [
          {
            id: "a",
            promptFile: assignment,
            writePaths: ["src/result.txt"],
            gateFiles: ["test/gate.mjs"],
            checks: [
              { name: "behavior", command: node, args: ["test/gate.mjs"] },
            ],
            acceptance: [
              {
                id: "value",
                description: "result is good",
                checks: ["behavior"],
              },
            ],
          },
        ],
      },
      root,
      runtime,
    );
    const receipt = await launch(plan, store);
    runDir = receipt.runDir;
    expect(receipt.error).toBeUndefined();
    expect(runDir?.startsWith(runtime)).toBe(true);
    let state: any;
    for (let i = 0; i < 100; i++) {
      try {
        state = read(path.join(runDir!, "status.json"));
        if (state.loopActive === false) break;
      } catch {}
      await Bun.sleep(50);
    }
    expect(state.status).toBe("awaiting_judgment");
    expect(state.gateRuns).toBe(2);
    const taskDir = state.tasks.a.attempts[0].runDir;
    const prompt = fs.readFileSync(path.join(taskDir, "assignment.md"), "utf8");
    expect(prompt).toContain(
      "Read " + path.join(taskDir, "contract.json") + " once",
    );
    expect(prompt).not.toContain(plan.tasks[0].promptFile);
    expect(read(path.join(taskDir, "contract.json")).assignment).toBe(
      "Implement the acceptance behavior and test it.",
    );
    expect(fs.readFileSync(path.join(project, "src/user.txt"), "utf8")).toBe(
      "existing dirty work",
    );
    expect(fs.readdirSync(plan.docsDir).every((f) => f.endsWith(".md"))).toBe(
      true,
    );
    expect(fs.existsSync(path.join(runtime, "objects"))).toBe(true);
    expect(fs.existsSync(path.join(runDir!, "waves/wave-1/files"))).toBe(false);
    expect(
      (await bridge({ op: "brief", options: { "run-dir": runDir } })).tasks[0]
        .status,
    ).toBe("accepted");
    for (let i = 0; i < 30; i++) {
      try {
        process.kill(state.runnerPid, 0);
      } catch {
        break;
      }
      await Bun.sleep(30);
    }
    const app = await serve(runtime, 0, { background: false, legacy: false });
    try {
      const judged = await fetch(app.url + "api/judge", {
        method: "POST",
        headers: {
          Origin: new URL(app.url).origin,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          id: receipt.id,
          verdict: "accepted",
          report: "Fixture operator verified the required result.",
        }),
      });
      expect(judged.status).toBe(200);
      expect(read(path.join(runDir!, "status.json")).status).toBe("complete");
    } finally {
      app.close();
      app.store.close();
    }
  } finally {
    store.close();
    clean(root);
  }
}, 15000);

test("strategic decision resumes the actual worker engine without resetting attempts or requiring Main", async () => {
  const root = temp(),
    project = path.join(root, "project"),
    runtime = path.join(root, "runtime");
  fs.mkdirSync(path.join(project, "src"), { recursive: true });
  fs.mkdirSync(path.join(project, "test"));
  const assignment = path.join(root, "task.md"),
    adapter = path.join(root, "worker.mjs"),
    catalog = path.join(root, "models.json"),
    store = new Store(runtime);
  fs.writeFileSync(
    assignment,
    "Implement result=good using the existing contract.",
  );
  fs.writeFileSync(
    path.join(project, "test/gate.mjs"),
    "import fs from 'node:fs';import assert from 'node:assert/strict';assert.equal(fs.readFileSync('src/result.txt','utf8'),'good');",
  );
  fs.writeFileSync(
    adapter,
    `import fs from 'node:fs';const a=process.argv.slice(2),p=a[a.indexOf('--prompt')+1],cwd=a[a.indexOf('--cwd')+1];const c=JSON.parse(fs.readFileSync(p.match(/Read (.+) once for/)[1],'utf8'));fs.writeFileSync(cwd+'/src/result.txt',c.strategy?'good':'pending');console.log(JSON.stringify({sessionId:'sess_strategy_fixture',response:p.match(/^Stage: .+$/m)[0]+'\\n'+p.match(/^Contract: .+$/m)[0]+'\\n'+(c.strategy?'Complete':'CONTRACT_BLOCKED: need bounded guidance within existing interface')}));`,
  );
  save(catalog, { provider: { fixture: { models: { model: {} } } } });
  async function finished(directory: string) {
    for (let i = 0; i < 160; i++) {
      const file = path.join(directory, "status.json");
      if (fs.existsSync(file)) {
        const state = read(file);
        if (state.loopActive === false) {
          try {
            process.kill(state.runnerPid, 0);
          } catch {
            return state;
          }
        }
      }
      await Bun.sleep(50);
    }
    throw Error("Fixture worker did not finish");
  }
  try {
    const plan = prepare(
      {
        project,
        objective: "Satisfy the persisted outcome",
        objectiveId: "strategy-fixture",
        threadId: "12345678-1234-4234-8234-123456789abc",
        worker: { provider: "zcode", model: "fixture/model" },
        adapter,
        cliConfig: catalog,
        pollMs: 100,
        quietMs: 500,
        stallMs: 2000,
        decisionPolicy: { route: "compact", maxCalls: 1 },
        auditPaths: ["src", "test"],
        tasks: [
          {
            id: "a",
            promptFile: assignment,
            writePaths: ["src/result.txt"],
            gateFiles: ["test/gate.mjs"],
            checks: [
              { name: "behavior", command: node, args: ["test/gate.mjs"] },
            ],
            acceptance: [
              {
                id: "outcome",
                description: "result is good",
                checks: ["behavior"],
              },
            ],
          },
        ],
      },
      root,
      runtime,
    );
    const first = await launch(plan, store);
    expect((await finished(first.runDir)).status).toBe("needs_replan");
    queueDecision(store, first.id);
    let calls = 0;
    await tickDecisions(store, {
      invoke: async (_dir, prompt) => {
        calls++;
        return {
          ok: true,
          uncertain: false,
          error: null,
          toolUsed: false,
          usage: [],
          response: {
            packetHash: JSON.parse(prompt).packetHash,
            action: "retry",
            taskId: "a",
            reason: "Use the existing interface",
            guidance:
              "The current persisted identifier is authoritative; implement the assigned outcome without changing that interface.",
          },
        };
      },
    });
    const decision = store.decision(first.id);
    expect(decision.state).toBe("applied");
    const final = await finished(decision.data.continuation.runDir);
    expect(final.status).toBe("awaiting_judgment");
    expect(final.tasks.a.attempts).toHaveLength(2);
    expect(final.corrections).toBe(1);
    expect(calls).toBe(1);
    const next = read(
      path.join(decision.data.continuation.runDir, "config.json"),
    );
    expect(next.tasks[0].worker.expectedModel).toBe("model");
    expect(next.maxObjectiveCorrections).toBe(
      plan.maxObjectiveCorrections ?? 6,
    );
    queueDecision(store, decision.data.continuation.id);
    await tickDecisions(store, {
      invoke: async () => {
        throw Error("Human judgment must not invoke Astra");
      },
    });
    expect(store.decision(decision.data.continuation.id).started).toBeNull();
  } finally {
    store.close();
    clean(root);
  }
}, 20000);
