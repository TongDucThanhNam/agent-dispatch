import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { Store } from "./store";
import { read, save, within, keyFor, alive } from "./paths";
import { decisionPolicy } from "./decision-policy";
import { invokeDecision } from "./decision-codex";
import { resume, bridge } from "./workflow";
import { dispatcherDiagnosis } from "./diagnostics";

const hash = (v: unknown) =>
  createHash("sha256").update(JSON.stringify(v)).digest("hex");
const ledgerFile = (c: any) =>
  path.join(
    c.ledgerRoot ?? path.join(c.project, ".zcode-dispatch/contract-objectives"),
    c.objectiveId,
    "state.json",
  );
function load(directory: string) {
  const config = read(path.join(directory, "config.json")),
    state = read(path.join(directory, "status.json"));
  if (
    config.reviewMode !== "contract" ||
    path.resolve(config.runDir) !== path.resolve(directory) ||
    config.runId !== state.runId
  )
    throw Error("Decision requires an identified contract run");
  return { config, state, sourceHash: hash({ config, state }) };
}
function retryTargets(config: any, state: any) {
  return config.tasks.filter((t: any) => {
    const record = state.tasks[t.id], attempts = record?.attempts?.length ?? 0;
    return record?.status !== "accepted" && t.onBlocked !== "human" && record?.blockedDecision?.route !== "human" && attempts > 0 && attempts < t.maxAttempts &&
      (t.dependsOn ?? []).every((id: string) => state.tasks[id]?.status === "accepted" || (t.integration && state.tasks[id]?.status === "regressed"));
  });
}
function eligibility(config: any, state: any) {
  if (
    state.loopActive ||
    !state.workerExited ||
    state.ownershipUncertain ||
    alive(state.runnerPid)
  )
    return "Worker/runner ownership is not confirmed stopped";
  if (state.blocker || ["blocked", "cancelled"].includes(state.status))
    return "Operational blocker needs explicit reconciliation; no automatic model call";
  if (state.status === "awaiting_judgment") {
    if (config.finalJudge !== "astra")
      return "Ready for human judgment; no Astra wakeup";
    if (!state.finalValidation?.passed)
      return "Independent final validation is missing";
    return null;
  }
  if (state.status !== "needs_replan") return "No strategic decision required";
  const diagnosis = dispatcherDiagnosis(state);
  if (diagnosis) return diagnosis;
  if (state.corrections >= state.limit)
    return "Worker correction allowance exhausted; a model cannot extend it";
  if (!retryTargets(config, state).length) {
    const human = config.tasks.filter((t: any) => state.tasks[t.id]?.status !== "accepted" && (t.onBlocked === "human" || state.tasks[t.id]?.blockedDecision?.route === "human"));
    if (human.length) return `Human decision required: ${human.map((t: any) => `${t.id}: ${state.tasks[t.id]?.blockedDecision?.reason ?? state.error?.message ?? "caller-selected human disposition"}`).join("; ").slice(0, 1800)}`;
    return "No failed, dependency-ready task has attempts remaining";
  }
  return null;
}
function evidenceFile(config: any, file: string, limit = 4500) {
  if (!file) return null;
  try {
    const resolved = fs.realpathSync(file),
      root = fs.realpathSync(config.runtimeRoot ?? path.dirname(config.runDir));
    if (!within(root, resolved))
      return {
        unavailable: true,
        reason: "Evidence outside the run storage boundary",
      };
    const size = fs.statSync(resolved).size,
      fd = fs.openSync(resolved, "r"),
      buffer = Buffer.alloc(Math.min(size, limit));
    try {
      fs.readSync(fd, buffer, 0, buffer.length, 0);
    } finally {
      fs.closeSync(fd);
    }
    return { text: buffer.toString("utf8"), truncated: size > limit };
  } catch {
    return { unavailable: true };
  }
}
export function buildDecisionPacket(directory: string) {
  const { config, state, sourceHash } = load(directory),
    policy = decisionPolicy(config.decisionPolicy ?? {});
  const final = state.status === "awaiting_judgment";
  const targets = final ? config.tasks : retryTargets(config, state);
  const eligible = targets
    .filter(
      (t: any) => !final && state.tasks[t.id]?.attempts.length < t.maxAttempts,
    )
    .map((t: any) => t.id);
  const content = {
    version: 1,
    sourceHash,
    authority: {
      objective: config.objective,
      objectiveId: config.objectiveId,
      context: config.decisionContext ?? "",
      finalJudge: config.finalJudge,
      judgmentCriteria: config.judgmentCriteria,
      contextReferences: config.contextFiles,
      protectedPaths: config.protectedPaths,
      tasks: targets.map((t: any) => ({
        id: t.id,
        onBlocked: t.onBlocked ?? "strategy",
        assignment: t.assignment,
        strategyNotes: t.strategyNotes ?? null,
        acceptance: t.acceptance,
        checks: t.checks,
        writePaths: t.writePaths,
        readPaths: t.readPaths,
        gateFiles: t.gateFiles,
        dependsOn: t.dependsOn,
        worker: {
          provider: t.worker.workerKind,
          model: t.worker.expectedModel,
          effort: t.worker.zcodeEffort ?? t.worker.agyEffort,
        },
      })),
      otherTasks: config.tasks
        .filter((t: any) => !targets.includes(t))
        .map((t: any) => ({
          id: t.id,
          writePaths: t.writePaths,
          status: state.tasks[t.id].status,
        })),
      remainingCorrections: Math.max(0, state.limit - state.corrections),
      attemptsRemaining: Object.fromEntries(
        targets.map((t: any) => [
          t.id,
          Math.max(0, t.maxAttempts - state.tasks[t.id].attempts.length),
        ]),
      ),
      eligibleRetryTasks: eligible,
      allowedActions: final
        ? ["accept", "changes_required", "needs_user"]
        : ["retry", "needs_user"],
      restrictions:
        "No code, tools, provider changes, new permissions, changed gates/criteria/scopes, increased budgets or operational-blocker bypass. Do not infer missing evidence. Context references are not their contents.",
    },
    evidence: {
      status: state.status,
      error: state.error,
      finalValidation: state.finalValidation
        ? {
            passed: state.finalValidation.passed,
            fingerprint: state.finalValidation.fingerprint,
          }
        : null,
      tasks: targets.map((t: any) => {
        const record = state.tasks[t.id],
          attempt = record.attempts.at(-1);
        return {
          id: t.id,
          status: record.status,
          attempts: record.attempts.length,
          lastReport: evidenceFile(config, attempt?.workerReportPath),
          lastGate: evidenceFile(config, attempt?.gateReceipt),
          observedModel: attempt?.observedModel ?? null,
        };
      }),
      finalReceipts: final
        ? (state.finalValidation?.receipts ?? []).map((file: string) =>
            evidenceFile(config, file, 2500),
          )
        : [],
    },
  };
  const packet = { packetHash: hash(content), ...content },
    prompt = JSON.stringify(packet);
  const bytes = Buffer.byteLength(prompt);
  if (bytes > policy.maxPacketBytes)
    throw Error(
      `Decision packet is ${bytes} bytes; limit ${policy.maxPacketBytes}. Supply a narrower decision context; requirements were not truncated.`,
    );
  return {
    packet,
    prompt,
    bytes,
    policy,
    sourceHash,
    config,
    state,
    reason: eligibility(config, state),
  };
}

