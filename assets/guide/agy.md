## AGY worker
- Without `--model`, launch reads AGY's current `/model` selection once (no inference) and pins it for the run and its resumes; `{{CLI}} models --worker agy` shows it. Efforts: low, medium, high.
- Each run uses `--dangerously-skip-permissions` for authorized unattended work and print-timeout 0 (waits for completion); `--mode plan` is read-only. Global AGY settings are not changed.
- The prompt names the absolute project path; AGY's own scratch directory is not the project.
