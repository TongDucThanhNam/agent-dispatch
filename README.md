# agent-dispatch

A CLI and a stable JSON protocol that let an orchestrating agent (Claude Code, Codex or any shell-capable agent) delegate work to a worker agent (**ZCode**, **AGY**, **Codex CLI** or **Claude Code**) in two stages: **discovery → planning → execution**.

The behavior lives in this tool. The installed `delegate-to-*` skills are ~1 KB pointers to it, so fixes and changes land here, not in the skills.

## Install

Requires Bun ≥ 1.4 and Node (ZCode's native worker and the IDLE adapter run on Node).

```bash
bun install
```

```bash
bun link
```

`bun link` puts `agent-dispatch` on PATH (`~/.bun/bin`). Without it, use `bun <repo>/src/cli/main.ts` in place of `agent-dispatch`.

```bash
agent-dispatch doctor
```

`doctor` checks the runtimes, the worker executables and model selection, the dashboard hub, the installed skills and the current project lock.

## For agents: the protocol (v1)

Read `agent-dispatch guide <worker>` once per task (≈5 KB, tailored to the calling agent). It covers the flow, waiting and the rules. Then:

```text
agent-dispatch launch --worker zcode --stage discovery --brief .tmp/discovery.md
agent-dispatch wait <ref>
agent-dispatch report <ref>
agent-dispatch launch --worker zcode --from <ref> --brief .tmp/plan.md
agent-dispatch wait <ref2>
agent-dispatch report <ref2>
```

- **Output:** every command prints exactly one JSON line on stdout:
  - Success: `{"v":1,"ok":true,"cmd":"status","data":{…},"next":["agent-dispatch wait 3f06a68c"]}`
  - Error: `{"v":1,"ok":false,"cmd":"launch","error":{"code":"LOCK_HELD","message":"…","hint":"…","details":{…}}}`

  `guide`, `template` and `report` print raw text. `--pretty` indents the JSON.
- **Token budget:** null keys are pruned (absent means null). `status` is a compact, flat summary; `--full` gives the complete record. File lists are capped at 10 entries, with `changedCount` holding the total. `report --max-chars N` truncates. `next` suggests the follow-up commands, so an agent rarely has to re-read the guide.
- **Run refs:** the 8-hex `ref` from a receipt, a full run ID, `last`, or a run directory.
- **Exit codes and error codes:** the codes are a stable contract. New codes may be added; existing ones are never renamed or renumbered. The full table is in `agent-dispatch guide errors`.

  | exit | codes |
  |---|---|
  | 0 | ok |
  | 1 | IO_ERROR, INTERNAL |
  | 2 | USAGE, UNKNOWN_COMMAND, RUN_AMBIGUOUS |
  | 3 | RUN_NOT_FOUND, REPORT_MISSING |
  | 4 | LOCK_HELD, RUN_ACTIVE, RUN_NOT_ACTIVE |
  | 5 | INVALID_CONFIG, ASSIGNMENT_INVALID, DISCOVERY_INVALID |
  | 6 | WORKER_UNAVAILABLE, MODEL_UNAVAILABLE, LAUNCH_FAILED, STARTUP_UNCONFIRMED, CONTROL_UNAVAILABLE, HUB_UNAVAILABLE, CALLBACK_FAILED |
  | 7 | WAIT_TIMEOUT |

- **Orchestrator detection:** the `CLAUDECODE` env var selects `claude`; a UUID in `CODEX_THREAD_ID` selects `codex`; anything else is `generic`. Use `--orchestrator` to override. Detection only changes how waiting is described. With Codex, `--notify auto` queues one callback into the Codex task when the run settles.

## Commands

| command | purpose |
|---|---|
| `guide [worker\|idle\|monitor\|desktop\|errors]` | Operating guide (raw text) |
| `template discovery\|assignment\|review` | Brief templates |
| `check …launch options` | Validate a launch; starts nothing |
| `launch --worker W --stage discovery --brief F` | Stage 1 |
| `launch --worker W --from REF --brief F` | Stage 2: a fresh execution run linked to the discovery run |
| `status REF [--full]` · `wait REF` · `report REF` | Follow a run |
| `resume REF --brief F` | Continue the exact worker session in a new run |
| `runs [--active] [--all]` · `stop REF` · `inspect` | Runs and ownership |
| `dashboard [REF]` · `export REF [--out F.zip]` · `desktop REF` | Live dashboard, session-log ZIP, ZCode desktop/TUI handoff |
| `models --worker W` · `doctor` · `version` | Environment |
| `idle …` | ZCode desktop IDLE queue (only on explicit request) |
| `hub status\|restart` · `skills install [--dry-run]` | Maintenance; both refuse while runs are active |

`agent-dispatch <command> --help` prints the exact options.

## Compatibility

- Run records stay in `<project>/.zcode-dispatch/<runId>/`, with the same file layout as before (`config.json`, `status.json`, `worker-report.md`, …).
- The project lock stays at `.zcode-dispatch/active-run.lock`.
- The shared dashboard registry stays in `~/.zcode/monitor`, or `ZCODE_DASHBOARD_ROOT` if set.
- Runs started by the old skill scripts can be listed, followed and exported.

## Layout

```text
src/cli/        main.ts (command table, envelopes), args.ts (strict parser), maintenance.ts (doctor/models/hub)
src/protocol/   output.ts (envelopes), errors.ts (error codes → exit codes)
src/core/       config, launch (check/launch/resume), supervisor (runner), status, runs (ref resolution), lock, worktree guard
src/workers/    zcode (native invocation, desktop handoff), agy, codex adapters
                claude (native print-mode stream, pinned model/session, local telemetry)
src/monitor/    dashboard hub, telemetry, trajectory, session-log export
src/idle/       IDLE watch/record-night harness
src/skills/     thin-skill installer
assets/guide/   agent-facing guide text · assets/templates/ brief templates · assets/node/ Node loaders · assets/web/ panel page
web/            dashboard UI (React, Vite, shadcn/ui, TanStack Query/Table/Virtual); builds to assets/web/dashboard/
```

To change behavior, edit `src/` (logic) or `assets/guide/` (what agents read). Then:

```bash
bun run check
```

Tests are hermetic: fake workers, temporary projects and a private hub registry. They never call a model.

## Dashboard UI

The hub serves the Vite build of `web/` from `assets/web/dashboard/`. The build is not committed; `bun run check` produces it, or:

```bash
bun run build:web
```

Without a build the hub still serves run data and shows a page naming this command; `doctor` reports it as `hub.page: "missing"`. Reload after UI builds. Server changes require `agent-dispatch hub restart` once no runs are active; older hubs also need that restart to discard their previously cached page.

To work on the UI against real runs without touching the shared hub:

```bash
bun run dev:dashboard
```

```bash
bun run dev:web
```

`dev:dashboard` is a read-only hub on `127.0.0.1:4780` (Stop and Retry are refused; it rereads the build on every request). `dev:web` is Vite with hot reload on `127.0.0.1:5173`, proxying `/api/` to that hub.

### Performance

The dashboard uses native `Bun.serve`, `Bun.file` and cached `bun:sqlite` telemetry queries. Catalog polling stops without stream clients. Unchanged files and database projections are reused; finished trajectories load on selection. Cache invalidation still checks file identity, timestamps, database changes and schema changes.

The UI requests SSE protocol v2: a full snapshot on connection, changed fields/events afterward, and lightweight heartbeats otherwise. Legacy clients retain full snapshots. Clients viewing the same run share snapshot generation. Background tabs disconnect and resynchronize on return. Virtualized rows, incremental search indexing, prioritized/cancellable preview batches, local clocks, lazy inspector panels and worker-based syntax highlighting keep unnecessary work out of the interaction path.

Run the synthetic transport benchmark (no workers or model calls):

```bash
bun run bench:dashboard
```

On Windows/Bun 1.4.2, four clients viewing 2,000 events at an accelerated 50 ms poll interval produced these one-second samples, excluding the initial full snapshots:

| Measurement | Before | After |
|---|---:|---:|
| Unchanged update bytes | 21,104,592 | 2,888 |
| One event changed per tick: update bytes | 21,104,788 | 22,084 |
| Snapshot generations per scenario | 80 | 20 |
| Eager production JavaScript, uncompressed | 862,202 B | approximately 609 KB |

The eager-JavaScript measurement includes the entry and its preloaded shared chunk; inspector, Markdown and highlighting chunks are loaded separately. Production polling remains 2 seconds. These are workload-specific transport/build measurements, not an FPS or latency guarantee. Tests cover delta reconstruction (including sliding event windows), cache invalidation, stream lifecycle, preview cancellation, security boundaries and ZIP export.

## Skills

```bash
agent-dispatch skills install --dry-run
```

This replaces `~/.claude/skills/delegate-to-{zcode,agy,codex,claude}` and `~/.codex/skills/…` with thin pointers. The old directories are moved, never deleted, to `~/.claude/skill-backups/<date>-agent-dispatch-cli/`. Each skill's trigger description and the Codex `agents/openai.yaml` settings are kept. The previous implementation is archived on the `archive/contract-dispatcher` branch.

To add only the Claude delegate without changing existing skills:

```bash
agent-dispatch skills install --worker claude --include-missing
agent-dispatch guide claude
```

The Claude worker requires the native Claude Code CLI ≥ 2.1.259. It uses existing Claude authentication/settings, resolves model aliases at startup and pins the actual model for resumes. Use `--worker claude` in the same discovery/execution flow shown above. `--model` and `--effort` override the worker selection; backend routing remains in Claude's own configuration. No Agent SDK dependency is required.
