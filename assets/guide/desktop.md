# ZCode desktop and TUI continuation

ZCode desktop, the native TUI and delegated runs share the session database `~/.zcode/cli/db/db.sqlite`.
- After the worker exits, `{{CLI}} desktop <ref>` returns the session ID, a `zcode://workspace/open` URL for the same workspace and the exact TUI resume arguments (`zcode native tui --cwd <project> --resume <session>`). It refuses running workers and sessions of another workspace.
- The desktop imports CLI sessions when its workspace runtime initializes; a running desktop may need a workspace restart to show a new session. Live discovery is disabled: do not install ZCODE_AGENT_SERVER_COMMAND/ARGS_JSON overrides or promise automatic task-list updates.
- Continue from one client at a time. Before handing back to the orchestrator, finish the desktop turn and pass on the session ID and any changed requirements; an old report does not describe later desktop edits.

## MiniMax Code Desktop continuation

- `mcode` runs are created directly in the desktop's runtime as visible sessions, not imported from a standalone CLI. After the dispatched turn finishes, `{{CLI}} desktop <ref>` verifies and identifies the exact session by its title and `mvs_...` ID. Select that session in the app; no unverified deep link or automatic navigation is promised.
- Finish the desktop turn before `{{CLI}} resume <ref> --brief <file>`; resume pins the same session, workspace, model, variant and effort, and refuses busy sessions. Only one client should control a session at a time.
- If the app was restarted without its bridge, close it normally and run `{{CLI}} mcode setup`. Setup never kills/restarts a running app. See `{{CLI}} guide mcode` for the account, permission and bridge requirements.
