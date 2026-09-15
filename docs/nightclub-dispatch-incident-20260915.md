# NightclubLive dispatch failure and repair — 2026-09-15

Task: `01a0a487-1c25-7873-9a1e-54175e6e5f41`. Run: `d239248798218af83c760c7f`.

## What failed

ZCode never started: zero attempts and zero corrections. The contract's audit/read scopes included all of `Tools`, `Games/NightclubLive` and `Unreal/NightclubLive`. The source snapshot rejected the 102,856,192-byte FFmpeg executable, then continued walking and recording repeated limit errors. The persisted error alone was 683,574 bytes. Historical `Games/NightclubLive/Data/runs` contained 14,670 files / 11,246,604,417 bytes; explicitly parked character source archives were also included in the write scope.

Schema validation had passed without checking that the actual source inventory fit the engine's snapshot limits. The local decision fallback then hid the setup failure behind an exhausted-attempt message. The callback reached the correct task exactly once, but its blanket implementation prohibition contributed to an unnecessary request for permission to diagnose. No strategy invocation was recorded for this failure.

## Dispatcher changes

- Metadata-only source preflight runs in validation and launch before runner creation. Actual content hashing still runs before worker execution. Limits remain 5,000 files, 32 MB/file and 128 MB total; a partial audit is never certified.
- A fatal audit error stops the walk immediately and reports one bounded diagnostic with path, size and limits. Legacy `status` output also truncates oversized errors without rewriting original run evidence.
- Zero-attempt dispatcher failures and source audit failures return `next.action = diagnose`, ahead of stale generic decision labels. Their local decision state is `needs_diagnosis`, not a human approval request, and they spend no strategy call. Callback guidance permits authorized diagnosis and reversible orchestration repairs while retaining worker ownership of product code and no automatic provider submission/quota restart.
- Source identity excludes generated Python `__pycache__`; changing Python source is still detected. This avoids false gate drift from ordinary imports.
- `list --project DIR --limit N` bounds runs, watches and notifications. `COMMAND --help` works. The dashboard displays the source failure explicitly, including whether a worker ever started.
- Both installed delegation skills document these paths and the corrected source/output scoping rules.

## Prepared Nightclub continuation

Patch: `C:/Users/terasumi/.agent-dispatch/repairs/nightclub-ux-20260915/source-scope.patch.json`.

It preserves the original assignment, HUD/venue outcome, three executable checks, acceptance criteria, judgment requirements, worker model/effort and correction allowances. Only ownership/dependency/output boundaries and explanatory strategy notes change. Source coverage includes the existing Unreal source/config/content, venue concepts/graphics, relevant scripts, docs and tests. Character authoring remains parked as explicitly required. Existing runtime evidence is not writable source; new output gets `Games/NightclubLive/Data/runs/nightclub-ux-20260915` and the existing objective artifact directory. No historical evidence was deleted and no product code was changed.

The real continuation passes metadata validation: 239 files / 30,639,123 bytes. A separate content capture produced fingerprint `638c3550535494119b5de3f3e3825157d1bd1853e41d292e4911a1a548255204`, and all three pinned gate files were read successfully. The unchanged original scopes fail preflight with a 354-byte FFmpeg diagnostic. These are local inventory/output measurements, not model-billing measurements.

## Verification and limits

45 Bun tests and 151 Node engine tests passed; type checking, production build and both installed skill validators passed. Regression coverage includes prelaunch refusal with no worker/runner, source drift after preflight, no paid strategy call for setup failures, one callback despite repeated watcher ticks, bounded legacy errors and project-filtered CLI output.

The saved callback record and worker history remain intact. The repaired continuation has not been launched; no live ZCode completion, Nightclub build, runtime visuals or acceptance is claimed by this controller repair. Preflight cannot predict future source growth or certify the final product. Large required source scopes still need a compatible ownership/storage plan rather than silently bypassing snapshot limits.

Deployment: the idle, identity-verified Bun daemon was restarted at its existing URL. The browser rendered the actual source failure and the prepared repair summary; its inspected console contained no error-level entries. The saved non-invoked decision was backed up before correcting its diagnosis and repair-report reference. Callback delivery remained `delivered`, attempts `1`, after deployment.
