import path from "node:path";
import { Store } from "./store";
import { read, keyFor } from "./paths";
import { runState } from "../engine/delegate-to-zcode/scripts/run-summary.mjs";
import { dispatcherDiagnosis } from "./diagnostics";

// One bounded read for an orchestrator. Never starts the daemon, a worker or a model.
export function nextAction(store: Store, requestedId: string) {
  let id = requestedId;
  const visited = new Set<string>();
  let identity: string | undefined;
  for (let depth = 0; depth < 12; depth++) {
    if (visited.has(id)) throw Error("Continuation cycle; reconcile saved history");
    visited.add(id);
    const run = store.run(id);
    if (!run) throw Error("Unknown run; import its saved directory first");
    const config = read(path.join(run.directory, "config.json"));
    const state = read(path.join(run.directory, "status.json"));
    const currentIdentity = `${keyFor(config.project)}:${config.objectiveId}`;
    if (identity && identity !== currentIdentity) throw Error("Continuation changed objective identity");
    identity = currentIdentity;
    const decision = store.decision(id);
    const nextId = decision?.data.continuation?.id;
    if (nextId && ["applied", "superseded"].includes(decision.state)) { id = nextId; continue; }
    const live = runState(config, state, {});
    const tasks: any[] = Object.values(state.tasks ?? {});
    const diagnosis = dispatcherDiagnosis(state);
    let action = "inspect_blocker", reason = state.error?.message ?? "Inspect the assigned report and missing evidence.";
    if (state.ownershipUncertain || live.status === "unconfirmed" || decision?.state === "unconfirmed") {
      action = "reconcile"; reason = "Execution ownership or delivery is uncertain; reconcile the existing operation before retrying.";
    } else if (live.active) {
      action = "wait"; reason = "The worker owns implementation/test/fix. Wait for the terminal callback; do not poll with Astra.";
    } else if (["queued", "running", "applying"].includes(decision?.state)) {
      action = "wait"; reason = "Compact strategy is pending; it will continue work or report the required decision.";
    } else if (state.status === "complete") {
      action = "complete"; reason = "Final judgment was recorded.";
    } else if (state.blocker || ["blocked", "cancelled"].includes(state.status)) {
      action = "reconcile"; reason = state.error?.message ?? "Resolve the recorded operational blocker before continuing.";
    } else if (state.status === "awaiting_judgment") {
      action = "judge"; reason = "Independent final checks passed; the assigned final judgment remains.";
    } else if (diagnosis) {
      action = "diagnose"; reason = diagnosis;
    } else if (decision?.state === "needs_user") {
      action = "human_decision"; reason = decision.data.reason;
    } else if (tasks.some(t => t.blockedDecision?.route === "human")) {
      action = "human_decision"; reason = tasks.find(t => t.blockedDecision?.route === "human").blockedDecision.reason;
    }
    const notification = store.notifications().find(n => n.id === `run:${id}:terminal`);
    let url: string | null = null;
    try { url = read(path.join(store.root, "daemon.json")).url + "runs/" + id; } catch {}
    const attention = tasks.filter(t => !["accepted", "pending"].includes(t.status));
    return {
      id, ...(id !== requestedId ? { requestedId } : {}), status: config.reviewMode === "contract" && !state.loopActive ? state.status : live.status,
      next: { action, reason: String(reason ?? "Human decision required").slice(0, 1000) },
      ...(diagnosis ? {diagnostics: {kind: state.error.kind, file: path.join(run.directory, "status.json"),
        guidance: "Diagnose and repair routine dispatcher setup within existing authorization, then validate the continuation without launching it. Preserve product scope, gates, ownership and budgets; do not request permission merely to inspect this error."}} : {}),
      progress: { accepted: tasks.filter(t => t.status === "accepted").length, total: tasks.length,
        attempts: tasks.reduce((n, t) => n + (t.attempts?.length ?? 0), 0), corrections: state.corrections ?? 0, limit: state.limit ?? null },
      attention: attention.slice(0, 4).map(t => ({ taskId: t.id, status: t.status,
        partialEvidence: t.attempts?.at(-1)?.partialEvidence === true,
        coverage: (t.attempts?.at(-1)?.acceptanceCoverage ?? []).slice(0, 20),
        receipt: t.attempts?.at(-1)?.gateReceipt ?? null })),
      ...(attention.length > 4 ? { moreAttentionTasks: attention.length - 4 } : {}),
      reportFile: decision?.data.reportFile ?? attention[0]?.attempts?.at(-1)?.workerReportPath ?? null,
      notification: { route: config.managedCallbacks === false ? "disabled" : config.notificationRoute ?? (config.decisionPolicy?.route && config.decisionPolicy.route !== "thread" ? "local" : "thread"),
        threadId: config.threadId ?? null, state: notification?.state ?? "not_recorded", attempts: notification?.attempts ?? 0 },
      url,
    };
  }
  throw Error("Continuation chain exceeds the bounded lookup; inspect the latest saved run");
}
