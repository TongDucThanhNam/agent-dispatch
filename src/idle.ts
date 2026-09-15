import fs from "node:fs";
import path from "node:path";
import { Store } from "./store";
import { execute, type ProcessResult } from "./process";
import { node, zcode, save, keyFor } from "./paths";
import { attachWatch } from "./watches";
export function idleArgs(raw: any) {
  if (!raw.model)
    throw Error(
      "IDLE requires an explicit model; native defaults are not substituted",
    );
  if (raw.effort && !["low", "high", "max"].includes(raw.effort))
    throw Error("Invalid IDLE effort");
  return [
    node,
    zcode,
    "idle",
    "submit",
    "--title",
    raw.title,
    "--file",
    raw.assignment,
    "--workspace",
    raw.project,
    "--model",
    raw.model,
    "--mode",
    "yolo",
    ...(raw.effort ? ["--thought", raw.effort] : []),
  ];
}
export async function submitIdle(
  store: Store,
  raw: any,
  runner: (argv: string[]) => Promise<ProcessResult> = (argv) =>
    execute(argv, { timeoutMs: 45000 }),
) {
  const callbackRoute = raw.callbackRoute ?? "local";
  if (!["local", "thread"].includes(callbackRoute))
    throw Error("IDLE callback route must be local or thread");
  const project = fs.realpathSync(path.resolve(raw.project)),
    assignment = fs.realpathSync(path.resolve(raw.assignment));
  if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(raw.thread))
    throw Error("Originating Codex task UUID is required");
  if (
    !raw.title?.trim() ||
    raw.title.length > 200 ||
    fs.statSync(assignment).size > 32000
  )
    throw Error("Use a title under 200 characters and assignment under 32 KB");
  const args = idleArgs({ ...raw, project, assignment });
  if (raw.dryRun)
    return {
      dryRun: true,
      args,
      project,
      thread: raw.thread,
      night: raw.night,
      callbackRoute,
    };
  if (
    fs.existsSync(path.join(project, ".zcode-dispatch", "active-run.lock")) ||
    store
      .watches()
      .some((w) => !w.done && keyFor(w.project) === keyFor(project))
  )
    throw Error("Another workflow owns this project");
  const intent = `idle-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`,
    file = path.join(store.root, "idle-submissions", intent + ".json");
  store.reserve(project, raw.night, intent);
  save(file, {
    intent,
    status: "submitting",
    project,
    assignment,
    thread: raw.thread,
    model: raw.model,
    effort: raw.effort ?? null,
    night: raw.night,
    createdAt: Date.now(),
  });
  let result;
  try {
    result = await runner(args);
  } catch (e) {
    result = {
      ok: false,
      exitCode: null,
      stdout: "",
      stderr: String(e),
      uncertain: true,
    };
  }
  save(file, {
    intent,
    status: result.ok ? "response_received" : "submission_unconfirmed",
    project,
    assignment,
    thread: raw.thread,
    night: raw.night,
    result,
  });
  if (!result.ok)
    throw Error(
      `IDLE submission did not confirm acceptance. Reservation retained. Reconcile ${file}; do not resubmit.`,
    );
  let receipt;
  try {
    receipt = JSON.parse(result.stdout);
  } catch {
    throw Error(
      `Malformed submission response. Reconcile ${file}; reservation retained.`,
    );
  }
  if (typeof receipt.id !== "string")
    throw Error(
      `Missing accepted job ID. Reconcile ${file}; reservation retained.`,
    );
  const watch = attachWatch(store, {
    job: receipt.id,
    thread: raw.thread,
    project,
    deadline: raw.deadline,
    callbackRoute,
  });
  save(file, {
    intent,
    status: "watch_registered",
    project,
    thread: raw.thread,
    night: raw.night,
    receipt,
    watchId: watch.id,
  });
  return {
    intent,
    job: receipt.id,
    status: receipt.state,
    watchRegistered: true,
    record: file,
    callbackRoute,
  };
}
