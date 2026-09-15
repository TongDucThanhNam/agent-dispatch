# Contract input and continuation

Use `agent-dispatch init` for a starter. Paths for `project` and task `promptFile` resolve relative to the plan file. Scope paths resolve inside the actual project. Executables and argument arrays remain separate; no shell string is constructed.

Before launch, `validate --plan FILE` checks source inventory as well as the contract and continuation ledger. Success reports audited files/bytes and exclusions. Launch enforces the same preflight before creating a runner. The runner independently fingerprints source before work; metadata validation does not certify contents or acceptance.

Scope paths must be project-relative. Keep pinned validators outside write ownership and docs/output directories. Audit every declared source/read/gate path, but use the actual dependency scripts instead of parent directories containing tool distributions. Keep runtime captures in a fresh artifact directory; never include years of runtime evidence as writable source. Required binary source/assets remain audited: do not hide them as artifacts to pass a limit. The current snapshot bounds are 5,000 files, 32 MB/file and 128 MB total. Python `__pycache__`, Git metadata, node_modules and dispatcher state are excluded generated/internal directories. Preserve historical evidence; artifact classification does not authorize cleanup.

If the audit fails, it stops at the first unsupported path and emits one bounded diagnostic. Correct ownership and dependency scopes once, preserving the requested outcome and gates, then validate again. Use `list --project DIR --limit 3` only when the run ID is unknown; the result key is `runs`. `COMMAND --help` shows that command's usage. On a callback use `next ID`: `diagnose` means routine dispatcher setup investigation, not an exhausted worker allowance or a request for permission. Continue authorized read-only diagnosis and reversible orchestration repairs; product implementation stays with the assigned worker. Revalidate before launching any continuation, and preserve quota, cancellation and uncertain-ownership boundaries.

```json
{
  "project": "C:/repo",
  "objectiveId": "checkout-proof",
  "objective": "Checkout creates exactly one sale and reconciles stock and debt",
  "threadId": "the-originating-Codex-task-UUID",
  "decisionContext": "Preserve the checkout idempotency key and the existing ledger transaction boundary. Worker observations do not authorize changing these invariants.",
  "decisionPolicy": { "route": "compact", "effort": "high", "maxCalls": 2, "maxPacketBytes": 24000 },
  "worker": { "provider": "zcode", "model": "builtin:zai-coding-plan/GLM-5.3-Flash", "effort": "max" },
  "notificationRoute": "thread",
  "auditPaths": ["src", "test"],
  "tasks": [
    {
      "id": "checkout",
      "promptFile": "checkout.md",
      "writePaths": ["src/checkout"],
      "readPaths": ["src/contracts"],
      "gateFiles": ["test/checkout-contract.test.ts"],
      "acceptance": [
        {
          "id": "once",
          "description": "Replayed checkout posts once",
          "checks": ["checkout"]
        }
      ],
      "checks": [
        {
          "name": "checkout",
          "command": "bun",
          "args": ["test", "./test/checkout-contract.test.ts"],
          "timeoutMs": 120000
        }
      ],
      "maxAttempts": 3
    }
  ],
  "maxParallel": 2,
  "maxObjectiveCorrections": 6,
  "finalJudge": "human",
  "judgmentCriteria": [
    "The actual requested checkout journey works without substituted manual steps"
  ]
}
```

Task `dependsOn` defines the DAG. `integration: true` is exclusive and depends on all components; it owns repairs after application checks fail. Declare `finalChecks` and `finalGateFiles` for full integration. Every acceptance criterion must map to real check names. Pin validators/config/fixtures; generated validators need known-good and known-bad calibration before dependent implementation. Write/read/gate scopes must be audited and non-conflicting for concurrent tasks. Shared dependency files require an exclusive owner. Two workers is the default, not a requirement to force parallelism where components share ownership.

Write assignments around observable business outcomes and examples. A prompt being submitted, a tool being called, a report claiming success or a broad test count does not prove the intended persisted result. Reject substitutions such as seeded outcomes, manual checkout instead of Copilot checkout, or a debt test that leaves debt unchanged. Preserve existing tools without freezing the catalog when adding a compatible tool is necessary to meet the goal. Pin genuine invariants, not incidental implementation limitations.

Keep architecture/context in focused documents. Workers read the complete contract from a file; retries refer to saved failure receipts. The graph retains the whole objective, without asking Astra to re-read each component diff. Default final judgment is human; use `astra` only when authorized. Record judgment using `agent-dispatch judge`; passing machine gates alone leaves `awaiting_judgment`.

