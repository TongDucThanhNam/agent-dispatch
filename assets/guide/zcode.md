## ZCode worker
- Fresh workers default to `files`: six built-in tools (Read/Write/Edit/Bash/TaskOutput/TaskStop). `--context-profile web` adds WebFetch/WebSearch, `shell` keeps Bash/task tools, and `stock` skips filtering. Resumes keep their saved profile; legacy resumes are not converted. Only child-process argv/environment change, never Desktop startup/config. Native authentication may update its credential store. Live smoke tests passed; see `docs/zcode-worker-profiles.md` for evidence and Windows browser-login setup.
- Default model `account:zai-individual-coding-plan/GLM-5.3-Flash` at effort `max`. `{{CLI}} models --worker zcode` lists the qualified `provider/model` IDs accepted by `--model`; efforts: low, high, max. The obsolete ZCODE_MODEL override is not used.
- Mode: default `yolo` for authorized work and for discovery (so read-only commands and tests can run); `--mode plan` only for strictly read-only runs.
- Per-run model/effort is isolated in a private provider file; shared ZCode settings are not changed.
- After the worker exits, `{{CLI}} desktop <ref>` gives the session for ZCode desktop/TUI continuation (`{{CLI}} guide desktop`).
- IDLE queue tasks only on explicit request: `{{CLI}} guide idle`.