export function queueDecision(store: Store, runId: string) {
  const existing = store.decision(runId);
  if (existing) return existing;
  const run = store.run(runId);
  if (!run) throw Error("Unknown run");
  const { config, state } = load(run.directory);
  const id = `decision-${runId}`,
    directory = path.join(store.root, "decisions", id);
  const policy = decisionPolicy(config.decisionPolicy ?? {});
  let data: any = {
    directory,
    runDirectory: run.directory,
    objective: config.objective,
    project: config.project,
    policy,
  };
  let status = "queued";
  const reason = eligibility(config, state);
  if (reason || policy.route === "local") {
    status = reason && reason === dispatcherDiagnosis(state) ? "needs_diagnosis" : "needs_user";
    data.reason = reason ?? "Local-only decision policy";
  } else {
    try {
      const built = buildDecisionPacket(run.directory);
      save(path.join(directory, "packet.json"), built.packet);
      data = {
        ...data,
        packetPath: path.join(directory, "packet.json"),
        sourceHash: built.sourceHash,
        packetHash: built.packet.packetHash,
        packetBytes: built.bytes,
      };
    } catch (e) {
      status = "needs_user";
      data.reason = String(e);
    }
  }
  store.addDecision(
    id,
    runId,
    `${keyFor(config.project)}:${config.objectiveId}`,
    status,
    data,
  );
  return store.decision(id);
}

