# Monitor, dashboard and session log

- Each run has a runner process that owns the worker, records `status.json` and serves a loopback control panel. The shared dashboard (`{{CLI}} dashboard [ref]`) lists active and recent runs. Monitoring never calls a model.
- A callback (Codex) or a `wait` return means the run settled. `status` separates `model` (configured) from `observedModel` (telemetry, shown only when different); effort is configured, not telemetry-proven.
- Ordinary inactivity and recoverable tool errors stay in the panel. A quiet worker is not killed for silence. `stop <ref>` stops only the worker tree its runner owns.
- Discovery runs fingerprint the git working tree before and after (HEAD plus status entries with content hashes, ignoring `.zcode-dispatch/` and `.tmp/`); changes appear as `worktreeGuard` and the `discovery_changed_files` alert. It is a check, not a sandbox.
- Trajectory view: turns, requests and steps with role badges, TTFT and decode time, tokens, cache hit rate, compactions, tool calls and run totals. Previews and content load on demand from the local session.
- `{{CLI}} export <ref> [--out FILE.zip]` writes the same ZIP as the dashboard's "Download session log": export.json, the run directory, trajectory.json, the worker session as session.jsonl, session tables and subagent sessions (Codex: also the raw event stream and a rollout copy). It contains prompts and tool output; treat it like the session itself.
- Machine shutdown recovery is not installed. A dead runner leaves the run `unconfirmed`: inspect the worker process before launching anything else in that checkout.
- Run records live in `<project>/.zcode-dispatch/<runId>/`; the hub registry in `~/.zcode/monitor` (`ZCODE_DASHBOARD_ROOT`). `{{CLI}} hub status|restart` manages the shared dashboard process; restart refuses while runs are active.
