# Workflow incident: Delegate Zcode regression check

Inspected Codex task `01a0a2e4-9c97-7490-836c-b239ccd49ad6`, its three completed turns, the saved dispatcher runs/decisions, and local token accounting on 2026-09-15. This is a dispatcher/workflow audit, not acceptance of the Cici implementation.

## What failed

1. **Valid human guidance was rejected twice.** Both real compact Astra responses returned `action: needs_user` with the affected task ID. The advertised schema allowed this, but the runtime validator required null for every non-retry action. It replaced useful explanations with `This decision cannot assign a task`. The two invocations consumed 10,965 + 10,436 uncached input tokens and 317 + 218 output tokens. Astra correctly identified that the requested MP4 was absent and the contract could not authorize another submission. This was a protocol defect, not evidence that Astra needed higher effort.
2. **The user became the poller.** Compact routing stored terminal notices locally with attempts=0. The user returned asking where the task was, then “Now what?”. A recorded inbox item was treated as sufficient notification, despite the original callback requirement. The first compact decision started at 04:19:51Z; the user status request arrived at 05:12:08Z. This roughly 52-minute gap is not worker execution time.
3. **Callback ownership stayed in an older task.** Both continuations saved `01a0a06a-0b6e-78c1-8d6c-7524d4827adf`, instead of the inspected task's UUID. The old resume whitelist rejected `threadId`, making proper rebinding unavailable. Local routing meant no misdelivery occurred in these two runs, but simply re-enabling callbacks would have targeted the wrong task.
4. **The CLI made Main troubleshoot the CLI.** The initial launch needed 19 shell executions. A short model name collided across two configured providers. A new-plan validation succeeded but the actual resume rejected `project`; Main then read dispatcher source to discover the patch whitelist. Fresh dry-run verification during this audit also exposed a resume bug: saved `expectedProvider` and `expectedModel` were converted back into an ambiguous short model. Provider identity must survive normalization.
5. **An oversized task tied all progress to an external result.** The new audit absorbed an older contract's exact 30s/9:16 output requirement, local regression repairs, packaging and runtime activation into one task. Two recorded provider refusals could not satisfy that requirement. The worker stopped before a gate receipt, leaving `lastReceipt: null` and `finalValidation: null`, even while its report claimed local checks passed. Future planning should preserve genuinely continued requirements but separate local acceptance from the external outcome. A merely related new request should not silently inherit every old unmet gate.
6. **Main resumed doing operational work.** After “Now what?”, Main used 13 shell commands to inspect process ownership, start a staged Core, repeat the failed health gate and construct another assignment. That work belonged in the worker's authorized setup/test/fix loop. Hashing the staged executable did not establish correct authentication or data-root configuration.

## Token evidence

Main's local rollout contained 32 distinct cumulative usage updates, deduplicated before summing `last_token_usage`:

| Metric | Recorded tokens |
| --- | ---: |
| Main aggregate input | 2,047,012 |
| Main cached input | 1,960,320 |
| Main uncached input | 86,692 |
| Main output | 7,692 |
| Two separate compact calls: input, all uncached | 21,401 |
| Two separate compact calls: output | 535 |

Approximately 95.8% of Main's aggregate input was cached. On the first request after the long wait, 60,800 of 62,522 input tokens were cached. This session does not demonstrate a long-wait full-cache loss. Cached input still represents usage; the record alone does not establish monetary billing or quota weighting. The clear avoidable costs were unnecessary orchestration, discarded decisions and user-triggered recovery. There were 34 Main shell executions across the three turns.

## Shipped corrections

- `needs_user` may reference a known affected task without assigning work. Retry/final-judgment authority checks remain separate and strict.
- `decision ID --recover` restores only a saved informational human decision, verifies packet/current run/latest objective identity, preserves usage, and never invokes a model or starts work. The latest real response was recovered this way; the obsolete first decision remains superseded.
- Compact strategy and attention notifications are separate. New native plans use one terminal callback when attention is required, after strategy settles. Pending decisions and successful continuations remain quiet. `--callback-route local` explicitly selects dashboard-only notifications. A final callback may incur the originating task's context cost; that tradeoff is now explicit.
- Existing saved notification routes remain unchanged. Explicit `--thread UUID` rebinding is supported for run/resume/switch. Launch/preview output shows the target and route.
- `resume ID --plan PATCH --dry-run` and `validate ID --plan PATCH` validate the actual continuation without a worker or daemon launch. Matching immutable identity fields are accepted, changed identities rejected, and unsupported fields listed together.
- New native default uses the complete built-in Flash model ID at Max. Resuming reconstructs the saved complete provider/model identity, including nondefault providers. Explicit user choices remain explicit.
- The selected run page displays the decision explanation and guidance directly. Both delegation skills now cover scope selection, separate local/external evidence, runtime ownership by workers, continuation preview and truthful callback expectations.

## Verification and limits

The Bun suite passed 39 tests; the Node engine suite passed 141 tests. Type checking and the production build passed. Both installed skills passed validation. New regression cases exercise the observed non-null `needs_user.taskId` response, recovery without inference, stale/actionable recovery refusal, callback timing/deduplication/targeting, quiet automatic continuation, and saved provider identity.

A read-only preview of the real stopped run passed with its saved Flash/Max selection and the inspected task's proposed callback target. It did not launch a worker or change that run's route. Browser verification showed the recovered reason/guidance on the deployed run page with zero console errors. The daemon was restarted at its existing address after checking its identity and finding no in-flight decisions, notifications or IDLE watches.

No paid inference, worker job, provider submission or live callback probe was launched by this audit. Callback regressions used injected delivery, alongside the existing queue implementation. The blocked Cici audit is not accepted, automatically split or retried. Its source changes and worker-reported local test results still require their intended acceptance; the external video remains unmet. These changes repair observed failures, not proof of maximum efficiency or every future workflow's correctness.

## Follow-up fixes and optimization

Implemented after the user's request to fix and optimize the remaining workflow gaps:

- Contract blockers no longer stop disjoint ready tasks. Dependency/conflicting ownership, source integrity, quota and uncertain-process boundaries still stop affected work. A human-blocked task is retained across unrelated continuations without a new attempt.
- Explicit `runOnBlocked` checks save partial receipts with criterion coverage. Unmarked checks are not executed. A failing local subset returns to the worker's correction loop; a passing subset cannot accept the blocked task. This was tested with a sentinel external command that must never run after the blocker.
- Caller-selected `onBlocked: "human"` bypasses Astra for that task's required disposition. It does not weaken gates or convert a refusal into a successful result.
- `next ID` returns bounded next-action data and follows recorded continuations within the same objective. Native compact callbacks now request this smaller read and avoid repeating the full objective. In a single local measurement on the failing run, full status returned 5,417 bytes in 363 ms; the initial next implementation returned 994 bytes in 54 ms (about 82% less text). The final status-label correction changes the byte count slightly. These are command output/latency measurements, not model billing or an end-to-end savings estimate.
- Focused `taskPatches` preserve unmentioned fields and reject unknown/renamed tasks and typo fields. Continuation preview now runs the same persistent ledger, contract-change and budget preflight used by launch, while creating no run or worker.
- Both installed skills document these controls. The dashboard exposes partial criterion coverage and the blocker reason alongside each task.

Verification: 42 Bun tests and 146 Node engine tests passed (188 total), type checking and production build passed, and both skills validated. After the final small patch validation/status-label edits, the affected 13 tests and type check passed again. The actual saved continuation also passed the strengthened dry-run with no worker launch. Existing Cici contracts/check permissions and its unresolved video requirement were not modified; these controls apply when explicitly included in subsequent plans.
