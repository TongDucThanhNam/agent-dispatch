import fs from "node:fs";
import path from "node:path";
import { home, projectRoot, node, read, keyFor, save, within } from "./paths";
import { Store } from "./store";
import { decisionPolicy } from "./decision-policy";
export const defaultZcodeModel = "builtin:zai-coding-plan/GLM-5.3-Flash";
export async function bridge(payload: any): Promise<any> {
  const child = Bun.spawn([node, path.join(projectRoot, "src/bridge.mjs")], {
    stdin: new Blob([JSON.stringify(payload)]),
    stdout: "pipe",
    stderr: "pipe",
    windowsHide: true,
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code !== 0)
    throw Error(stderr.trim() || stdout || `Engine exited ${code}`);
  try {
    return JSON.parse(stdout);
  } catch {
    throw Error(`Invalid engine response: ${stdout.slice(0, 1000)}`);
  }
}
export function selection(raw: any, fallback?: any): any {
  if (!raw)
    return (
      fallback ?? {
        workerKind: "zcode",
        model: defaultZcodeModel,
        zcodeEffort: "max",
      }
    );
  const kind =
    raw.provider ?? raw.workerKind ?? fallback?.workerKind ?? "zcode";
  if (!["zcode", "agy"].includes(kind))
    throw Error("Provider must be zcode or agy");
  // Rebuild provider fields: no model/effort/session identity leaks across adapters.
  const same = kind === fallback?.workerKind;
  const savedModel = (worker: any) =>
    kind === "zcode" && worker?.expectedProvider && worker?.expectedModel && !worker.expectedModel.includes("/")
      ? `${worker.expectedProvider}/${worker.expectedModel}`
      : worker?.expectedModel;
  const model =
    raw.model ??
    savedModel(raw) ??
    (same ? (fallback?.model ?? savedModel(fallback)) : undefined);
  const effort =
    raw.effort ??
    raw.zcodeEffort ??
    raw.agyEffort ??
    (same ? (fallback?.zcodeEffort ?? fallback?.agyEffort) : undefined);
  if (kind === "zcode") {
    const m = model ?? defaultZcodeModel;
    const e =
      effort ??
      (m.split("/").at(-1).toLowerCase() === "glm-5.3-flash"
        ? "max"
        : undefined);
    if (e && !["low", "high", "max"].includes(e))
      throw Error("ZCode effort must be low, high or max");
    return {
      workerKind: kind,
      model: m,
      ...(e ? { zcodeEffort: e } : {}),
      ...(raw.expectedProvider
        ? { expectedProvider: raw.expectedProvider }
        : {}),
    };
  }
  if (effort && !["low", "medium", "high"].includes(effort))
    throw Error("AGY effort must be low, medium or high");
  return {
    workerKind: kind,
    ...(model ? { model, agyModel: model } : {}),
    ...(effort ? { agyEffort: effort } : {}),
    ...(raw.agent ? { agyAgent: raw.agent } : {}),
  };
}
export function prepare(input: any, baseDir: string, root = home): any {
  if (input.notificationRoute !== undefined && !["thread", "local"].includes(input.notificationRoute))
    throw Error("Notification route must be thread or local");
  const project = fs.realpathSync(path.resolve(baseDir, input.project ?? "."));
  const objectiveId =
    input.objectiveId ?? `objective-${crypto.randomUUID().slice(0, 8)}`;
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(objectiveId))
    throw Error("Invalid objectiveId");
  const runId = `run-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
  const docsDir = path.join(
    project,
    "artifacts",
    "agent-dispatch",
    objectiveId,
  );
  const worker = selection(
    input.worker ?? {
      provider: input.provider,
      model: input.model,
      effort: input.effort,
    },
  );
  if (!Array.isArray(input.tasks) || !input.tasks.length)
    throw Error("Provide a contract with at least one task");
  const tasks = input.tasks.map((task: any) => ({
    ...task,
    promptFile: path.resolve(baseDir, task.promptFile ?? ""),
    worker: selection(task.worker, worker),
  }));
  const {
    provider: _provider,
    model: _model,
    effort: _effort,
    expectedModel: _expectedModel,
    expectedProvider: _expectedProvider,
    zcodeEffort: _zcodeEffort,
    agyModel: _agyModel,
    agyEffort: _agyEffort,
    resumeSessionId: _resumeSessionId,
    ...rest
  } = input;
  return {
    ...rest,
    project,
    objectiveId,
    runId,
    runDir: path.join(root, "runs", runId),
    runtimeRoot: root,
    storageRoot: root,
    ledgerRoot: path.join(root, "projects", keyFor(project), "objectives"),
    docsDir,
    ...worker,
    workerKind: worker.workerKind,
    worker,
    tasks,
    reviewMode: "contract",
    notify: false,
    managedCallbacks: input.managedCallbacks ?? input.notify !== false,
    notificationRoute: input.notificationRoute ?? "thread",
    decisionPolicy: decisionPolicy(input.decisionPolicy ?? {}),
    decisionContext: input.decisionContext ?? "",
    managedDashboard: true,
    artifactPaths: [
      ...new Set([...(input.artifactPaths ?? []), "artifacts/agent-dispatch"]),
    ],
  };
}
export function documentPlan(plan: any) {
  // Human-facing artifacts contain Markdown only. Engine JSON, receipts and source
  // objects are kept in the private runtime directory, never presented as project copies.
  if (!within(plan.project, plan.docsDir))
    throw Error("Document path escapes project");
  let existing = plan.docsDir;
  while (!fs.existsSync(existing)) existing = path.dirname(existing);
  if (!within(fs.realpathSync(plan.project), fs.realpathSync(existing)))
    throw Error("Document path escapes through a filesystem link");
  fs.mkdirSync(plan.docsDir, { recursive: true });
  for (const task of plan.tasks) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(task.id))
      throw Error("Invalid task ID");
    // Preserve prior assignment revisions instead of overwriting their evidence.
    const version = path.join(plan.docsDir, `${task.id}-${plan.runId}.md`);
    fs.copyFileSync(task.promptFile, version);
    task.promptFile = version;
  }
  fs.writeFileSync(
    path.join(plan.docsDir, `contract-${plan.runId}.md`),
    `# ${plan.objective}\n\nObjective: ${plan.objectiveId}\n\n` +
      plan.tasks
        .map(
          (t: any) =>
            `## ${t.id}\n\nWorker: ${t.worker.workerKind}; model: ${t.worker.model ?? t.worker.expectedModel ?? "current selection"}; effort: ${t.worker.zcodeEffort ?? t.worker.agyEffort ?? "current selection"}\n\nWrites: ${t.writePaths.join(", ")}\n\n` +
            t.acceptance
              .map((a: any) => `- ${a.description} → ${a.checks.join(", ")}`)
              .join("\n"),
        )
        .join("\n\n"),
  );
}
export async function launch(plan: any, store: Store) {
  if (
    plan.managedCallbacks &&
    !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(plan.threadId ?? "")
  )
    throw Error("Originating Codex task UUID is required for callbacks");
  if (
    store
      .watches()
      .some((w) => !w.done && keyFor(w.project) === keyFor(plan.project))
  )
    throw Error(
      "An IDLE job still owns this project; reconcile it before launching another writer",
    );
  await bridge({ op: "validate", plan });
  documentPlan(plan);
  const result = await bridge({ op: "launch", plan });
  if (fs.existsSync(path.join(plan.runDir, "config.json")))
    store.register(plan.runDir);
  return {
    ...result,
    runId: plan.runId,
    id: keyFor(plan.runDir),
    artifacts: plan.docsDir,
    notification: { route: plan.managedCallbacks ? plan.notificationRoute : "disabled", threadId: plan.threadId, when: "One terminal result needing attention; no polling or intermediate strategy wakeups" },
  };
}
export function prepareResume(directory: string, patch: any, root = home) {
  const prior = read(path.join(directory, "config.json")),
    s = read(path.join(directory, "status.json"));
  if (prior.reviewMode !== "contract")
    throw Error(
      "Legacy non-contract execution must finish with its saved protocol. Import is read-only.",
    );
  if (s.loopActive || !s.workerExited || s.ownershipUncertain)
    throw Error(
      "The prior worker must stop with confirmed ownership before resume or provider switch",
    );
  const allowed = [
    "tasks",
    "taskPatches",
    "worker",
    "strategyChange",
    "blockerResolved",
    "contextFiles",
    "protectedPaths",
    "auditPaths",
    "artifactPaths",
    "finalChecks",
    "finalGateFiles",
    "finalJudge",
    "judgmentCriteria",
    "maxParallel",
    "maxObjectiveCorrections",
    "decisionPolicy",
    "decisionContext",
    "threadId",
    "notificationRoute",
  ];
  patch = { ...patch };
  for (const k of ["project", "objectiveId", "objective"]) {
    if (!(k in patch)) continue;
    const same = k === "project" ? keyFor(path.resolve(patch[k])) === keyFor(prior[k]) : patch[k] === prior[k];
    if (!same) throw Error(`Continuation cannot change ${k}; use a patch of changed tasks and strategyChange. Preview with resume ID --plan PATCH --dry-run.`);
    delete patch[k];
  }
  const unsupported = Object.keys(patch).filter(k => !allowed.includes(k));
  if (unsupported.length) throw Error(`Unsupported continuation fields: ${unsupported.join(", ")}. Pass only changes; preview with resume ID --plan PATCH --dry-run.`);
  if (patch.taskPatches !== undefined) {
    if (patch.tasks || !patch.taskPatches || typeof patch.taskPatches !== "object" || Array.isArray(patch.taskPatches))
      throw Error("Use either tasks or an object of taskPatches keyed by existing task ID");
    for (const [id, changes] of Object.entries(patch.taskPatches)) {
      if (!prior.tasks.some((t: any) => t.id === id) || !changes || typeof changes !== "object" || Array.isArray(changes) || ("id" in changes && changes.id !== id))
        throw Error(`Invalid task patch ${id}; patches cannot invent or rename tasks`);
      const fields = ["id", "promptFile", "dependsOn", "writePaths", "readPaths", "gateFiles", "checks", "acceptance", "strategyNotes", "artifacts", "maxAttempts", "exclusive", "integration", "worker", "onBlocked"];
      const unknown = Object.keys(changes).filter(k => !fields.includes(k));
      if (unknown.length) throw Error(`Unsupported task patch fields for ${id}: ${unknown.join(", ")}`);
    }
    patch.tasks = prior.tasks.map((task: any) => {
      const changes = patch.taskPatches[task.id];
      return changes ? { ...task, ...changes, worker: changes.worker ? selection(changes.worker, task.worker) : task.worker } : task;
    });
    delete patch.taskPatches;
  }
  const worker = patch.worker
    ? selection(patch.worker, prior.worker ?? prior.tasks[0].worker)
    : null;
  const tasks = (patch.tasks ?? prior.tasks).map((t: any) => ({
    ...t,
    worker: worker ?? selection(t.worker),
  }));
  const next = prepare(
    {
      ...prior,
      ...patch,
      notificationRoute: patch.notificationRoute ?? prior.notificationRoute ?? (prior.decisionPolicy?.route && prior.decisionPolicy.route !== "thread" ? "local" : "thread"),
      tasks,
      worker: worker ?? prior.worker ?? prior.tasks[0].worker,
    },
    directory,
    root,
  );
  // Resume the exact existing objective ledger. No budget resets through migration.
  next.ledgerRoot =
    prior.ledgerRoot ??
    path.join(prior.project, ".zcode-dispatch", "contract-objectives");
  next.resumeFrom = directory;
  next.strategyChange = patch.strategyChange ?? null;
  next.blockerResolved = patch.blockerResolved ?? null;
  return next;
}
export async function resume(directory: string, patch: any, store: Store) {
  return launch(prepareResume(directory, patch, store.root), store);
}
