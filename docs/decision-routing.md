# Compact Astra decisions

New native CLI plans default to the compact route. Astra plans the objective once. Workers own generate/test/fix, and the engine executes independent acceptance and integration checks. An eligible strategic exception uses a **new ephemeral `gpt-6-astra` invocation**, not `resume`, `fork` or a callback into the original conversation. Ephemeral controls persistence; starting fresh with a bounded packet removes the old history from the request.

```json
{
  "decisionContext": "Architecture, shared interfaces, invariants, relevant tradeoffs and decisions already made. Include what a fresh strategist actually needs.",
  "notificationRoute": "thread",
  "decisionPolicy": {
    "route": "compact",
    "effort": "high",
    "maxCalls": 2,
    "maxPacketBytes": 24000,
    "timeoutMs": 180000
  },
  "finalJudge": "human"
}
```

`maxCalls` counts reserved CLI invocations across the project's objective, including failures and interrupted calls. It is not a token budget or a guarantee about provider transport retries. Attempt history survives new run IDs and database restarts. A queued decision that is obsolete or ineligible spends no invocation.

## Routing

| Event | Compact route |
| --- | --- |
| Ordinary failed gate | Worker correction loop; no Astra |
| Eligible strategic exception with attempts remaining | Fresh Astra decision, at most once for that run |
| Task explicitly configured with `onBlocked: "human"` | Human decision with no strategist invocation; independent tasks finish first |
| Quota/cancellation/ownership blocker | Local decision inbox; no automatic restart or Astra |
| Exhausted worker/strategy allowance | Local decision inbox |
| All checks passed, human final judge | Local decision inbox and dashboard judgment form; no Astra |
| All checks passed, explicitly selected Astra final judge | Fresh evidence-based judgment, guarded by the existing source fingerprint check |
| Missing/oversized context, malformed response or insufficient evidence | Local decision inbox; no hidden retry |
| Interrupted invocation or uncertain continuation | Unconfirmed; reconcile the existing action before continuing |

`route: "local"` keeps all decisions local. `route: "thread"` retains the original Codex queue callback and its conversation cost. Existing saved configurations without a decision policy retain their old thread route. Already-running jobs are not silently migrated.

Decision routing and notification routing are separate. New native plans default to `notificationRoute: "thread"`: the decision is saved in the inbox, then one terminal attention callback reaches the originating Codex task. Pending decisions and successful worker continuations stay quiet. The callback requests a concise result or specific human decision, not another component review or repair loop. This final callback can incur the original task's context cost; it is not free. Set `notificationRoute: "local"` or `--callback-route local` to keep all notifications in the dashboard. `route: "local"` disables strategist inference; it does not implicitly mute notifications. The table above describes decision storage, before notification delivery.

Existing runs retain their saved behavior. A continuation preserves its previous notification route unless explicitly overridden. Pass `--thread CURRENT_TASK_UUID --callback-route thread` when intentionally transferring a continuation's attention notifications to the current task. Launch and preview results show the resolved target and route. There is no OS push notification or Windows startup service. `agent-dispatch dashboard` recovers the service at its saved address.

`needs_user.taskId` may name an affected task; it never authorizes work. Previously rejected, saved `needs_user` answers can be restored with `agent-dispatch decision ID --recover`, with zero inference and no worker launch. Recovery verifies the original packet, unchanged run and latest objective, retains invocation accounting, and refuses executable actions or obsolete runs.

Use `agent-dispatch next ID` for the routine callback/status read. It follows recorded continuations within the same objective and returns a bounded action, progress, evidence references and notification target. It does not load transcripts, start the daemon, invoke Astra or launch a worker. Full `status ID` remains available for detailed diagnostics. Native compact callbacks use `next` and omit the repeated full objective.

## Decision boundaries

