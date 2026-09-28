# Discovery brief

<!-- Stage 1 of every delegated task: launch with --stage discovery. Same limit as the
     assignment (12,000 characters excluding a leading BOM); aim for 1,500–4,000.
     Ask questions, do not pre-plan: the plan is written after this report.
     The runner adds a no-edit preamble and compares the git working tree before
     and after. -->

## Outcome and scope
<The user's requested outcome, observable success, constraints and exclusions, as context for the questions. This stage does not implement it.>

## Questions to answer
<Numbered questions the plan depends on. Typical: where the behavior lives and its current execution path; interfaces, data formats and invariants a change must respect; callers and other affected areas; how to reproduce the problem; existing tests, build commands and their current results; constraints from project instructions; risks. Ask for options and evidence at each decision point, not for a finished solution.>

## Leads
<Files, symbols, logs, documents, screenshots or reproductions already known, and what the orchestrator has already read (the worker need not repeat it). Commands known to be safe to run. Omit when none.>

## Rules
Investigate only. Do not implement, refactor or fix the task, and do not create, edit, delete, format, stage or commit project files, install dependencies or run migrations. Read files and run read-only commands, reproductions and existing tests or builds. Put any temporary probe only under .tmp/. Stop and report rather than exceed this.

## Discovery report
Return one report, compact, citing paths and lines instead of pasting large code:
1. **Survey** – what was inspected and how deeply; relevant areas not inspected.
2. **Answers** – for each numbered question, every claim labeled OBSERVED (path:symbol, or command and result), INFERRED (with the evidence it rests on) or NOT CHECKED (with the reason).
3. **Execution path and contracts** – the relevant flow, interfaces, invariants and formats a change must preserve.
4. **Baseline** – test/build commands run and their results before any change; pre-existing failures.
5. **Decision points** – choices the plan must make, with options, evidence and risks for each.
6. **Proposals** – an optional suggested approach, kept separate from the facts above.
