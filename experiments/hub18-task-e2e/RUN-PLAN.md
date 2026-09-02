# Team run plan: hub issue #18, instance 1 (2026-09-02)

Task: `mechanize/hub-issue-18-task.md`. Workflow: `ai-docs/workflows/single-task-E2E.md` v1.0.0.
Hub workspace `ws-af2a669a-c311-4d98-8f53-f7d7de712c01`, problem
`prob:create-problem-hub-issue-18-instance-1`, teamRunId `hub18-i1-2026-09-02`.

Roles: Task Manager = lead session (hub agent 24e801d8). Verifier and Metatask
Executor = separate Claude Code sessions launched via `teammate-launch.mjs`, each
with its own hub identity and channel (verified 2026-09-02, see HANDOFF addendum).

Contracts (exact strings, used as contractRefs):
- `contract://hub18/i1/prompt`  — G + C as stated in the task doc
- `contract://hub18/i1/lock`    — LOCK.sha256 published by the Verifier

Intents:
- Verifier: write `mechanize/hub18/evaluator`, read `mechanize/hub18/runs`,
  contracts [prompt, lock].
- Executor: write `mechanize/hub18/runs`, `mechanize/hub18/executor-s0`,
  read `mechanize/hub18/evaluator/LOCK.sha256`, contracts [prompt, lock].

Expected impacts: LOCKED = blocking change on the lock contract (Verifier -> Executor;
Executor may not run before acknowledging). RUN COMPLETE = advisory change on the
runs scope (Executor -> Verifier). Contract gap at verdict = blocking change on the
prompt contract (Verifier -> Executor; Executor cannot close its problem until acked).

## Stages (each posted to the problem channel as `STAGE <id> <PASS|FAIL> <evidence>`)

Verifier:
- V1 S0 established: worktree at c182dce, `pnpm test` green (expect 65 files / 726 tests).
- V2 Flip tests F1..F3 written under `mechanize/hub18/evaluator/` (never inside a
  worktree), copied in at run time; all three FAIL on S0.
- V3 Hold tests H2..H4 written; all PASS on S0. H1 = `pnpm test`; H5 = sha256 of the
  locked files, checked by script.
- V4 Reference fix as `evaluator/reference.patch`: F1..F3 PASS and H1..H5 PASS on S0 +
  patch, in a scratch worktree the Executor never sees.
- V5 Witnesses S-a..S-f as `evaluator/witnesses/*.patch`: each fails exactly the hold
  or flip it should; matrix posted.
- V6 `evaluator/LOCK.sha256` over evaluator files + task doc + S0 commit id; post
  `LOCKED <sha256>`; record a BLOCKING work change on `contract://hub18/i1/lock`.

Executor:
- E1 S0 worktree at c182dce, `pnpm test` green; `runs/claude-run-1/PROMPT.md` written
  verbatim from G + C plus the affordance note (no network; may run `pnpm test`,
  `pnpm check:types`, `pnpm check:cycles`).
- E2 Isolated run command prepared and dry-run with a trivial prompt: auth works,
  no MCP servers, no web tools, no user-level settings. Post the exact command.
- E3 After acknowledging the LOCKED impact: run the frontier agent
  (claude-fable-5-1 first) in `executor-s0`, 45 min budget, capture
  `transcript.jsonl` and `diff.patch` (against c182dce) under `runs/claude-run-1/`.
- E4 Post `RUN COMPLETE <path>`; record an ADVISORY change on `mechanize/hub18/runs`.
- E5 Only on Task Manager instruction: one bounded implementation-repair task.

Verifier grading (on RUN COMPLETE impact): fresh scratch worktree at c182dce, apply
`diff.patch`, copy evaluator in, run F1..F3 and H1..H5, post
`VERDICT <PASS|FAIL|INVALID|UNQUALIFIED|BLOCKED> <first blocker>`. Never work inside
the Executor's worktree.

Task Manager: classify every verdict (model / spec / affordance / grader), record the
decision on the hub ledger (scope `mechanize/hub18`), export the workspace event log
to `mechanize/hub18/ledger.json` at the end.

## Checkpoint (T0 = time both teammates have posted READY)

At T0 + 90 min the Task Manager evaluates the Verifier's trajectory. It is
**decisively healthy** iff ALL of:
1. V1..V4 posted with evidence (test counts, pass/fail lines).
2. At least 3 of the 6 witnesses in V5 verified and posted.
3. No open finding that a predicate is unmeasurable without redesigning the grader.

Healthy -> continue. Hard deadline for `LOCKED`: T0 + 150 min.
Not healthy at T0 + 90, or no `LOCKED` by T0 + 150 -> ABORT.

## Abort semantics (predefined; no improvisation)

1. Task Manager posts `ABORT <stage> <reason>` on the #18 problem and records a hub
   decision with receipt type UNQUALIFIED (evaluator could not be qualified) or
   BLOCKED (budget exhausted), per the workflow.
2. Verifier stops, leaves `mechanize/hub18/evaluator/` exactly as is (checkpoint
   preserved), posts its final stage state. Executor stops any running agent, writes
   `ABORTED` into the run dir, grades nothing.
3. The #18 problem is closed with the receipt as its final message. Its intents are
   left to expire.
4. **Instance A is a fresh task instance, not a switch.** New hub problem
   "Dispatcher task instance 2: team run", lineage = the #18 problem id + its abort
   receipt. T = `mechanize/invariant-task` at ac452c7 (LOCK.sha256 168bec0c...).
   Contracts `contract://dispatcher/i2/prompt`, `contract://dispatcher/i2/lock`.
   Same roles, intents redeclared. Verifier: rehash lock, run `qualify.py`, post
   QUALIFIED + LOCKED (blocking lock change). Executor: `scripts/run-agent.sh claude
   team-i2-claude` -> RUN COMPLETE. Verifier: `grade.py` on the run -> VERDICT.
   Task Manager classifies. Budget 60 min.

## Preservation (both paths)

`mechanize/invariant-task` commits 674555e and ac452c7, `runs/codex-run-1`,
`runs/claude-run-1`, and the README runs section are read-only for the team. Team
runs write only under `runs/team-*`. The partial `runs/*-run-2` dirs from the killed
session are not graded and not touched.