`decisionContext` supplies the concise architecture/invariants required by a fresh strategist; a referenced file is not automatically read into that decision. New plans default to the compact route described in [decision routing](decision-routing.md). The model can add bounded `strategyNotes` to an eligible unfinished task, then the worker continues under the same acceptance, scopes, provider and persistent budgets. Human judgment can also be recorded directly in the dashboard. Existing plans without a policy retain their saved thread callback behavior until explicitly resumed with a new policy.

A continuation JSON contains changed `tasks`, `worker`, scopes, gates, judgment criteria, and/or budgets. Supply `strategyChange` for changed contracts or increased allowances, and `blockerResolved` for operational blockers. Keep all previous task IDs and remaining requirements. A provider-only `switch` constructs this continuation without changing acceptance criteria or budgets. It still refuses a live worker, unknown ownership or unreconciled quota.

Preview the actual continuation, rather than validating it as a new plan:

```powershell
agent-dispatch resume ID --plan patch.json --thread CURRENT_TASK_UUID --callback-route thread --dry-run
agent-dispatch resume ID --plan patch.json --thread CURRENT_TASK_UUID --callback-route thread
```

`validate ID --plan patch.json` is an equivalent read-only preview. `project`, `objectiveId` and `objective` may be included only when unchanged; unsupported fields are listed together. `threadId` is notification ownership and may be explicitly rebound without resetting the objective. Relative prompt paths resolve from the patch file. No worker or daemon is launched by preview. Prefer patches to copied full configurations.

For a small revision, use `taskPatches` keyed by existing task ID. Unmentioned tasks and fields remain intact; task IDs cannot be renamed or invented this way. Use the full `tasks` array only when restructuring the graph or adding tasks. Preview checks the persistent ledger, latest continuation, contract changes and correction allowances as well as plan syntax.

```json
{
  "taskPatches": { "checkout": { "promptFile": "checkout-fix.md" } },
  "strategyChange": "Clarify the existing idempotency boundary without weakening acceptance"
}
```

## Blocked tasks and independent evidence

Set a task's `onBlocked: "human"` when a reported contract contradiction requires human disposition, for example a known external capability or permission boundary. This bypasses a strategist call for that blocked task; ordinary worker gate failures still use the worker correction loop. Default `onBlocked` is `strategy`. This field does not authorize omitting work, changing criteria, or accepting a refusal as the requested result.

Mark an existing check `runOnBlocked: true` only when the caller explicitly authorizes it to run after the worker reports `CONTRACT_BLOCKED:`. Use it for independent local checks which require no provider submission, unavailable dependency or new permission. Unmarked checks do not run in that state. The dispatcher cannot infer the side effects of arbitrary commands; the caller must choose correctly.

The dispatcher verifies worker report identity, source ownership and pinned gates first, then executes only the opted-in commands. A partial receipt records each criterion as `passed`, `failed` or `not_run`, with overall `passed: false`. Failed local checks return to the same worker's bounded fix loop. Once the local subset passes, the task remains blocked; no dependent task or final acceptance is unlocked. Source/gate tampering and uncertain ownership still stop the workflow.

Disjoint ready tasks continue after a contract blocker, including when `maxParallel` is one. Tasks depending on, or sharing conflicting ownership with, blocked work remain pending. Human-blocked tasks are retained across unrelated continuations without spending another worker attempt; resuming them requires an explicit revised contract or `blockerResolved` describing what changed. Existing accepted evidence and budgets remain intact. Older runs do not gain retroactive receipts or new check permissions.

Scope comes from the current request. Do not silently import every unmet gate from an older, merely related task. For a genuine continuation preserve its requirements, but divide independently verifiable local repairs and external-provider outcomes into separate tasks at planning time. An unavailable provider result must remain visibly pending; it should not erase receipts for completed local work. A known refusal is not proof that the requested output succeeded. Runtime setup, startup health and cleanup belong in the worker assignment and checks, with supported lifecycle/config/data-root handling. Avoid pinning incidental PIDs or temporary runtime directories as business requirements. Repeated tests need a specific flake hypothesis; do not require large repetition counts for every audit.

Newly imported legacy contracts may need an explicit storage-migration `strategyChange` because the new Markdown artifact directory is excluded from source auditing. Existing evidence is preserved and checked; do not reset the objective ID to bypass reconciliation.
