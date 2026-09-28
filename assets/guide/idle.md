# IDLE queue tasks (ZCode desktop)

Use only when the user explicitly asks for IDLE; never as a fallback for native runs. Queue admission is not worker startup, and a completed row is not proof that tests passed. ZCode desktop must stay open and the computer awake.

## Preflight
`{{CLI}} idle doctor`, `{{CLI}} idle models`, `{{CLI}} idle list`, `{{CLI}} idle availability` (passed through to the installed zc.mjs adapter). Check versions, the server allowlist, admission and existing tasks for the same workspace. Also reconcile native runs (`{{CLI}} runs --active`): the adapter does not take the native project lock.

## Submit
Write the brief to an absolute path, then dry-run and submit once:
`{{CLI}} idle submit --title "Title" --file C:/abs/brief.md --workspace D:/abs/project --model GLM-5.3-Flash --thought max --mode yolo --dry-run` (repeat without `--dry-run`).
- IDLE needs the provider account:zai-offpeak-idle-plan (or account:bigmodel-offpeak-idle-plan), not the native coding-plan provider; "Built-in Provider models empty" also covers that mismatch. The model argument is the bare ID (GLM-5.3-Flash). Pass effort explicitly; the adapter has no max default.
- `yolo` only for authorized implementation; `plan` for read-only.
- If submission is uncertain, reconcile `idle list`, `idle status ID` and `idle ticket ID` before retrying. Never fabricate tickets, skip allowlists, buy capacity or retry on a reset timer.
- Verify `status.model_selection` holds the requested providerId, modelId and options.reasoningLevel (legacy model/thought_level NULL is normal).
- Report "running" only when raw status is running, session_id is set, started_at is set and last_error is empty. Otherwise report it as queued.

## Two stages as two tasks
Discovery is its own task (brief from `{{CLI}} template discovery`; `--mode plan` unless its questions need commands). The native stage guard does not apply: record `git status --porcelain` and `git diff --stat` before and compare after; report changes, never discard them. Save the final discovery response under `.tmp/` and cite it in the execution brief. Submit execution as a second task only after planning.

## Monitoring
`{{CLI}} idle watch --job TASK_ID --thread CODEX_TASK_UUID --state-dir ABS_DIR --deadline UTC_ISO8601` polls `idle status` without inference and queues one Codex callback (model gpt-6-astra) at a terminal state or the deadline. Start it once, detached and hidden, with a unique state dir; confirm its first log lines on stderr. The deadline does not cancel the task. Reuse the state dir rather than starting duplicate watchers. Without a Codex task UUID there is no callback: report the task ID and check `idle status` when asked.
On completion inspect `idle status` and the bound session's final response against the full brief. Resume the exact bound session for a blocker or missing evidence; do not resubmit automatically.

## Compatibility
Verified with desktop 3.14.0 (structured `off_peak_tasks.model_selection`). After a desktop update, do not only edit the adapter's version constant: inspect the installed queue schema and the scheduler's model-selection contract read-only, make the smallest adapter fix, test it against the real schema in an in-memory database, then dry-run and submit. Never modify application binaries or existing queue rows. Adapter files: zc.mjs, test.mjs and off-peak-3.14-schema.sql in %LOCALAPPDATA%/Programs/ZCodeCLI (tests: `node --test <abs>/test.mjs`).
