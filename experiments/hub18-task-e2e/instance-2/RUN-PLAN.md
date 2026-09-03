# Team run plan: hub issue #18, instance 2 (2026-09-02)

Task: `mechanize/hub-issue-18-task-instance-2.md`. Workflow: Task E2E v1.0.0.
Hub problem `prob:create-problem-hub-issue-18-instance-2`, workspace
`ws-af2a669a-c311-4d98-8f53-f7d7de712c01`, teamRunId `hub18-i2-2026-09-02`.
Lineage: instance 1 (`prob:create-problem-hub-issue-18-instance-1`, lock 9e829501, 2/2
PASS, never relaxed). Roles and identities unchanged: Task Manager 24e801d8 (lead
session), Verifier 678bd926, Executor 0254ce21 (separate sessions, own channels).

Contracts: `contract://hub18/i2/prompt`, `contract://hub18/i2/lock`.
Intents: Verifier writes `mechanize/hub18/evaluator-i2`, reads `mechanize/hub18/runs-i2`;
Executor writes `mechanize/hub18/runs-i2` and `mechanize/hub18/executor-s0`, reads
`mechanize/hub18/evaluator-i2/LOCK.sha256`; both cite both contracts.

## What this instance is for (and is not)

It is for finding out whether the strengthened contract distinguishes previously
accepted behaviour: prior PASS diffs become witnesses, H6/H7 get measured, a fresh
solver gets a decisive verdict. It is NOT for manufacturing a FAIL. A clean PASS on a
fresh run is evidence too. Nobody tunes a predicate toward a verdict.

## Inputs prepared by the Task Manager

- `mechanize/hub18/i2/reference-pr19.patch`: PR #19 at d9c48e9 vs c182dce (instance-1
  Claude diff + concurrency/validation fix). Candidate reference; the Verifier must
  confirm it passes everything before using it as such.
- `mechanize/hub18/i2/witness-S-g-claude-run-1.patch`, `witness-S-h-codex-run-1.patch`:
  the instance-1 PASS diffs.
- `mechanize/hub18/i2/instance-1-witnesses/`: S-a..S-f from instance 1 (written on top
  of the instance-1 reference; may need rebasing onto the new reference).
- Worktrees `verifier-s0` and `executor-s0` clean at c182dce with node_modules.

## Stages (post each as `STAGE <id> PASS|FAIL <evidence, ISO time>`)

Verifier: V1 S0 + intent + READY. V2 flips F1..F3 (may reuse instance-1 files) FAIL on
S0. V3 holds H2 (rewritten), H3, H4, H6, H7 written; all PASS on S0 (H6/H7 hold on S0
because S0 has no celld merge at all; that is fine, they are holds). V4 reference:
apply `reference-pr19.patch`; F1..F3 PASS, H1..H7 PASS. V5 witnesses S-a..S-j; matrix.
V6 lock: layout-independent `make-manifest.sh` (paths relative to evaluator-i2's
parent), `LOCK.sha256`, `LOCKED <sha>`, BLOCKING change on the lock contract.
Portability check: run `grade.sh` once with `PATH=/usr/bin:/bin` and post the result.

Executor: E1 S0 + PROMPT.md (instance-1 G verbatim + the instance-2 paragraph + C +
affordance note) + intent + READY. E2 isolated command dry-run (as instance 1). E3/E4
after the lock impact: claude-fable-5-1 run, RUN COMPLETE + advisory change; then
gpt-5.6-sol run, RUN COMPLETE + advisory change. No repair task this instance.

Verifier grading: as instance 1, per run, `VERDICT <PASS|FAIL|INVALID> <first blocker>`.
A FAIL whose first blocker is H6 or H7 is a normal FAIL (implementation), not a
contract gap: the contract states them explicitly this time.

## Stop rules (predefined; ruthless)

- **H6 measurability.** H6 must be decided by the fake transport's in-flight count,
  with no wall-clock assertion and no sleeps longer than a few ms. The Verifier gets
  at most TWO attempts (or 20 minutes, whichever first) to make H6 deterministic
  across 5 consecutive runs. If it cannot: post `FINDING UNQUALIFIED H6 <why>`, drop
  H6 from the lock, continue with H7 and the rest, and say so in the lock message.
  Do not "fix it until it works".
- **Lock deadline T0 + 60 min.** No `LOCKED` by then -> Task Manager posts
  `ABORT lock-deadline`, records the instance as UNQUALIFIED or BLOCKED with cause and
  stage, evaluator-i2 is preserved as is, no solver runs.
- **Hard freeze T0 + 90 min.** Whatever state exists is recorded and shipped: runs in
  progress are killed and marked `FROZEN`, ungraded runs stay ungraded, the ledger is
  exported, the problem is closed with a receipt naming the stage. No extensions.
- Instance-1 artifacts are read-only. Nothing in `evaluator/`, `runs/`, or the
  published lock changes.

## Task Manager duties

Record the lineage decision before T0. Classify every verdict. At the end (or at the
freeze): export the ledger to `mechanize/hub18/ledger-i2.json`, resolve or close the
problem with a receipt, and publish `instance-2/` in the experiments folder as a new
PR whatever the outcome.
