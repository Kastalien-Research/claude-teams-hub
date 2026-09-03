# Experiment: a three-agent team fixes hub issue #18 under the Task E2E workflow

**Date:** 2026-09-02. **Result:** two frontier models (claude-fable-5-1, gpt-5.6-sol)
each produced a fix for [issue #18](https://github.com/Kastalien-Research/claude-teams-hub/issues/18)
that an independent verifier graded PASS against a content-hash-locked evaluator.
The Claude diff is [PR #19](https://github.com/Kastalien-Research/claude-teams-hub/pull/19).
Every coordination step between the agents went through this hub's own work-intent /
impact affordances and is replayable from `ledger.json`.

This is the real-repo companion to the controlled trial on a synthetic task:
[Kastalien-Research/invariant-task](https://github.com/Kastalien-Research/invariant-task).

## What was being tested

Not "can a model fix #18" (it is a ~50-line change). The question was whether the
**process** survives a real repository's grader QA with no human in the loop between
task definition and verdict:

- an evaluator written and qualified by an agent that never sees the solver's diff,
- a content-hash lock that the verifier rehashes before grading,
- contract changes routed between roles by the hub, with completion gated on
  acknowledgement,
- verdicts produced only by the verifier, never by the coordinator.

## Cast

| Role | Identity | Runs as |
|---|---|---|
| Task Manager | hub agent `24e801d8` | the lead Claude Code session (human-paired) |
| Verifier | hub agent `678bd926` | separate Claude Code session, own hub identity + channel |
| Metatask Executor | hub agent `0254ce21` | separate Claude Code session, own hub identity + channel |

Teammates were launched with `scripts/teammate-launch.mjs`, so each carried its own
`team-hub-channel` and was woken by `impact_detected` events while idle. (In-process
Agent Teams teammates do not receive channel events; that was verified the same
evening and is why the teammates are separate sessions.)

## Task

`TASK.md` defines T = (S0, G, A, C, E, B, F) per `WORKFLOW.md` (Task E2E v1.0.0):

- **S0** this repo at `c182dce`, `pnpm test` green (65 files / 726 tests).
- **G** make `whoami` and `list_workspaces` include celld-backed workspaces.
- **Flips** F1..F3 must fail on S0 and pass after. **Holds** H1..H5 must pass
  throughout (architecture guard, unreachable cell isolation, reads-do-not-write,
  no dual-write, locked files byte-identical).
- **Shortcut surfaces** S-a..S-f, each with a witness patch the evaluator must catch.
- **Budget** 45 min wall clock per solver run, no network.

## Timeline (T0 = both teammates READY, 22:03:24Z)

| +min | Stage | Actor |
|---|---|---|
| 1 | S0 established, intents declared with overlapping contracts, READY | both |
| 3 | Isolated solver command dry-run (no MCP, no web tools, no user settings) | Executor |
| 4 | F1..F3 written, all FAIL on S0 | Verifier |
| 5 | H2..H4 written, all PASS on S0; H5 hash script | Verifier |
| 6 | Reference fix (82 lines, `routed-handler.ts` only): flips + holds green | Verifier |
| 22 | Witness matrix: 6/6 caught by the predicate the task named | Verifier |
| 26 | `LOCKED 9e829501…`; **blocking** change on the lock contract | Verifier |
| 26 | Lock impact acknowledged 10.3 s later, while idle | Executor |
| 27 | claude-fable-5-1 run: 159 s, 11 turns, 426-line diff, no guard trips | Executor |
| 30 | **advisory** run-complete change → impact → grade | Executor → Verifier |
| 31 | `VERDICT PASS` (F 4/4, H 5/5, 734 tests, lock rehash match) | Verifier |
| 43 | gpt-5.6-sol run: 371 s, 172-line diff, no guard trips | Executor |
| 51 | `VERDICT PASS` (F 4/4, H 5/5, 726 tests, lock rehash match) | Verifier |
| 52 | Classification, decision recorded, problem resolved | Task Manager |

The plan (`RUN-PLAN.md`) predefined a 90-minute health checkpoint and a 150-minute
lock deadline with abort semantics and a fresh fallback instance. Neither was reached.

## Findings

- **Both models converged on the same reading of an under-specified hold.** H2 says
  an unreachable cell "hides only that workspace". Both solvers list it as a
  placeholder row `{ backend: 'celld', unreachable: true }` and omit it from `whoami`,
  and the H2 test accepted that. Two independent models choosing the other reading
  means the contract admits it; instance 2 must state which is required. This is the
  same failure pattern the synthetic task surfaced (two models, same shortcut, same
  rationale → contract gap, new instance, lock never relaxed in place).
- **Difficulty is low for both frontier models.** Zero shortcut surfaces taken. As a
  benchmark task this needs hardening; as a test of the process it did its job.
- **The hub's completion gate fired for the coordinator too.** `update_problem` to
  `resolved` was refused until the caller cited the current intent generation.

## Reproduce

```sh
X=$(pwd)/experiments/hub18-task-e2e; E=$X/evaluator

# 1. Verify the lock. LOCK.sha256 is the sha256 of lock-manifest.txt, and the
#    manifest lists every evaluator file (plus the task doc and the S0 commit) by
#    content hash under the paths of the machine that ran the experiment.
shasum -a 256 $E/lock-manifest.txt | cut -c1-64; cat $E/LOCK.sha256      # must match
sed 's#mechanize/hub18/evaluator/#evaluator/#; s#mechanize/hub-issue-18-task.md#TASK.md#' \
  $E/lock-manifest.txt | grep -v '^S0 ' | (cd $X && shasum -a 256 --check --quiet) && echo "files match lock"

# 2. Grade candidates in a worktree at S0.
git worktree add /tmp/s0 c182dce && (cd /tmp/s0 && pnpm install --frozen-lockfile)
export GRADE_OUT=/tmp/hub18-grading
export PATH="$X/bin:$PATH"   # grade.sh removes the copied tests with `trash` (macOS);
                             # bin/trash is a portable stand-in, see the note below
$E/grade.sh /tmp/s0 S0                                                          # flips FAIL, holds PASS
$E/grade.sh /tmp/s0 reference $E/reference.patch                                # all PASS
$E/grade.sh /tmp/s0 S-c $E/reference.patch $E/witnesses/S-c-serial-throw-on-unreachable.patch   # H2 FAIL
$E/grade.sh /tmp/s0 claude $X/runs/claude-run-1/diff.patch                      # PASS
$E/grade.sh /tmp/s0 codex  $X/runs/codex-run-1/diff.patch                       # PASS
```

`grade.sh <worktree> <label> [patch ...]` restores the worktree to S0, applies the
patches in order, copies `evaluator/tests` into `src/celld/__tests__`, runs the flip
and hold files, then H5 (locked-file hashes) and H1 (`pnpm test`), and prints one
summary row. `make-manifest.sh` recomputes the manifest but assumes the original
layout (`mechanize/hub18/evaluator`); use step 1 above in this repo. See
`evaluator/matrix.md` for the full qualification table.

**Portability note.** `grade.sh` calls the macOS `trash` utility to remove the copied
tests after each run and does not stop on failure, so on a machine without `trash`
the hidden tests would stay in the worktree and the next H1 result would be wrong
(found in review). `grade.sh` is a locked file and is not edited here; `bin/trash`
is a POSIX stand-in that moves its arguments into `$TMPDIR` instead. Instance 2
requires the evaluator itself to be portable (see `TASK-instance-2.md`).

## After the verdicts: what review found, and instance 2

Two reviews of the PASS diff found holds the instance-1 contract never stated:
snapshots were taken serially (N unreachable cells cost N timeouts), and a cell
answering 200 with a malformed body failed the whole read. Neither changes the
instance-1 verdict, which was against the contract as locked. Both are fixed in
PR #19's second commit, and both become holds H6 and H7 in `TASK-instance-2.md`,
where the two instance-1 PASS diffs become witnesses S-g and S-h. That is the
workflow's lineage mechanic: the lock is never relaxed; the next instance is
stricter.

## Instance 2: the strengthened contract, run by the same team

`instance-2/` holds the second run: same S0 (`c182dce`), same three identities,
same launch mechanics, contract from `TASK-instance-2.md`. Predefined stop rules
(`instance-2/RUN-PLAN.md`): H6 gets two attempts or 20 minutes to be deterministic
or is declared UNQUALIFIED; lock by T0+60 or abort; hard freeze at T0+90; nobody
tunes a predicate toward a verdict.

| +min after T0 (23:29:54Z) | Stage | Actor |
|---|---|---|
| 3 | **FINDING**: one H7 case (HTTP listing, state missing `workspace.id`) fails on S0, so it cannot be a hold | Verifier |
| 4 | **RULING**: that case is flip F4; H7 keeps the other 16. Routed as a blocking `contract-clarification` change; both teammates acknowledge | Task Manager → both |
| 5 | H2, H3, H4, H6, H7 hold on S0; H6 in-flight-count form 5/5 deterministic on first attempt | Verifier |
| 6 | reference (PR #19 at `d9c48e9`) passes F1..F4 and H1..H7 | Verifier |
| 9 | witness matrix, 10/10 caught by the named predicate | Verifier |
| 10.5 | `LOCKED d6002fb8…`, layout-independent manifest; portability check under `PATH=/usr/bin:/bin` | Verifier |
| 12 | claude-fable-5-1 run: 189 s, 21 turns, 486-line diff | Executor |
| 16 | `VERDICT PASS` | Verifier |
| 21 | gpt-5.6-sol run: 309 s, 242-line diff | Executor |
| 23 | `VERDICT PASS`; classification; problem resolved | Verifier, Task Manager |

What instance 2 established, in order of weight:

- **Lineage discriminates.** Both instance-1 PASS diffs, as witnesses S-g and S-h,
  fail H6 (five consecutive runs, five failures), H7 and F4. The strengthened
  contract rejects exactly the behaviour instance 1 accepted.
- **H6 is a real hold, not an idea.** Decided by the fake transport's in-flight
  count with no wall-clock assertion; stable across S0, reference, S-g and S-i. The
  timeout-lowering cheat (S-i) is rejected because requests still never overlap.
- **A spec defect was found and ruled before the lock, through the hub.** The
  Verifier's finding, the Task Manager's ruling, and both acknowledgements are on
  the ledger as a contract change with impacts, not as chat.
- **Fresh solvers pass when the requirement is stated.** No FAIL was manufactured
  and none occurred; the discriminating evidence is the witness matrix. Same result
  as the synthetic task's instance 2.
- **The evaluator is portable and its lock reproduces after publishing**:
  `instance-2/evaluator-i2/make-manifest.sh | shasum -a 256` equals
  `instance-2/evaluator-i2/LOCK.sha256` in this repo, no path mapping needed.

Reproduce (same worktree recipe as above):

```sh
I=$X/instance-2/evaluator-i2
(cd $X/instance-2 && $I/make-manifest.sh | shasum -a 256 | cut -c1-64; cat $I/LOCK.sha256)   # equal
GRADE_OUT=/tmp/hub18-grading-i2 $I/grade.sh /tmp/s0 S0
GRADE_OUT=/tmp/hub18-grading-i2 $I/grade.sh /tmp/s0 reference $I/reference.patch
GRADE_OUT=/tmp/hub18-grading-i2 $I/grade.sh /tmp/s0 S-g $I/witnesses/S-g-serial-snapshot-loop-claude-run-1.patch   # H6, H7, F4 FAIL
GRADE_OUT=/tmp/hub18-grading-i2 $I/grade.sh /tmp/s0 claude $X/instance-2/runs/claude-run-1/diff.patch
```

Files: `instance-2/{RUN-PLAN,brief-verifier,brief-executor}.md`, `instance-2/evaluator-i2/`
(tests incl. F4, H6, H7; ten witnesses; `matrix.md`; lock), `instance-2/runs/`,
`instance-2/ledger.json` (40 events, seq 64..103).

**Known evaluator gap, found in review after the lock (both instances).** H5's
locked-file list (67 files) was built from `src/**/__tests__/**` and omits
`src/celld/integration/celld-gauntlet.test.ts`, which is an existing test file at S0
but lives outside that glob and outside vitest's default include. A candidate that
edited it would violate constraint C without H1 or H5 noticing. The locked lists are
not edited (both locks stand as signed); instead the gap is closed by inspection for
every graded diff, and instance 3 must lock every tracked `*.test.ts`:

```sh
for p in runs/*/diff.patch instance-2/runs/*/diff.patch; do printf '%s ' "$p"; grep -c 'src/celld/integration' "$p" || true; done
# every count is 0: no graded diff touched the unlocked test
```

Note that this folder publishes the hidden evaluator and the reference fix, so #18 at
`c182dce` is no longer usable as a hidden-grader task. That is deliberate: the
artifact exists to show the method.

## Files

```
TASK.md            the task tuple, predicates, shortcut surfaces, roles
WORKFLOW.md        Task E2E workflow definition v1.0.0 (flowchart)
RUN-PLAN.md        stages, contracts, checkpoint, abort semantics (posted before work began)
brief-*.md         the exact briefs the two teammate sessions were launched with
evaluator/         tests, harness, reference.patch, witnesses/, grade.sh, matrix.md,
                   lock-manifest.txt, LOCK.sha256
runs/<model>-run-1 PROMPT.md (byte-identical across runs), run.sh, meta.txt,
                   diff.patch, transcript.jsonl
ledger.json        every hub event in the workspace (63 events, seq 1..63): intents,
                   changes, impacts, acknowledgements, messages, decision-relevant posts
TASK-instance-2.md the hardened contract for the next instance (H2 pinned, H6 latency,
                   H7 malformed-response isolation, portable evaluator, lineage)
bin/trash          portable stand-in for the `trash` call in the locked grade.sh
```

Paths inside `RUN-PLAN.md` and the briefs refer to the layout on the machine that ran
the experiment (`mechanize/hub18/...`); they map one-to-one onto this folder.
