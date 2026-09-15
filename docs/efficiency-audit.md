# Efficiency self-audit — 2026-09-15

**Verdict: improved, but maximum efficiency is not established. The biggest remaining Astra cost is conversation reuse, not dashboard traffic.**

Follow-up: [compact decision routing](decision-routing.md) now implements fresh Astra strategy contexts and local human judgment for new runs. The observations below preserve the earlier audit baseline; production savings are still unmeasured.

## Actual Astra evidence

The first recorded Astra usage event in this audit, at `2026-09-15T00:29:34.921Z`, reported **220,358 input tokens, 0 cached input tokens and 210 output tokens**. The originating task is `01a0845e-f430-7a83-b6da-43fab3daa225`.

The local rollout contains 24 distinct usage events from 00:29 through the 00:42:54 capture: 2,137,832 aggregate input tokens, of which 1,827,712 were reported cached, and 15,616 output tokens. These are repeated request inputs, not unique conversation tokens or a billing statement. Repeated events with identical cumulative counters were excluded. This capture is partial; it excludes later work and the final response. Raw aggregate evidence is retained at `work/self-audit-usage.json`.

This establishes that a large uncached input occurred. It does **not** identify the cause: elapsed time, cache eligibility, compaction, routing or another factor cannot be distinguished from these counters. No pricing, quota multiplier or cache-retention claim is inferred.

The current callback still uses `codex queue --thread <original task> -m gpt-6-astra`. A compact callback message does not make the receiving task's existing conversation compact. Even a human-final-judgment notification currently wakes Astra to surface it. Removing routine component review was useful, but did not remove this context cost.

The next model-cost change should isolate Astra decisions into bounded contexts containing the objective, relevant interfaces/constraints, current evidence, remaining budget and exact unresolved decision. The user-facing task should receive only a meaningful result. This is a routing change; it is **not implemented by this audit**, and no extra Codex tasks or paid worker jobs were launched.

## Measured local improvements

Same registry: 304 runs, zero active, before and after. See [raw measurements](efficiency-metrics.json).

| Measure | Before | After |
| --- | ---: | ---: |
| Dashboard response | 2,862,008 bytes, all detailed runs | 74,466 bytes, summaries |
| Separate selected detail | Included for every run | 21,281 bytes for measured run |
| Unchanged response body | Full response every 4 seconds | 0 bytes, HTTP 304 |
| Cold catalog read | 662 ms | 82 ms |
| Warm summary read | Not captured | 15 ms |
| CLI `list` | 516 ms, one sample | 117 ms median of five samples |
| CLI output | 9,507 bytes | 9,507 bytes |

The summary payload reduction is **97.4%**. These local byte/time improvements do not establish any reduction in Astra tokens. Timing is indicative: OS caches and machine load vary, and the baseline timing has only one sample.

Implemented:

- Summary enumeration reads saved state directly in Bun, without starting a Node bridge, opening worker telemetry or reading worker reports. Node detail loading is restricted to the selected run.
- Server catalog/detail refresh follows browser requests, with a five-second cache and shared in-flight work. No catalog refresh timer runs when nobody is viewing it. The detail cache is bounded to 32 entries.
- Browser requests are conditional, non-overlapping and pause while the document is hidden. Returning to the tab refreshes it. Callback watching runs separately.
- Shared state interpretation checks process liveness and heartbeat age even when files have not changed. Changed/missing/restored records and review decisions invalidate summary caches.
- The worker reads one complete contract containing its assignment. It is no longer instructed to read a second copy of the same assignment. This removes one redundant assignment read per attempt; actual worker token savings were not measured.
- Durable terminal events exclude their runs from callback candidate scans. Completed watches and non-pending notifications are filtered in SQLite. Failed and uncertain deliveries retain explicit retry semantics.

Final integration checks remain. A subsequent task can break a previously accepted component; removing those checks solely to save runtime would weaken acceptance. Source checkpoint integrity and rollback verification also remain.

## Verification

- **19 Bun tests and 141 Node engine tests passed**; TypeScript and production React build passed.
- New coverage checks compact payloads, missing/restored records, legacy verdict updates, timestamp-independent liveness, selected-run detail/report access, HTTP 304, unknown IDs, callback candidate exclusion across restart, retries and pending-watch filtering.
- The real fixture worker still receives every assignment requirement, executes independent gates and reaches `awaiting_judgment`; its prompt references the complete contract once.
- In-app browser verified 304 historical runs, active filtering, selected task/model/todos/activity, the Markdown report reader and the existing one-attempt delivered callback. No browser console errors were recorded.
- The dispatcher was offline at the start; `agent-dispatch dashboard` recovered the existing stable address. No Windows startup service was added, so daemon lifetime remains a reliability limitation.

## Remaining model-efficiency limits

There is no end-to-end cost-per-accepted-objective comparison yet. Worker token reports and callback counts cannot substitute for originating Astra usage. A useful evaluation needs both worker and Astra counters, correction/replan counts, successful business outcomes and elapsed time on comparable tasks. It must count failed attempts and final judgment too.

This audit itself incurred substantial Astra context and output. Future checks should use bounded evidence packets and targeted reads; repeatedly expanding entire files, histories or tool documentation can cost more than the local runtime optimization saves. Once appropriate checks pass, stop broadening the audit without a specific unresolved issue.

Additional existing limits remain: IDLE completion is not native contract-gate acceptance; ambiguous callback/submission delivery needs reconciliation; rollback objects have no garbage collector. Existing legacy runs continue under their original saved scripts. These changes apply to the standalone CLI and its retained engine.
