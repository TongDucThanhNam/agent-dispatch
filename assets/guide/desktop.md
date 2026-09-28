# ZCode desktop and TUI continuation

ZCode desktop, the native TUI and delegated runs share the session database `~/.zcode/cli/db/db.sqlite`.
- After the worker exits, `{{CLI}} desktop <ref>` returns the session ID, a `zcode://workspace/open` URL for the same workspace and the exact TUI resume arguments (`zcode native tui --cwd <project> --resume <session>`). It refuses running workers and sessions of another workspace.
- The desktop imports CLI sessions when its workspace runtime initializes; a running desktop may need a workspace restart to show a new session. Live discovery is disabled: do not install ZCODE_AGENT_SERVER_COMMAND/ARGS_JSON overrides or promise automatic task-list updates.
- Continue from one client at a time. Before handing back to the orchestrator, finish the desktop turn and pass on the session ID and any changed requirements; an old report does not describe later desktop edits.
