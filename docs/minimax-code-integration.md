# MiniMax Code Desktop integration

Implemented on **2026-09-30**, using the installed Windows Desktop **3.0.74** (`@mmx-agent/electron`). The integration deliberately does not install or invoke the standalone `mcode` CLI.

## Desktop transport and account routing

The supplied `MiniMax Code.exe` hosts an existing coding runtime. Its opt-in diagnostic HTTP sidecar forwards to that runtime; it is not an independent runtime competing for the desktop's database. `agent-dispatch mcode setup` connects a valid existing sidecar or starts a closed desktop with that sidecar enabled. If an app is already running without the bridge, setup asks the user to close it normally rather than restarting it.

The bridge binds loopback and writes an ephemeral startup-token manifest. Dispatch verifies its owner process, executable, start time, host, port and package identity. The token stays in memory during requests and is not copied into run configuration, reports or exports. Account credentials, global permissions, runtime leases and the desktop database are never edited by dispatch.

Only the desktop's managed `minimax` provider with active `token_plan` source is accepted. Dispatch reads the live model roster, pins the selected or explicitly requested model/variant/effort, and verifies the native session before delivery and after completion. It never falls back to BYOK or a standalone CLI. Promotional eligibility and actual billing are not established by this transport.

## Implemented behavior

- Worker `mcode`; skill `delegate-to-mcode`, installable independently for Codex and Claude.
- New visible coding sessions in the app; exact `mvs_...` session resume with a fresh dispatch turn ID.
- Session-scoped AllowOnce permission replies in `yolo` mode, without global permission changes or approvals for other sessions/agents.
- Native incremental SSE decoding, raw run-local events and dashboard-compatible SQLite projection. Cursor/chunk deduplication, stable tool IDs, final-content replacement and unknown usage preservation.
- Success requires a native terminal marker, finished event, final assistant response and verified idle native session/model; disconnects alone do not count as completion.
- Stop aborts the exact dispatched turn, confirms release, and leaves Electron and other sessions alive. Uncertain release retains the project lock.
- Discovery/execution lineage, report validation, progress dashboard, session-log export and desktop continuation through the existing dispatcher protocol.

Main implementation: `src/workers/mcode/desktop.ts` and `src/workers/mcode/adapter.ts`. Configuration, launch, supervision, maintenance, guides and skill installation use the existing shared dispatcher infrastructure.

## Validation

`bun run check` passed: TypeScript backend/web checks, production dashboard build and **171 tests / 455 assertions**. Eleven MiniMax-specific tests cover bridge validation, model/account selection, session ownership, SSE decoding, projection, exact resume, scoped permission replies, stop/release uncertainty and worker-scoped skill installation.

Live acceptance uses a separate synthetic Git project, not this repository. Desktop discovery reproduced a failing Node test without changing the worktree. A linked execution changed only the intended return literal from `1` to `2`, ran the test successfully and produced a reviewed report. Both used the selected `MiniMax-M3.1-Flash-Preview` model with `max` effort through the desktop's `token_plan` source.

Exact-session resume and cancellation were also verified live: execution, the cancelled turn (exit 130), and a successful post-cancellation resume all retained the same native session with distinct turn IDs. Electron stayed alive and the project lock was released. Desktop handoff returned that session's real title/ID. Session-log export succeeded, and a content check confirmed the ZIP did not contain the bridge startup token. The real `delegate-to-mcode` skills were installed for both Codex and Claude; `doctor` reported the desktop bridge and both skills healthy.

## Operational limits

- This is a version-specific internal desktop interface, not a public compatibility guarantee. Unsupported contracts fail closed. Desktop 3.0.74 is the tested baseline.
- Windows only. After app restarts, rerun setup; the startup token is not a durable credential.
- Native plan/goal sessions and `--mode plan` are rejected. Discovery relies on the read-only brief and worktree guard, not a hard filesystem sandbox.
- Requests requiring human questionnaire interaction block with actionable guidance; dispatch does not fabricate answers or switch providers on account/quota errors.
- `desktop <ref>` returns the existing visible session identity and selection instructions, not an invented deep link. Use only one client per session at a time.

## Usage

```text
agent-dispatch mcode setup
agent-dispatch models --worker mcode
agent-dispatch skills install --worker mcode --include-missing
agent-dispatch guide mcode
agent-dispatch launch --worker mcode --stage discovery --brief <discovery.md>
```

Default executable: `%LOCALAPPDATA%/Programs/MiniMax Code/MiniMax Code.exe`. Default manifest: `~/.minimax/run/agent-dispatch-desktop.json`. Override with `MCODE_DESKTOP_EXE` and `MCODE_DESKTOP_MANIFEST` when necessary. Never paste or commit the manifest.
