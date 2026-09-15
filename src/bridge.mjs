// Retain the tested Node worker adapters and node:sqlite telemetry while Bun owns
// the public CLI, server, watch scheduler and persistent catalog.
import fs from "node:fs";
import path from "node:path";
import { validatePlan } from "../engine/delegate-to-zcode/scripts/contract-plan.mjs";
import {
  launchPlan,
  manage,
  preflightPlan,
} from "../engine/delegate-to-zcode/scripts/contract-workflow.mjs";
import { readRun } from "../engine/delegate-to-zcode/scripts/dashboard.mjs";
import { compactStatus } from "../engine/delegate-to-zcode/scripts/run.mjs";
const raw = JSON.parse(fs.readFileSync(0, "utf8"));
try {
  let result;
  if (raw.op === "validate") {
    if (
      raw.plan.managedCallbacks &&
      !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(
        raw.plan.threadId ?? "",
      )
    )
      throw Error("Originating Codex task UUID is required for callbacks");
    const p = validatePlan(raw.plan);
    const sourceAudit = preflightPlan(p);
    result = {
      valid: true,
      sourceAudit,
      objective: p.objective,
      tasks: p.tasks.map((t) => ({
        id: t.id,
        worker: t.worker.workerKind,
        model: t.worker.expectedModel,
        modelId: t.worker.workerKind === 'zcode' ? `${t.worker.expectedProvider}/${t.worker.expectedModel}` : t.worker.expectedModel,
        effort: t.worker.zcodeEffort ?? t.worker.agyEffort,
        dependsOn: t.dependsOn,
      })),
      maxParallel: p.maxParallel,
    };
  } else if (raw.op === "launch") result = await launchPlan(raw.plan);
  else if (raw.op === "catalog")
    result = raw.entries.map((entry) => {
      try {
        const root = readRun(
          { key: entry.id, runDir: entry.directory },
          { telemetry: false },
        );
        const state = JSON.parse(
          fs.readFileSync(path.join(entry.directory, "status.json"), "utf8"),
        );
        const tasks = Object.values(state.tasks ?? {}).map((t) => {
          const attempt = t.attempts?.at(-1);
          let child = null;
          if (attempt?.runDir)
            try {
              child = readRun({
                key: entry.id + ":" + t.id,
                runDir: attempt.runDir,
              });
            } catch {}
          return {
            id: t.id,
            status: t.status,
            attempts: t.attempts?.length ?? 0,
            partialEvidence: attempt?.partialEvidence === true,
            acceptanceCoverage: attempt?.acceptanceCoverage ?? [],
            blockedDecision: t.blockedDecision ?? null,
            requestedModel: attempt?.requestedModel,
            requestedEffort: attempt?.requestedEffort,
            workerKind: attempt?.workerKind,
            child: child
              ? {
                  status: child.status,
                  model: child.model,
                  lastActivityAt: child.lastActivityAt,
                  todos: child.todos,
                  usage: child.usage,
                  events: child.trajectory?.events?.slice(-30) ?? [],
                  report: child.report,
                  sessionId: child.sessionId,
                }
              : null,
          };
        });
        const { controlUrl, contentSource, ...publicRoot } = root;
        const config = JSON.parse(fs.readFileSync(path.join(entry.directory, "config.json"), "utf8"));
        const docsDir = config.docsDir ?? entry.directory;
        const documents = fs.existsSync(docsDir)
          ? fs
              .readdirSync(docsDir)
              .filter(
                (n) =>
                  /^[A-Za-z0-9._-]+\.md$/i.test(n) &&
                  fs.statSync(path.join(docsDir, n)).isFile(),
              )
              .map((name) => ({ name }))
          : [];
        return {
          ...publicRoot,
          id: entry.id,
          objective: state.objective,
          dispatcherError: state.error ? {kind: state.error.kind, message: String(state.error.message).slice(0, 1200),
            beforeWorker: Object.values(state.tasks ?? {}).every(t => !t.attempts?.length)} : null,
          events: state.events ?? [],
          tasks,
          directory: entry.directory,
          docsDir,
          finalJudge: config.finalJudge ?? null,
          judgmentCriteria: config.judgmentCriteria ?? [],
          documents,
        };
      } catch (error) {
        return {
          id: entry.id,
          runId: path.basename(entry.directory),
          project: entry.directory.split(/[\\/]\.zcode-dispatch[\\/]/)[0],
          directory: entry.directory,
          status: "unavailable",
          alert:
            "Saved run files are unavailable. The project may have moved or its dispatch directory was removed. " +
            error.message,
        };
      }
    });
  else if (
    raw.op === "brief" &&
    JSON.parse(
      fs.readFileSync(path.join(raw.options["run-dir"], "config.json"), "utf8"),
    ).reviewMode !== "contract"
  )
    result = compactStatus(raw.options["run-dir"]);
  else result = await manage(raw.op, raw.options);
  console.log(JSON.stringify(result));
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
