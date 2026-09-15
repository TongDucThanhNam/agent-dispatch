#!/usr/bin/env bun
import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { home, read, save, keyFor, projectRoot, node, zcode } from "./paths";
import { Store } from "./store";
import { prepare, prepareResume, bridge, launch, resume, defaultZcodeModel } from "./workflow";
import { ensureServer } from "./daemon";
import { attachWatch } from "./watches";
import { importLegacy, snapshot } from "./catalog";
import { submitIdle } from "./idle";
import { nextAction } from "./next";
import {
  buildDecisionPacket,
  queueDecision,
  compactDecisions,
  recoverDecision,
} from "./decisions";
const help = `agent-dispatch — Astra contracts → ZCode / AGY execution → machine gates

  init --project DIR --out FILE                 Write a contract starter; no job starts
  validate [ID] --plan FILE                     Validate a new plan or continuation; starts nothing
  run --plan FILE [--provider zcode|agy] [--model MODEL] [--effort LEVEL] [--thread UUID] [--callback-route thread|local]
  status ID                                    Compact run or IDLE status
  next ID                                      Bounded next action; follows recorded continuations, no inference
  list [--project DIR] [--limit N]              Bounded runs, watches and callback delivery
  decisions                                    Local decision inbox; no Astra call
  decision ID [--dry-run|--recover]             Inspect, queue, or restore a saved needs_user answer without inference
  dashboard [ID]                               Start/recover stable React dashboard
  import --run-dir DIR                          Register an existing run without executing it
  resume ID --plan FILE [--dry-run] [--thread UUID] [--callback-route thread|local]
  switch ID --provider zcode|agy [--model MODEL] [--effort LEVEL] [--thread UUID] [--callback-route thread|local]
  stop ID                                      Stop owned worker/check processes
  judge ID --actor human|astra --verdict accepted|changes_required --report FILE
  rollback ID --wave N                          Restore a verified source checkpoint
  watch --job ID --project DIR --thread UUID [--deadline ISO]
        [--callback-route local|thread] [--legacy-record FILE --legacy-pid PID]
  reserve --project DIR --night YYYY-MM-DD --job ID
  idle-submit --project DIR --assignment FILE --title TEXT --thread UUID
              --model MODEL --effort LEVEL --night YYYY-MM-DD [--callback-route local|thread] [--dry-run]
  notify-retry ID [--reconciled]                 Retry failed/uncertain callback explicitly
  doctor                                       Runtime/tool paths and dashboard health

Provider switching requires a stopped worker; contracts and budgets persist.
IDLE submission and watch registration are one command; watch alone never submits.
New native plans use compact Astra decisions and one terminal attention callback. --callback-route local disables that wakeup.
Existing runs keep their saved notification route. New IDLE watches notify locally.
All output is JSON. Implementation uses the original checkout. No worktrees.
`;
export async function main(argv = process.argv.slice(2)) {
  if (!argv.length || ["-h", "--help", "help"].includes(argv[0])) {
    console.log(help);
    return;
  }
  if (argv.length === 2 && ["--help", "-h"].includes(argv[1])) {
    const usage = help.split("\n").find(line => line.trimStart().startsWith(argv[0] + " "));
    if (!usage) throw Error(`Unknown command ${argv[0]}`);
    console.log(usage.trim());
    return;
  }
  const { values: v, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    strict: true,
    options: Object.fromEntries(
      [
        "plan",
        "project",
        "out",
        "provider",
        "model",
        "effort",
        "run-dir",
        "actor",
        "verdict",
        "report",
        "wave",
        "job",
        "thread",
        "deadline",
        "legacy-record",
        "legacy-pid",
        "night",
        "assignment",
        "title",
        "callback-route",
        "limit",
      ]
        .map((k) => [k, { type: "string" }])
        .concat([
          ["reconciled", { type: "boolean" }],
          ["dry-run", { type: "boolean" }],
          ["recover", { type: "boolean" }],
        ] as any),
    ) as any,
  });
  const options = v as Record<string, any>,
    [command, id] = positionals;
  const accepted: Record<string, string[]> = {
    init: ["project", "out"],
    validate: ["plan", "provider", "model", "effort", "thread", "callback-route"],
    run: ["plan", "provider", "model", "effort", "thread", "callback-route"],
    status: [],
    next: [],
    list: ["project", "limit"],
    decisions: [],
    decision: ["dry-run", "recover"],
    dashboard: [],
    import: ["run-dir"],
    resume: ["plan", "dry-run", "thread", "callback-route"],
    switch: ["provider", "model", "effort", "thread", "callback-route"],
    stop: [],
    judge: ["actor", "verdict", "report"],
    rollback: ["wave"],
    watch: [
      "callback-route",
      "job",
      "project",
      "thread",
      "deadline",
      "legacy-record",
      "legacy-pid",
    ],
    reserve: ["project", "night", "job"],
    "idle-submit": [
      "callback-route",
      "project",
      "assignment",
      "title",
      "thread",
      "model",
      "effort",
      "night",
      "deadline",
      "dry-run",
    ],
    "notify-retry": ["reconciled"],
    doctor: [],
  };
  if (!accepted[command]) throw Error(`Unknown command ${command}`);
  for (const key of Object.keys(options))
    if (!accepted[command].includes(key))
      throw Error(`--${key} is not valid for ${command}`);
  if (positionals.length > 2) throw Error("Unexpected positional argument");
  const store = new Store();
  const requireValue = (name: string) => {
    if (!options[name]) throw Error(`--${name} is required`);
    return options[name];
  };
  const directory = () => {
    if (!id) throw Error("A run ID is required");
    const r =
      store.run(id) ??
      store.runs().find((r) => path.basename(r.directory) === id);
    if (!r) throw Error("Unknown run; import its directory first");
    return r.directory;
  };
  const print = (value: any) => console.log(JSON.stringify(value, null, 2));
  try {
    if (command === "init") {
      const file = path.resolve(requireValue("out")),
        project = path.resolve(requireValue("project"));
      if (fs.existsSync(file)) throw Error("Output exists");
      const assignment = path.join(path.dirname(file), "assignment.md");
      if (fs.existsSync(assignment)) throw Error("assignment.md exists");
      save(file, {
        project,
        objectiveId: `objective-${crypto.randomUUID().slice(0, 8)}`,
        objective: "REPLACE: concrete user outcome",
        threadId: "REPLACE: originating Codex task UUID",
        worker: { provider: "zcode", model: defaultZcodeModel, effort: "max" },
        notificationRoute: "thread",
        auditPaths: ["src", "test"],
        tasks: [
          {
            id: "implementation",
            promptFile: "assignment.md",
            writePaths: ["src"],
            readPaths: [],
            gateFiles: ["test"],
            checks: [
              {
                name: "acceptance",
                command: "bun",
                args: ["test"],
                cwd: ".",
                timeoutMs: 120000,
              },
            ],
            acceptance: [
              {
                id: "outcome",
                description:
                  "REPLACE: observable result with positive and negative cases",
                checks: ["acceptance"],
              },
            ],
          },
        ],
        finalJudge: "human",
        decisionPolicy: {
          route: "compact",
          effort: "high",
          maxCalls: 2,
          maxPacketBytes: 24000,
        },
        decisionContext:
          "REPLACE: concise architecture, interfaces, invariants and tradeoffs needed for independent strategy decisions",
      });
      fs.writeFileSync(
        assignment,
        "# Assignment\n\nReplace this with context, interfaces, invariants, non-goals and concrete examples.\n",
      );
      print({ plan: file, assignment });
    } else if (command === "run" || command === "validate") {
      const file = path.resolve(requireValue("plan")),
        input = read(file);
      if (options.provider || options.model || options.effort) {
        input.worker = {
          ...(options.provider ? {} : input.worker),
          ...(options.provider ? { provider: options.provider } : {}),
          ...(options.model ? { model: options.model } : {}),
          ...(options.effort ? { effort: options.effort } : {}),
        };
        input.tasks = input.tasks?.map((t: any) => ({
          ...t,
          worker: input.worker,
        }));
      }
      if (options.thread) input.threadId = options.thread;
      if (options["callback-route"]) input.notificationRoute = options["callback-route"];
      if (id && command === "run") throw Error("run does not accept a prior ID; use resume ID --plan PATCH");
      if (id && input.tasks) input.tasks = input.tasks.map((t: any) => ({ ...t, ...(t.promptFile ? { promptFile: path.resolve(path.dirname(file), t.promptFile) } : {}) }));
      if (id && input.taskPatches) for (const changes of Object.values(input.taskPatches) as any[]) if (changes?.promptFile) changes.promptFile = path.resolve(path.dirname(file), changes.promptFile);
      const plan = id ? prepareResume(directory(), input, store.root) : prepare(input, path.dirname(file));
      if (command === "validate") print({ ...await bridge({ op: "validate", plan }), notification: { route: plan.notificationRoute, threadId: plan.threadId } });
      else {
        const dashboard = await ensureServer();
        const result = await launch(plan, store);
        print({ ...result, url: dashboard.url + "runs/" + result.id });
      }
    } else if (command === "decisions") {
      print({
        decisions: compactDecisions(store).slice(0, 12),
        total: store.decisions().length,
      });
    } else if (command === "decision") {
      const dir = directory();
      if (options.recover && options["dry-run"]) throw Error("Choose --recover or --dry-run");
      if (options.recover) print(recoverDecision(store, keyFor(dir)));
      else if (options["dry-run"]) {
        const built = buildDecisionPacket(dir);
        print({
          packet: built.packet,
          bytes: built.bytes,
          policy: built.policy,
          reason: built.reason,
          modelCalls: 0,
        });
      } else {
        const queued = queueDecision(store, keyFor(dir));
        await ensureServer();
        print({
          id: queued.id,
          state: queued.state,
          reason: queued.data.reason ?? null,
          packetBytes: queued.data.packetBytes ?? null,
        });
      }
    } else if (command === "list") {
      const limit = Number(options.limit ?? 12);
      if (!Number.isInteger(limit) || limit < 1 || limit > 50) throw Error("--limit must be an integer from 1 to 50");
      const s = await snapshot(store);
      const project = options.project ? keyFor(options.project) : null;
      const runs = s.runs.filter((r: any) => !project || keyFor(r.project) === project);
      const watches = s.watches.filter((w: any) => !project || keyFor(w.project) === project);
      const runIds = new Set(runs.map((r: any) => r.id));
      const watchIds = new Set(watches.map((w: any) => w.id));
      const notifications = s.notifications.filter((n: any) => !project || runIds.has(n.id.split(":")[1]) || watchIds.has(n.id.split(":")[1]));
      print({
        totalRuns: runs.length,
        runs: runs.slice(0, limit).map((r: any) => ({
          id: r.id,
          runId: r.runId,
          project: r.project,
          status: r.status,
          objective: r.objective,
          tasks: r.tasks?.map((t: any) => ({ id: t.id, status: t.status })),
        })),
        totalWatches: watches.length, watches: watches.slice(0, limit),
        totalNotifications: notifications.length, notifications: notifications.slice(0, limit),
      });
    } else if (command === "import") {
      const dir = path.resolve(requireValue("run-dir"));
      if (!fs.existsSync(path.join(dir, "config.json")))
        throw Error("Missing config.json");
      print({ id: store.register(dir), directory: dir });
    } else if (command === "dashboard") {
      importLegacy(store);
      const dashboard = await ensureServer();
      print({ url: dashboard.url + (id ? "runs/" + keyFor(directory()) : "") });
    } else if (command === "next") {
      print(nextAction(store, keyFor(directory())));
    } else if (command === "status") {
      const watch = store.watch(id);
      if (watch)
        print({
          ...watch,
          notifications: store
            .notifications()
            .filter((n) => n.id.startsWith(`idle:${id}:`))
            .map(({ message, ...n }) => n),
        });
      else {
        const dir = directory();
        if (!fs.existsSync(path.join(dir, "config.json"))) {
          print({
            id: keyFor(dir),
            status: "unavailable",
            directory: dir,
            reason:
              "Saved run files are missing. Import the new location if moved; do not resubmit to replace missing history.",
          });
          return;
        }
        const s = await bridge({ op: "brief", options: { "run-dir": dir } });
        let url = null;
        try {
          url =
            read(path.join(home, "daemon.json")).url + "runs/" + keyFor(dir);
        } catch {}
        print({
          ...s,
          url,
          decision: store.decision(keyFor(dir)),
          notifications: store
            .notifications()
            .filter((n) => n.id === `run:${keyFor(dir)}:terminal`)
            .map(({ message, ...n }) => n),
        });
      }
    } else if (command === "resume" || command === "switch") {
      let patch: any;
      if (command === "resume") {
        const file = path.resolve(requireValue("plan"));
        patch = read(file);
        if (patch.taskPatches) for (const changes of Object.values(patch.taskPatches) as any[]) if (changes?.promptFile) changes.promptFile = path.resolve(path.dirname(file), changes.promptFile);
        if (patch.tasks)
          patch.tasks = patch.tasks.map((t: any) => ({
            ...t,
            ...(t.promptFile ? { promptFile: path.resolve(path.dirname(file), t.promptFile) } : {}),
          }));
      } else
        patch = {
          worker: {
            provider: requireValue("provider"),
            model: options.model,
            effort: options.effort,
          },
        };
      if (options.thread) patch.threadId = options.thread;
      if (options["callback-route"]) patch.notificationRoute = options["callback-route"];
      const previousDirectory = directory();
      if (options["dry-run"]) {
        const plan = prepareResume(previousDirectory, patch, store.root);
        print({ ...await bridge({ op: "validate", plan }), notification: { route: plan.notificationRoute, threadId: plan.threadId }, startsWorker: false });
        return;
      }
      const dashboard = await ensureServer(),
        result = await resume(previousDirectory, patch, store);
      const previousDecision = store.decision(keyFor(previousDirectory));
      if (previousDecision && !result.error && result.status !== "startup_unconfirmed")
        store.updateDecision(previousDecision.id, "superseded", {reason: "Explicit continuation started", continuation: result});
      print({ ...result, url: dashboard.url + "runs/" + result.id });
    } else if (["stop", "judge", "rollback"].includes(command)) {
      const opts: any = { "run-dir": directory() };
      if (command === "judge")
        Object.assign(opts, {
          actor: requireValue("actor"),
          verdict: requireValue("verdict"),
          "report-file": path.resolve(requireValue("report")),
        });
      if (command === "rollback") opts.wave = requireValue("wave");
      const result = await bridge({ op: command, options: opts });
      const decision = store.decision(keyFor(opts["run-dir"]));
      if (decision && ["judge", "rollback"].includes(command))
        store.updateDecision(decision.id, "resolved", {reason: `Explicit ${command} recorded`});
      print(result);
    } else if (command === "watch") {
      const w = attachWatch(store, {
        job: requireValue("job"),
        thread: requireValue("thread"),
        project: requireValue("project"),
        deadline: options.deadline,
        legacyRecord: options["legacy-record"],
        legacyPid: options["legacy-pid"],
        callbackRoute:
          options["callback-route"] ??
          (options["legacy-record"] ? "thread" : "local"),
      });
      const dashboard = await ensureServer();
      print({ ...w, url: dashboard.url });
    } else if (command === "reserve") {
      store.reserve(
        requireValue("project"),
        requireValue("night"),
        requireValue("job"),
      );
      print({ reserved: true });
    } else if (command === "idle-submit") {
      if (!options["dry-run"]) await ensureServer();
      print(
        await submitIdle(store, {
          project: requireValue("project"),
          assignment: requireValue("assignment"),
          title: requireValue("title"),
          thread: requireValue("thread"),
          model: requireValue("model"),
          effort: options.effort,
          night: requireValue("night"),
          deadline: options.deadline,
          dryRun: options["dry-run"],
          callbackRoute: options["callback-route"] ?? "local",
        }),
      );
    } else if (command === "notify-retry") {
      if (!id) throw Error("Notification ID required");
      store.retry(id, options.reconciled === true);
      await ensureServer();
      print({ queued: true });
    } else if (command === "doctor") {
      const dashboard = await ensureServer();
      print({
        bun: Bun.version,
        node,
        zcode,
        zcodeExists: fs.existsSync(zcode),
        home,
        projectRoot,
        dashboard: dashboard.url,
      });
    } else throw Error(`Unknown command ${command}. Use --help.`);
  } finally {
    store.close();
  }
}
if (import.meta.main)
  main().catch((error) => {
    console.error(JSON.stringify({ error: String(error.message ?? error) }));
    process.exitCode = 1;
  });