export function validateDecision(result: any, packet: any) {
  if (
    !result ||
    typeof result !== "object" ||
    Array.isArray(result) ||
    Object.keys(result).sort().join() !==
      ["packetHash", "action", "taskId", "reason", "guidance"].sort().join()
  )
    throw Error("Unexpected decision response fields");
  if (
    result.packetHash !== packet.packetHash ||
    !packet.authority.allowedActions.includes(result.action)
  )
    throw Error("Stale packet or unauthorized decision action");
  if (
    typeof result.reason !== "string" ||
    !result.reason.trim() ||
    result.reason.length > 1800 ||
    typeof result.guidance !== "string" ||
    result.guidance.length > 3000
  )
    throw Error("Invalid decision explanation/guidance");
  if (result.action === "retry") {
    if (
      !packet.authority.eligibleRetryTasks.includes(result.taskId) ||
      !result.guidance.trim()
    )
      throw Error("Retry must identify an eligible task and bounded strategy");
  } else if (result.action === "needs_user") {
    const known = [...packet.authority.tasks, ...(packet.authority.otherTasks ?? [])];
    if (result.taskId !== null && !known.some((t: any) => t.id === result.taskId))
      throw Error("Human decision references an unknown task");
  } else if (result.taskId !== null)
    throw Error("This decision cannot assign a task");
  return result;
}

// Recover an already-paid informational answer. Never re-invoke Astra or apply
// a retry/judgment from disk; state and objective identity must still match.
export function recoverDecision(store: Store, runId: string) {
  const row = store.decision(runId);
  if (!row || row.state !== "needs_user" || !row.started)
    throw Error("Only a stopped needs_user decision with a saved invocation can be recovered");
  const { config, sourceHash } = load(row.data.runDirectory);
  if (sourceHash !== row.data.sourceHash ||
      path.resolve(read(ledgerFile(config)).runDir) !== path.resolve(row.data.runDirectory))
    throw Error("Saved decision is stale or superseded");
  const packet = read(row.data.packetPath);
  const { packetHash, ...content } = packet;
  if (packetHash !== row.data.packetHash || hash(content) !== packetHash)
    throw Error("Saved decision packet identity changed");
  const decision = validateDecision(read(path.join(row.data.directory, "response.json")), packet);
  if (decision.action !== "needs_user")
    throw Error("Recovery only restores human guidance; it cannot execute an action");
  const reportFile = path.join(row.data.directory, "decision.md");
  fs.writeFileSync(reportFile, `# Astra decision\n\nAction: needs_user\n\n${decision.reason}\n\n${decision.guidance}\n`);
  store.updateDecision(row.id, "needs_user", {
    result: decision, reason: decision.reason, reportFile, recoveredAt: Date.now(),
  });
  return { id: row.id, state: "needs_user", reason: decision.reason, reportFile, modelCalls: 0 };
}

