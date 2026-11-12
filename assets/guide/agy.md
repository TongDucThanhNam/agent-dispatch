## AGY worker
- Fresh runs select the global `lean` worker profile (`~/.gemini/config/agents/lean/agent.md`): shell/task tools only, no default UI prompt or inherited customizations. Install it from this repo with `bun run setup:agy` (see `docs/agy-worker-setup.md`). Advanced run config can set `agyAgent` to another agent, or `null` for AGY's default. Resumes keep the saved agent; legacy resumes are not switched.
- Without `--model`, launch reads AGY's current `/model` selection once (no inference) and pins it for the run and its resumes; `{{CLI}} models --worker agy` shows it. Efforts: low, medium, high.
- Each run uses `--dangerously-skip-permissions` for authorized unattended work and print-timeout 0 (waits for completion); `--mode plan` is read-only. Global AGY settings are not changed.
- The prompt names the absolute project path; AGY's own scratch directory is not the project.
