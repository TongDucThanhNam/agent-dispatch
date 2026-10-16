# Delegation strategy (owner policy: decide up front, trust the report, spend little)

1. **The brief carries the thinking.** Make every architecture and contract decision before launch.
   The brief names:
   - the owner modules, with `path:start-end`;
   - the decided contract;
   - the acceptance commands;
   - explicit stop conditions ("stop and report BLOCKED if …").

   Make stop conditions measurable, such as "more than 120 flagged sites" or "a file fails to parse". A
   BLOCKED report with counts costs one short `resume` with a decision. A worker that pushes past a wrong
   assumption costs a whole run.

   When a BLOCKED count shows a wide mechanical migration (more than about 100 sites with one rewrite
   rule), resume with a codemod decision: a scratch script driven by the tool's own machine output, a
   sample review of the hunks, and a file cap as the new stop condition. Do not hand-migrate.

   Tell the worker that the decisions are made and are not to be re-litigated. When a worker has to
   decide architecture itself, rework follows.
2. **Trust the report; re-verify only on a red flag.** Do not rerun the worker's gates or suites. Read
   its report and check:
   - the status;
   - every command in its table passed, and any failure was rerun alone and explained;
   - there are no unexplained skips;
   - the diff stays inside the brief (`git diff --stat`);
   - nothing is BLOCKED.

   Re-verify yourself only when one of these occurs:
   - a red flag in the report;
   - a merge needed manual conflict resolution (then run the gates and the suites that the resolved
     files touch);
   - you integrated parallel runs (run the gates, not the suites, once on the merged tree: a rule from
     one run can reject a file from another even when every run passed alone);
   - a later run, gate or user finds a failure.

   Then trace the failure back to the run that introduced it, and fix it with a `resume` brief. A proof
   that only the orchestrator may run still runs. One example is a project rule that requires a
   real-environment check the worker is forbidden to do.
3. **Small runs.** Give each execution run one owner and about 100 changed files at most. Split wider work
   one of two ways:
   - parallel runs on separate checkouts, one worker per checkout, with an ownership table in a shared
     brief;
   - sequential runs.

   Prepare each parallel checkout with the repository's own setup command, not with ad hoc copies. If a
   worker reports a missing local prerequisite, the preparation step is at fault. Fix that step, then
   re-verify only the coverage that was missing.

   Cap parallel runs on one machine at about 4. More causes spawn-heavy suites to time out and fixed test
   ports to collide between checkouts. A failure that passes when rerun alone under no load is a load
   symptom, not a blocker; record it and fix the shared-resource cause (ports, fan-out) in a later run.

   Text-clean merges can still break semantically. If one wave changes a shared helper's signature, give
   every other use of that helper to the same wave in the ownership table, or plan the reconciliation as
   an orchestrator step and run that file's suite after the merge. A timing stop condition must say
   "measured alone": under parallel load a 450 ms step read 3.2 s.

   Short contexts cost less and drift less.
4. **Cost discipline in every brief.** Include a block like this:
   - Redirect suite and gate output to log files, and read only the summary lines.
   - Read slices of at most about 150 lines.
   - Re-read a range right before you patch it.
   - Run each full suite once, at the end, and rerun only the failures alone.
   - Do not write review scripts that run longer than about 5 minutes.
   - Wait on the process itself (a foreground command with a timeout, or its exit), never with `sleep`
     loops, including while another checkout holds a shared resource. Naming the substitute matters:
     "no fixed sleeps" alone still cost workers 15-20 minutes each.

   After each run, read `{{CLI}} insights <ref>`. For every repeated waste it reports (truncated output,
   stale patches, slow calls), add one rule to the next brief.
5. **Escalation, not a quota workaround.** If a worker fails the same problem twice, take one of two
   steps:
   - decide that point yourself and resume with the decision in the brief;
   - run only that piece as a separate run on a stronger model that the user has approved, and tell the
     user.

   Quota and authentication failures remain blockers.
6. **Continuations.** `--from` accepts only a discovery ref. To continue an execution run, use
   `{{CLI}} resume <ref> --brief <file>`. A resume keeps the run's pinned model. To change the model,
   launch a new execution run.
