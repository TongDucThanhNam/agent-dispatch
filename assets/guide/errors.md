# Error codes (protocol v1)

| code | exit | meaning → action |
|---|---|---|
| USAGE, UNKNOWN_COMMAND | 2 | Wrong command or options → follow `hint` (it shows the usage line). |
| RUN_AMBIGUOUS | 2 | The ref matches several runs → pass the full run ID or run directory (`details.candidates`). |
| RUN_NOT_FOUND | 3 | No such run, or no status yet → `{{CLI}} runs [--all]`, or pass `--project` or a run directory. Right after a launch: check again, do not relaunch. |
| REPORT_MISSING | 3 | No worker report → if the run is active, wait; if settled, read `status` for the error and decide with the user. |
| LOCK_HELD | 4 | Another run owns the checkout → `{{CLI}} status <ref in details>`; never delete the lock while its runner or worker may be alive. |
| RUN_ACTIVE | 4 | The operation needs an exited worker, or maintenance needs no active runs → wait. |
| RUN_NOT_ACTIVE | 4 | Nothing to stop, or no session to resume → launch fresh if needed. |
| INVALID_CONFIG | 5 | Bad option value, missing Codex thread for `--notify codex`, bad model ID → fix per `hint`. |
| ASSIGNMENT_INVALID | 5 | Brief missing, empty or over 12,000 characters (`message` gives the excess) → compress duplication, not scope. |
| DISCOVERY_INVALID | 5 | `--from` is not an exited discovery run of this project with a report. |
| WORKER_UNAVAILABLE | 6 | Worker executable or runtime file missing → `{{CLI}} doctor`. |
| MODEL_UNAVAILABLE | 6 | Model not in the registry, or no selection → `{{CLI}} models --worker W`. Do not switch models silently. |
| LAUNCH_FAILED | 6 | The runner reported a startup error → read `message`; the run directory keeps the evidence. |
| STARTUP_UNCONFIRMED | 6 | The runner did not confirm startup in time → `{{CLI}} status <ref>`; do not launch a duplicate. |
| CONTROL_UNAVAILABLE | 6 | The run's control panel cannot be reached (runner gone) → inspect the worker process directly. |
| HUB_UNAVAILABLE, CALLBACK_FAILED | 6 | Dashboard or callback failure; runs continue → `{{CLI}} hub status`, or rerun the IDLE watch. |
| WAIT_TIMEOUT | 7 | `wait --timeout-minutes` elapsed; `details` holds the current status → wait again. |
| IO_ERROR, INTERNAL | 1 | File system or unexpected failure → report it with `message`. |
