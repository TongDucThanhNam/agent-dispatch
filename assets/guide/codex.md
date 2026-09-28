## Codex worker
- Without `--model`, the selection comes from `CODEX_HOME/config.toml` (active profile first: model, model_reasoning_effort, model_provider; provider defaults to openai) and is pinned for the run and its resumes. Override with `--model M --provider P --effort none|minimal|low|medium|high|xhigh`; `{{CLI}} models --worker codex` shows the selection.
- The worker shares the Codex account quota with a Codex orchestrator. "You've hit your usage limit" is a quota blocker.
- Each run uses sandbox danger-full-access and approval never (discovery too, so shell commands work; the no-edit rule comes from the brief and the working-tree guard). `--mode plan` uses the read-only sandbox, which may reject shell commands on Windows.
- The worker thread is independent of any orchestrator thread. A worker process tree still alive 30 s after its turn ends is closed; the result comes from the final message, not that forced exit code.