The packet contains the original objective, explicit context, relevant complete assignments/acceptance/checks/ownership, remaining budgets, sibling ownership, current failure observations and bounded receipt/report excerpts. Strategy packets select failed tasks whose dependencies are ready and whose attempts remain; future tasks contribute ownership summaries rather than full assignments. Final-judgment packets include every task's criteria. References are marked as references, not claimed as read contents. Oversized authority is rejected rather than silently truncated. Evidence excerpts expose truncation and are untrusted observations.

Astra can return strategic guidance for an eligible unfinished task, final judgment when explicitly authorized, or a request for a human decision. Responses are strictly validated and bound to the packet hash. The dispatcher rechecks the saved state and latest objective before applying a result. Only `strategyNotes` on an existing task can be changed automatically; criteria, gate commands, scopes, dependencies, worker/provider selection and budgets remain unchanged. The resulting continuation runs through the existing engine validation and independent gates.

This restriction preserves the contract while allowing a different approach. A real change to requirements, interfaces, validators, permission or budget needs an explicit revised plan via `resume`. It is not disguised as worker guidance. Missing visual or business-journey evidence cannot be replaced with passing unit tests.

The CLI requests read-only execution from an isolated decision directory, ignores user config for this invocation, supplies concise role instructions and a JSON response schema, and disables optional capabilities. Auth still uses the normal Codex installation. It never grants the decision worker write access to the implementation repository. A streamed tool-use event stops the process and its output is rejected. Host/managed policy still applies; this is not a custom isolation boundary.

The installed CLI still advertises some fixed tool/skill context despite feature switches. The local mock measured **29,295 bytes of request input for a 119-byte fixture packet**, including that overhead. It is therefore **not tool-free or overhead-free**. See [transport evidence](decision-transport-verification.json). CLI configuration behavior is documented in the [official reference](https://developers.openai.com/codex/config-reference/).

## Commands and evidence

```powershell
agent-dispatch decisions
agent-dispatch decision RUN_ID --dry-run
agent-dispatch decision RUN_ID
agent-dispatch status RUN_ID
```

`--dry-run` constructs the packet and prints eligibility without invoking a model. `decision` registers one durable decision; repeated calls do not rerun it. Resume the existing objective after resolving a blocker instead of inventing a new objective ID. The dashboard shows decision state, observed usage, the relevant workflow and any continuation.

Decision packets, response schema, event logs, concise Markdown result and CLI stderr live under `~/.agent-dispatch/decisions/`. Actual available `turn.completed` usage is retained; missing usage remains unknown. Human judgment can be recorded directly in the dashboard, with a reason, or through the existing `judge` command after the user's actual decision.

New IDLE submissions and newly attached non-legacy watches default to `--callback-route local`. They show completion/deadline records without waking Astra. Explicit `--callback-route thread` retains queue callbacks. Legacy watch recovery retains its old route. IDLE does not yet use native contract gates or this autonomous strategy loop, so worker completion remains distinct from acceptance.

## Verification and limits

**33 Bun tests and 141 Node engine tests passed**, plus TypeScript and the production build. Tests include local-notification zero-wakeup behavior, strategy/worker-budget preservation across restarts, malformed/stale responses, overlarge packets, large-graph context selection, operational blockers, timeout/crash deduplication, stream cancellation and HTTP human judgment.

A real fixture worker first returned a contract blocker. A deterministic decision supplied strategy, the actual engine resumed the same objective, and the worker passed independent gates with two preserved attempts and one correction. Human-ready completion produced no additional Astra invocation.

The installed Codex executable also completed one structured invocation against a loopback Responses mock. The mock received no authorization credential and no original conversation history. Its synthetic usage is not a token-savings measurement. No live worker job or paid Astra probe was submitted. Production model quality, actual provider routing and cost per accepted objective still need observation on a real authorized task; this implementation does not claim mathematically maximum efficiency.

Browser verification on the deployed dashboard confirmed the Decisions inbox, preserved existing callback history, and a human-ready workflow's actual judgment criteria, reason field and accept/request-changes controls. No judgment was recorded on a real project during this check. Both updated delegation skills passed validation and retain their prior invocation policies.
