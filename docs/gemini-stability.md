# Gemini Desktop stability checks

These opt-in checks send synthetic data to the signed-in Desktop app. They never
read repository content into a prompt or resume an existing user chat. All model
requests explicitly select **3.5 Flash-Lite + Low**; production defaults remain
4 Argon + High. No CLI/API-key or computer-use fallback is used.

Install the current bridge with Gemini fully quit, then `gemini start` (see the
Gemini guide). The checker verifies installed bridge bytes and refuses a stale
revision, an unavailable app or an already-active turn.

```sh
bun scripts/check-gemini-live.ts --live
bun scripts/check-gemini-live.ts --live --suite large
bun scripts/check-gemini-live.ts --live --suite cancel
bun scripts/check-gemini-live.ts --live --suite soak --turns 30
```

- `full`: six consecutive turns in one new chat, including two long inputs,
  an 8+ KB output, Unicode, code, Markdown and math; duplicate request rejection;
  cancellation before submission; cancellation after a validated response frame;
  resumption of that deliberately cancelled test chat.
- `large`: a new chat followed by a 600-line synthetic prompt and a short reply.
- `cancel`: new chat, both cancellation cases and resume after cancellation.
- `soak`: cold counters, a small rich-text warmup and retirement, 20 s warm idle
  baseline, 30 consecutive turns by default in one new chat,
  growing synthetic input/output, duplicate rejection, early cancellation, an
  intentionally disconnected dispatcher stream, deliberate recovery questions,
  streaming cancellation, fresh-chat health, and a 60 s idle cooldown. `--turns`
  accepts 10–200. Each turn still explicitly uses Flash-Lite + Low.

The Windows sampler reads process counters once per second for the exact verified
Gemini executable. It never reads a prompt, credential or process memory. It
records the original owner's exit code if observable, per-process CPU deltas,
private/working-set MB, handles, process count and test phase. `resource-summary.json`
compares the last 10 warm idle baseline/cooldown samples by median. Cold-to-warm
loading growth and active-phase CPU are separately reported. Declared retained
growth alarms: root private +64 MB, total private +256 MB, root handles +64 or
process count +2. An alarm fails acceptance; it is not automatically called a
leak. Missing cooldown and owner exit also fail. CPU values are sampled lower
bounds (a process may exit between samples); 100% denotes one core, not the PC.

The disconnect case aborts ONLY its own dispatcher HTTP stream after a projected,
validated response frame. It must remain failed with `recoveredResponse` marked
unconfirmed, no final `response`, one submission and a known session. A separate
new recovery question may resume that inspected synthetic conversation, never
resend the interrupted question. This is not a machine-wide or Google-network
outage test. No production fault-injection or arbitrary-eval endpoint is added.

Each run saves `config.json`, the synthetic prompt, request, JSONL events, SQLite
projection and result under `.tmp/gemini-live-*/`. `summary.json` records model,
per-case outcome, elapsed time, submission count, response bytes, command maximum
and p95 latency and errors. The initial JSON line also identifies installed bytes.
The request file is local evidence, never console output. The bridge token is
never printed. Failed/ambiguous delivery is not retried automatically.

## Acceptance and limits

Completion requires a verified requested model/effort, owned response, expected
sentinel, exactly one submission, and no failed commands. Long output must also
reach its last numbered line and exceed 8 KB. Cancellation must be confirmed,
not just acknowledged; pre-send cancellation must have zero submissions. Duplicate
request IDs must return HTTP 409 even after completion. The app must be idle at
the end. Any missing evidence fails the checker with exit 1.

Runtime rendering and model response timing are nondeterministic. A model
omitting the requested sentinel or abbreviating output fails content acceptance,
not necessarily transport correctness. Inspect the saved result before drawing
conclusions. One pass is a regression sample, not proof against all future hangs.

The 600-line case reproduced a `draft` timeout on the old bridge: 10,005 ms,
zero submissions. The fix replaces the blank editor with one fragment of
text-node paragraphs, then verifies the entire draft before Send.
Single-line text stays on `insertText`; literal `<`, `>` and `&` cannot become
HTML. A slow draft has one execution with at most 60 s, shortened by the turn
deadline or cancellation's 15 s bound. Send is never retried.

An intermediate `insertHTML` version was rejected before submission in the live
app. Local Chromium with `require-trusted-types-for 'script'` reproduced that
failure as `TrustedHTML` enforcement; the text-node implementation needs no HTML
sink or Trusted Types policy. Run the isolated, account-free browser regression:

```sh
bun scripts/check-gemini-editor.ts
```

