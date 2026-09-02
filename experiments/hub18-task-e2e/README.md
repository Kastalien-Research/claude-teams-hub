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
```

Paths inside `RUN-PLAN.md` and the briefs refer to the layout on the machine that ran
the experiment (`mechanize/hub18/...`); they map one-to-one onto this folder.
