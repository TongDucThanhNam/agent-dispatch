# Implementation evidence — 2026-09-15

## Trial findings

Inspected Codex task `01a09b97-ad08-7c70-9318-a69358e54db6`, titled **Close business journey proof gaps**. Its recorded turns establish:

- The parent dashboard hid ongoing component activity. Astra linked directly to a temporary worker server to expose it.
- Contract callbacks arrived for scope violations, an oversized retry prompt and final judgment. Native callback delivery was not universally broken.
- A generated retry exceeded 12,000 characters and woke Astra unnecessarily. The new runner places the complete criteria and failure evidence in a referenced contract file.
- Passing 92 tests did not prove all 47 requested prompt outcomes. Some debt/checkout/UOM results were unchanged or performed through manual/bridge steps. This is a constraint/evidence-design problem, not proof that any model's effort level always succeeds. The contract guide now emphasizes the actual persisted outcome and avoids freezing an insufficient tool catalog.
- Today the referenced `VLXD/apps/desktop/.zcode-dispatch` directory is absent. Its legacy registry entries still exist. The new dashboard retains them with an explicit unavailable-state explanation; deleted evidence cannot be recovered from a link.

Read-only scan of `cici-api/.zcode-dispatch` found **6,419 source-copy files totaling 80,550,976 bytes** in wave/baseline/review snapshot locations. These were rollback/review copies, not worktrees. Existing snapshots were preserved. New content-addressed storage saves unchanged source once across waves/runs and retains only manifests per checkpoint.

## IDLE recovery

Existing job: `offpeak-80aa5901-b97a-496f-b773-e83dfcbd1926`.

- Original target task: `01a09e8e-9759-7421-80c3-f9aaa9a2ec05`.
- Original watcher PID 14024 was absent. Its last persisted probe was `2026-09-14T09:27:22.930Z`, status running, zero callback attempts.
- A fresh read-only ZCode status query reported completed, model `GLM-5.3`, thought level `max`, session `sess_0da71f7a-53e7-4a6f-b15a-46cde64694c5`, ended_at `1789385049670`.
- Attached that same job to the durable watcher. No IDLE job was submitted or restarted.
- Codex queue accepted **one** callback at epoch milliseconds `1789430158644`. Repeated ticks and the subsequent daemon restart retained one attempt. The legacy receipt was backed up and marked delivered using that actual evidence to prevent an old watcher from replaying it.
- Reading the destination task still returned its previous user-driven closeout, not a confirmed consumption of this new queued message. Queue acceptance is verified; Astra consumption is not claimed. The destination had already independently confirmed the original watcher failure.

Recovery receipt is retained in the originating workspace at `outputs/agent-dispatch-callback-recovery.json`. Two older IDLE jobs had successful callback records, so the diagnosed failure is watcher lifetime/recovery, not a universal callback argv failure.

## Tests

Compact decision routing follow-up: **33 Bun tests and 141 Node tests passed**, including a real fixture-worker strategic continuation, large-graph packet selection, source-guarded human judgment through HTTP, and the installed Codex CLI against a credential-free loopback Responses mock. See [decision verification](decision-routing.md#verification-and-limits). No paid inference probe or new live IDLE task was submitted.

Follow-up self-audit (2026-09-15): **19 Bun tests and all 141 Node tests passed**, with TypeScript/build and browser verification. See [efficiency audit](efficiency-audit.md) for the measured changes and limits; the original implementation checks below describe the preceding baseline.

- **141 Node engine tests passed**, including all 138 retained tests plus checkpoint deduplication/rollback, provider-session rotation with persistent budgets, and external runtime/long-contract execution.
- **15 Bun tests passed**. Coverage includes durable restart/notification deduplication, strict status/job identity, transient failures, deadline followed by completion, ambiguous delivery, explicit retry, legacy receipt handling, one-night reservation, IDLE submission/watch attachment, retained ambiguous submission, cross-provider root-model isolation, HTTP deep links/report endpoints after restart, and a real fixture-worker process through the Bun-to-Node bridge with independent executable gates.
- TypeScript check passed. Production React build passed on Bun **1.4.0**. Public `agent-dispatch --help`, `doctor`, `dashboard`, `status` and import/error paths were exercised. `bun link` installed the command in the user's Bun bin directory.
- Both modified skills passed `quick_validate.py`; their `agents/openai.yaml` hashes and explicit-only policies remained unchanged.

Tests use deterministic local workers/callbacks, not paid inference. They do not establish production token savings or promotional billing.

## Browser verification

The in-app browser loaded the actual React dashboard. Verified active filtering/search, root and permanent workflow navigation, parent-to-worker task/todo/activity visibility, completed history, IDLE completion, and callback state/attempt count.

Direct navigation to a raw Markdown API response was blocked by the in-app browser (`ERR_BLOCKED_BY_CLIENT`). The UI now links to its own document reader. Clicking `worker-report.md` displayed the real saved report inside React successfully. HTTP tests also verified report access and rejected arbitrary file extensions and foreign-origin mutations.

The service was restarted repeatedly while retaining the same port/token and existing run links. New builds were reloaded before checking the UI. Existing worker processes, legacy automation schedules and project implementation files were not changed by this migration.

## Remaining limits

- The dispatcher must run for callbacks and URLs; `agent-dispatch dashboard` restarts it. No Windows logon service is installed.
- Codex queue has no exposed idempotency key. A crash during delivery is deliberately unconfirmed; an operator must reconcile before retry. A remotely accepted IDLE submission can also need reconciliation if the process crashes before saving its returned job ID.
- IDLE uses its saved assignment/worker tests and completion callback; it does not yet execute the native contract DAG's independent gates and automated correction loop. Terminal completion is not machine acceptance.
- Native worker supervision/telemetry still uses the extracted Node engine. Bun supplies the new CLI, daemon, SQLite watch/outbox, process calls and React server/bundling. This is not a claim that all adapters have been rewritten for Bun.
- Content objects have no automatic garbage collection. No existing source snapshots were removed. Audits retain their documented file/byte bounds.