export async function tickDecisions(
  store: Store,
  deps: {
    invoke?: typeof invokeDecision;
    continueRun?: typeof resume;
    judge?: typeof bridge;
  } = {},
) {
  const row = store.decisions("queued")[0];
  if (!row) return;
  // Re-check before reserving a paid call. Pending work can become obsolete.
  let built;
  try {
    built = buildDecisionPacket(row.data.runDirectory);
    if (built.reason || built.sourceHash !== row.data.sourceHash)
      throw Error(built.reason ?? "Run changed before decision");
    const ledger = read(ledgerFile(built.config));
    if (path.resolve(ledger.runDir) !== path.resolve(row.data.runDirectory))
      throw Error("A newer objective run superseded this decision");
  } catch (e) {
    store.updateDecision(row.id, "needs_user", { reason: String(e) });
    return;
  }
  if (!store.claimDecision(row.id)) return;
  try {
    const result = await (deps.invoke ?? invokeDecision)(
      row.data.directory,
      built.prompt,
      row.data.policy,
    );
    store.updateDecision(row.id, "running", {
      usage: result.usage,
      transportError: result.error,
    });
    if (!result.ok) {
      store.updateDecision(
        row.id,
        result.uncertain ? "unconfirmed" : "needs_user",
        { reason: result.error ?? "Decision failed; no automatic retry" },
      );
      return;
    }
    const decision = validateDecision(result.response, built.packet);
    if (load(row.data.runDirectory).sourceHash !== row.data.sourceHash)
      throw Error("Run changed while Astra was deciding");
    if (
      path.resolve(read(ledgerFile(built.config)).runDir) !==
      path.resolve(row.data.runDirectory)
    )
      throw Error("A newer run superseded the decision");
    const reportFile = path.join(row.data.directory, "decision.md");
    fs.writeFileSync(
      reportFile,
      `# Astra decision\n\nAction: ${decision.action}\n\n${decision.reason}\n\n${decision.guidance}\n`,
    );
    store.updateDecision(row.id, "applying", { result: decision, reportFile });
    if (decision.action === "retry") {
      const patch = {
        tasks: built.config.tasks.map((t: any) =>
          t.id === decision.taskId
            ? { ...t, strategyNotes: decision.guidance }
            : t,
        ),
        strategyChange: `Bounded Astra strategy: ${decision.reason}`,
      };
      const continued = await (deps.continueRun ?? resume)(
        row.data.runDirectory,
        patch,
        store,
      );
      // A returned startup uncertainty may still own a worker. Never repeat it.
      store.updateDecision(
        row.id,
        continued.error || continued.status === "startup_unconfirmed"
          ? "unconfirmed"
          : "applied",
        { continuation: continued, reason: decision.reason },
      );
    } else if (
      decision.action === "accept" ||
      decision.action === "changes_required"
    ) {
      const judgment = await (deps.judge ?? bridge)({
        op: "judge",
        options: {
          "run-dir": row.data.runDirectory,
          actor: "astra",
          verdict:
            decision.action === "accept" ? "accepted" : "changes_required",
          "report-file": reportFile,
        },
      });
      store.updateDecision(row.id, "applied", {
        judgment,
        reason: decision.reason,
      });
    } else
      store.updateDecision(row.id, "needs_user", { reason: decision.reason });
  } catch (e) {
    const current = store.decision(row.id);
    store.updateDecision(
      row.id,
      current.state === "applying" ? "unconfirmed" : "needs_user",
      { reason: String(e) },
    );
  }
}

export function compactDecisions(store: Store) {
  return store
    .decisions()
    .map(({ id, run_id, state, updated, started, data }) => ({
      id,
      runId: run_id,
      state,
      updated,
      started,
      objective: data.objective,
      reason: data.reason?.slice(0, 600) ?? null,
      guidance: data.result?.action === "needs_user" ? data.result.guidance?.slice(0, 3000) ?? null : null,
      packetBytes: data.packetBytes ?? null,
      usage: data.usage ?? null,
      result: data.result
        ? { action: data.result.action, taskId: data.result.taskId }
        : null,
      continuationId: data.continuation?.id ?? null,
      reportFile: data.reportFile ?? null,
    }));
}