It checks exact Unicode, CRLF normalization, indentation, blank/trailing lines,
literal markup and large drafts under strict CSP. Set `GEMINI_TEST_CHROME` for a
non-default Chromium executable. A temporary profile under `.tmp/` isolates it
from the user's browser; no Gemini navigation or model request is performed.

```sh
bun scripts/check-gemini-renderer.ts
```

This separate local Chromium fixture uses inherited pipes, not a listening debug
port or the signed-in app. It executes the bridge's real command wrapper against
actual 12/24/30-second blocked JavaScript. It checks grace, bounded timeout,
joining the same outstanding read (one execution), cancellation, and recovery
after terminating only the injected loop. The fixture's origin guard is adapted
to its local file; installed origins/authentication guards remain unchanged.
Protocol references: [Chromium pipe implementation](https://chromium.googlesource.com/chromium/src/+/main/content/browser/devtools/devtools_pipe_handler.cc),
[Runtime domain](https://chromedevtools.github.io/devtools-protocol/tot/Runtime/).

Offline coverage also injects stalled drafts, lost send acknowledgements,
renderer timeouts, UTF-8 splits, changing ownership and dropped streams. Deadline
cleanup has a separate 10 s budget and may Stop only after fresh ownership checks;
it cannot send, publish an unowned answer or change timeout into success.

During the initial six-turn baseline the app exited between cases. No matching
Windows Application crash event was found; the cause is not established. This
is retained as a failed suite, not silently retried or described as a fixed crash.

## Verified sample (2026-11-12)

Installed bridge hash prefix: `44fef76ea7a56812`, Desktop 1.18.0. All real requests
explicitly verified 3.5 Flash-Lite + Low; no production default was changed.

- `.tmp/gemini-live-3JJktD/summary.json`: `large`, 2/2 passed. The 600-line
  payload was 49,668 characters. Draft insertion took 79 ms (previous version
  timed out at 10,005 ms before delivery). Whole resumed turn: 6,301 ms.
- `.tmp/gemini-live-mJg0uE/summary.json`: `full`, 9/9 passed, duplicate request
  rejected. Long output: 10,975 UTF-8 bytes, including the final numbered line.
  All delivered cases submitted exactly once; early cancellation submitted zero
  times. Streaming cancellation and same-chat resumption were confirmed.
  No renderer command errors; maximum command latency across this suite: 349 ms.
- `.tmp/gemini-editor-ojaEv6/summary.json`: 9/9 local Chromium cases passed under
  strict Trusted Types/CSP, including an 80,007-character draft and literal markup.
- `bun test --timeout 60000`: 306 passed, 0 failed. Root/web typechecks and
  standalone checker compilation also passed.

These samples verify the deployed revision, not an unlimited stability guarantee.
The earlier unexplained app exit remains unclassified; it did not recur in the
final large/full suites.

## Soak investigation (2026-11-12)

The first 30-turn attempt (`.tmp/gemini-live-ROas3V/summary.json`) failed on
turn 19 before submission with `ERR_FAILED (-2)` loading the same conversation;
18 turns had completed exactly once. It was NOT silently retried or passed.
The app owner stayed alive; no matching Windows Application crash event was
found. The error alone does not establish its cause or the earlier app exit.
Peak sampled private memory was about 1,896 MB; no complete cooldown was recorded,
so retained growth cannot be inferred from that failed sample alone. Median
short-turn poll p95 was 33 ms early versus 35 ms late.

Preparation changes under test: one retry of a settled transient GET navigation
failure BEFORE draft/send; never retry blocked authentication redirects, crashed
renderers or unresolved timeouts. Navigation carries action/stage diagnostics,
and pending loads respect cancellation/turn deadlines. Offscreen painting is
limited to 5 FPS, then stopped; a collector for only that worker renderer is
bounded at 3 s before closing its contents/window. Cleanup finishes before EOF
and releasing the turn lock. Cleanup failures appear in `status.resources` and
fail the live checker instead of being hidden. No main-view navigation, cookie
export, heap capture, global graphics-policy change or process killing is used.
The memory/CPU effect of these changes requires a new measured live run, not an
assumption from their implementation. Offscreen cost controls are documented by
[Electron](https://www.electronjs.org/docs/latest/tutorial/offscreen-rendering).

The local stalled-renderer fixture passed all three cases in
`.tmp/gemini-renderer-kP4gxW/summary.json`: about 12.0 s (grace), 24.0 s (timeout
then same-execution recovery), and 16.0 s (cancel bound), each with one execution.

## Follow-up: navigation churn and warm-state measurement (2026-11-13)

Revision `e7e739bac420224f` completed 15 turns before the next navigation was
blocked for leaving the trusted origin. The owner stayed alive, no submission
occurred on the failed turn, and the guard was NOT loosened. That revision did
not record a redirect category, so authentication versus challenge versus another
external destination remains unclassified. Evidence:
`.tmp/gemini-live-qtdsdV/summary.json`.

Its complete post-failure cooldown showed root private memory 88.2 → 81.9 MB,
total private 395.3 → 679.7 MB (+284.3 MB), unchanged process count and root handles
+31. The total exceeded the declared +256 MB alarm and remains recorded as failed;
neither an incomplete soak nor an alarm is reclassified as a leak-free pass.
Peak was 1,116 MB, but this shorter, cold-started run is not an apples-to-apples
performance comparison with the preceding attempt.

The next candidate avoids per-turn page reloads: only an explicitly resumed SAME
conversation can lease the hidden renderer again, with fresh readiness, draft,
selection and turn-ownership checks. A new conversation discards it. Leases are
capped at 32 confirmed turns; idle expiry is 30 s. Failed/unconfirmed turns are
discarded, and HTTP/run references are cleared before idle retention. Retirement
stops painting, blanks only that private view, collects within its bound and
closes it. `status.resources.workerIdle` distinguishes an intentional idle cache
from an outstanding turn. No automatic request resend, external redirect or
main-view navigation is introduced. Offline cache/context/expiry/rotation checks
pass; this candidate still requires measured live acceptance.

The next measurement reports BOTH cold-to-warm allocation and warm-to-final
retention. It warms rich rendering once, allows idle retirement, then takes the
baseline. The original +64/+256 MB, +64-handle and +2-process alarms are unchanged.
This separates lazy-loaded rendering/cache growth from accumulation; it does not
erase the failed cold-baseline run. Tiny reply latency comparisons exclude rich
rendering turns, and active CPU is not diluted by idle measurement periods.

## Accepted cached-renderer soak (2026-11-13)

Installed revision `0d48af6d6969db2e`, Desktop 1.18.0. Evidence:
`.tmp/gemini-live-xyGhte/summary.json` and `resource-summary.json`.

- **37 checks accepted**: one rendering warmup, 30 consecutive mixed turns in
  one new chat, and six early-cancel/disconnect/recovery/stream-cancel/new-chat
  checks. All real requests verified **3.5 Flash-Lite + Low**. Each delivered
  turn submitted once; early cancellation submitted zero times. The original
  owner stayed alive. There were no command errors or cleanup warnings.
- The 30-turn chain crossed both previous failure positions (16 and 19) without
  reopening the page every turn. Its event files record one initial navigation
  and no per-resume navigation. Every new question still used fresh ownership
  evidence and the requested selection; old text was not accepted as a reply.
- Disconnect was an intentional abort of the test's own HTTP response stream.
  It remained exit 1 with a **32-byte validated, completion-unconfirmed recovery
  checkpoint**, never a final response or a resend. A separate recovery question
  resumed the recorded session successfully. Streaming cancellation was confirmed
  in **1,207 ms**, then same-chat resumption succeeded. Duplicate IDs were rejected.
- **334 process samples over 338.7 seconds**, including idle retirement and the
  final 60 s cooldown. Resources passed the unchanged declared alarm thresholds.

Median idle private memory (MB):

| Scope | Cold | Warm baseline | Final cooldown | Warm → final |
| --- | ---: | ---: | ---: | ---: |
| Main process | 89.47 | 79.32 | 81.32 | +2.00 |
| All Gemini processes | 397.49 | 743.72 | 883.38 | +139.66 |

Cold → warm allocation was **+346.23 MB** and is explicitly NOT hidden in the
warm-state comparison. Peak total private memory was **1,114.84 MB**. Root handles
rose by 23; process count stayed at six. These are retained-growth observations,
not proof of zero leaks. They are not an apples-to-apples claimed percentage
improvement over the shorter earlier failures.

Sampled active CPU was **66.09% of one core** over 197.24 active seconds; mean
including idle phases was 41.45%. Short-turn median poll p95 rose **62 → 261 ms**
as history grew: measurable scaling remains, rather than a claim of maximum
performance. Renderer retention is bounded by 32 leases and 30 s idle expiry;
the 32-lease rotation boundary is covered offline, not claimed as exercised by
the 30-turn live chain. No timeout occurred in this chain.

`bun test --timeout 60000`: **318 passed**, 0 failed; root/web and checker
typechecks passed. The earlier three real Chromium stall checks and nine strict
CSP/editor checks remain separate fixture evidence, not signed-in app crashes.
No machine-wide internet outage or 24-hour/unlimited soak is claimed. The earlier
unexplained app exit was not reproduced and its historical cause remains unknown.
