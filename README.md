# Agent Dispatch

A local CLI and React dashboard for Astra-defined contracts executed by ZCode or AGY. Workers implement directly in the assigned checkout and own the generate/test/fix loop. The dispatcher runs the assigned acceptance commands; Astra handles strategy changes and optional final product judgment, with no routine component reviewer.

## Install and run

Requires Windows, Bun 1.4.0+, Node 26+, and the selected worker's installed CLI/login.

```powershell
bun install --frozen-lockfile
bun run build
bun link
agent-dispatch --help
agent-dispatch dashboard
```

The local daemon uses `Bun.serve`, `Bun.file`, `Bun.spawn` and `bun:sqlite`. Its saved port and token survive restarts. `dashboard` checks health and restarts an offline daemon at the same address. It refuses to silently change ports if another application occupies the saved one. The daemon must be running for URLs and callbacks; this version does not install a Windows startup service.

The tested Node worker adapters live in `engine/`. They retain Node's SQLite telemetry and native process supervision while Bun owns the public CLI, catalog, GUI and durable callback scheduler. The project runs independently of the installed skill directories.

## Dashboard development

The dashboard uses [shadcn/ui](https://ui.shadcn.com/docs) components in `src/web/components/ui`, with Tailwind CSS 4 theme tokens in `src/web/style.css`. `components.json` configures the shadcn CLI; add components with `bunx shadcn@latest add <component>`. Shared classes use `cn()` and the `@/` alias resolves to `src/web`.

`bun run build` uses `Bun.build` with `bun-plugin-tailwind`. Rebuild after frontend edits and restart the daemon to load the new dashboard HTML. The server caches the HTML at startup and prepares JSON bodies and native `Bun.CryptoHasher` validators once per five-second data refresh. Unchanged polls return an empty 304 response; changed data or catalog errors invalidate the validator. Judgment reports are written asynchronously with `Bun.write` before the worker bridge reads them. Atomic state writes and Windows daemon detachment retain their existing filesystem and Node contracts.

Run `bun scripts/benchmark-http-cache.ts` to compare response preparation for synthetic unchanged polls. It reports median timings for five batches of 1,000 requests; it excludes network, catalog refresh and worker execution time.

## Contract workflow

```powershell
agent-dispatch init --project C:/repo --out C:/handoff/plan.json
# Fill the generated plan and assignment. The starter cannot be launched unchanged.
agent-dispatch validate --plan C:/handoff/plan.json
agent-dispatch run --plan C:/handoff/plan.json
agent-dispatch status <run-id>
agent-dispatch next <run-id>
agent-dispatch dashboard <run-id>
```

Use the returned 24-character ID or the run's name. Commands emit JSON; status is compact. The full [contract format](docs/contracts.md) explains ownership, acceptance and continuation.

Prefer `next ID` for routine orchestration: it returns the next action and follows recorded continuations without inference or transcripts. Revise individual tasks with `taskPatches` instead of copying a full plan. `resume ID --plan patch.json --dry-run` also checks the persistent continuation history before launching anything. Caller-selected `onBlocked: "human"` and `runOnBlocked` checks preserve independent local evidence and skip unnecessary strategist calls; disjoint ready tasks continue while external requirements stay visibly unmet. See the [blocked-task contract](docs/contracts.md#blocked-tasks-and-independent-evidence).

New native plans use [compact Astra decisions](docs/decision-routing.md): bounded strategy packets start fresh Astra invocations. A separate terminal callback returns the result or human decision to the originating task once strategy settles; intermediate corrections do not wake Main. Use `--callback-route local` for dashboard-only notification. Include `decisionContext` with architecture and invariants. The default allowance is two Astra invocations per objective. `decisions` reads the inbox, `decision ID --dry-run` inspects without inference, and `decision ID --recover` restores a saved human-guidance response without another call. Existing saved routes are preserved.

ZCode Flash defaults to Max. AGY preserves an explicitly selected model/effort or reads the current AGY selection. Requested and observed model values remain separate in evidence. No provider fallback, quota reset or silent restart occurs.

```powershell
agent-dispatch switch <stopped-run-id> --provider zcode
agent-dispatch switch <stopped-run-id> --provider agy --model MODEL --effort high
agent-dispatch resume <stopped-run-id> --plan revised-contract.json
```

Provider switches require a confirmed stopped worker and keep the objective ledger, completed evidence, attempt count and correction budget. Changing providers/models starts a fresh compatible session. Changed scope, gates or increased budgets require a recorded `strategyChange`; quota/cancellation/ownership blockers require `blockerResolved`. A switch does not increase exhausted budgets.

## Files and evidence

- `<repo>/artifacts/agent-dispatch/<objective>/`: Markdown assignments, contracts and worker reports only.
- `~/.agent-dispatch/runs/`: runtime configs, receipts, process logs and manifests.
- `~/.agent-dispatch/objects/<hash-prefix>/<hash>`: source bytes stored once by content hash for rollback, including existing dirty files. These are never working copies and workers never implement there.
- `~/.agent-dispatch/projects/`: persistent objective budgets and acceptance state.
- `~/.agent-dispatch/decisions/`: compact strategy packets, structured responses, usage and Markdown results.
- `~/.agent-dispatch/dispatch.sqlite`: catalog, IDLE watches, callback outbox and night reservations.
- `<repo>/.zcode-dispatch/active-run.lock`: the small compatibility lock shared with existing runners.

Source auditing remains bounded (5,000 files, 32 MB/file, 128 MB total). Scope it to relevant editable source and pin large immutable fixtures separately. No old source snapshots are deleted or migrated automatically. Content objects have no automatic garbage collection yet.

`rollback <id> --wave N` verifies current source still matches that wave's ending state, checks every object hash, and restores only its declared owned changes. It refuses later edits or unowned changes. This coordination is not an OS sandbox; unrestricted workers can violate their instructions, and the dispatcher detects covered violations afterward.

## IDLE and callbacks

```powershell
agent-dispatch idle-submit --project C:/repo --assignment C:/handoff/task.md --title "Bounded task" --thread CODEX_UUID --model GLM-5.3 --effort max --night 2026-09-15
agent-dispatch watch --job EXISTING_JOB --project C:/repo --thread CODEX_UUID
```

`idle-submit` reserves one project/night, submits once with separate executable/argv values, then saves a durable watch. `--dry-run` neither reserves nor submits. IDLE model selection is explicit; native Flash defaults are never substituted for an IDLE request. An ambiguous submission keeps its reservation and receipt for reconciliation, never auto-resubmits. IDLE execution needs ZCode open and the computer awake. Promotional billing is not inferred.

IDLE follows its existing assignment and worker-side tests. Its terminal callback is **not** contract-gate acceptance; unlike native contract graphs, external queued IDLE work does not run the graph's automatic gate/correction pipeline in this release. Inspect its required evidence under the saved assignment before judging it. Do not claim all modes have identical validation.

Watches survive dispatcher restarts. Transient status failures keep watching; a deadline warning does not suppress a later completion notification. New IDLE submissions and non-legacy watch attachments use local dashboard notifications, with no Astra wakeup. Pass `--callback-route thread` explicitly to use Codex queue; existing and recovered legacy watches retain their saved route. Native plans select `decisionPolicy.route` as described in [decision routing](docs/decision-routing.md).

For thread callbacks, one automatic delivery attempt is claimed atomically before invoking Codex queue. `delivered` means queue acceptance, not that Astra has finished its turn. Failed delivery needs `notify-retry`; a crash/timeout during delivery is `unconfirmed` and requires checking the destination before `--reconciled` retry. Exactly-once delivery cannot be guaranteed because Codex queue exposes no idempotency key. Local records are explicitly labeled `local` and never claimed as delivered to Codex.

The external IDLE submission API also has no transactional link with this local database. A crash between remote acceptance and saving its ID requires reconciling the retained submission intent against ZCode's queue and attaching that job; never submit another just because no watch appears.

## Existing jobs

The dashboard imports the legacy registry without altering running jobs. It shows missing run directories as unavailable instead of hiding them. Completed history and per-task worker activity remain visible. Markdown links are served by the dashboard; worker monitor ports are never public navigation targets. Old callbacks and explicit v1/v2 commands retain their saved protocol. Use `import --run-dir DIR` for another existing contract run, then explicitly resume it through the new CLI when stopped.

The dashboard loads compact summaries and fetches details only for the selected run. Unchanged responses use HTTP 304; hidden tabs stop polling. Callback watching remains independent. See the [efficiency audit](docs/efficiency-audit.md) for the baseline and [compact decision routing](docs/decision-routing.md) for the implemented conversation-cost change.

To reconnect a dead IDLE watcher, use `watch` with its original job/thread and `--legacy-record FILE --legacy-pid PID`. Already-delivered records are not replayed; a live existing watcher is rejected. Do not recreate its job.

## Verification

```powershell
bun run typecheck
bun run test
bun run test:engine
bun run build
```

The tests use local fixture workers and callback executables. They never start paid model calls or submit live IDLE jobs. See [implementation evidence](docs/verification.md) for the trial findings, actual repaired watch and browser checks.

Bun primary references: [HTTP server](https://bun.com/docs/runtime/http/server), [full-stack bundling](https://bun.com/docs/bundler/fullstack), [process spawning](https://bun.com/docs/runtime/child-process), discovered through [llms.txt](https://bun.com/llms.txt).
