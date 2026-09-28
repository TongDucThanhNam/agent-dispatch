# Task brief

<!-- Stage 2 of every delegated task: launch with --from <discovery ref> (agent-dispatch launch). -->

## Outcome and scope
<Full requested outcome and observable success; authorized effects; exclusions; preserve unrelated edits.>

## Context
<Project path and relevant instructions. Reference the discovery packet for current behavior, execution path and baseline instead of repeating it; add only what the packet lacks.>

## Discovery packet
<Path to the discovery report the plan was made from (the runner also passes it for --from; list earlier reports when discovery was resumed). The findings the plan relies on, and corrections: packet claims the orchestrator checked and found wrong, gaps the orchestrator filled by direct reads.>

## Plan
<Decisions made from the evidence. For each material decision:
- Decision: what will be done and why, citing the evidence.
- Locked: interfaces, behaviors, file boundaries or approaches that must not change.
- Sequence: order of work, when it matters.
- Worker discretion: what the worker may choose or improve.
- Replan condition: the evidence that would invalidate this decision.
Distinguish requirements from suggestions.>

## Taste
<Relevant design/UX examples, behavior, simplicity, maintainability and error handling expectations. Omit irrelevant categories.>

## Acceptance tests
<For each task requirement: concrete command or manual procedure, expected result and evidence to retain. Include relevant regressions, failure/edge cases and integration checks. Identify known unrelated baseline failures honestly (the packet's baseline).>

## Execution ownership
Implement the full authorized task. Decompose internally as useful. Run the tests, self-review the final diff against the outcome, constraints and taste, fix findings and failures, then rerun affected checks after final edits. Do not return for routine stage review. Do not weaken acceptance tests or silently drop scope. Do not add reviewer agents or orchestration layers. Respect an explicitly read-only/planning assignment. If a replan condition occurs or evidence contradicts a Locked decision, stop and return BLOCKED (REPLAN) instead of working around it.

## Final response to the orchestrator
Return one concise final report after required checks pass: outcome, material changes/files, each required test command/procedure and result, useful evidence paths, self-review fixes, and limitations. Enough evidence to assess completion; no duplicated report file required.

If truly blocked, report BLOCKED with the exact obstacle, failed/unrun checks, work preserved and smallest resolution needed. For BLOCKED (REPLAN), also name the decision affected and the evidence against it. Never label unverified work as passed. Ordinary recoverable implementation/test failures belong in your own fix-and-test loop.
