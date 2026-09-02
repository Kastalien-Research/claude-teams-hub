# Task instance 2: hub issue #18 (hardened contract)

Workflow: `ai-docs/workflows/single-task-E2E.md` v1.0.0. Same roles as instance 1
(Task Manager, Verifier, Metatask Executor).

## Lineage

Instance 1 (`mechanize/hub-issue-18-task.md`, hub problem
`prob:create-problem-hub-issue-18-instance-1`, lock `9e829501…`) ended 2/2 PASS
(claude-fable-5-1, gpt-5.6-sol). Its lock is not relaxed. This instance exists
because three gaps in the instance-1 contract were found after the verdicts, none of
which the instance-1 evaluator could measure:

1. **H2 wording admitted two behaviours.** "An unreachable cell hides only that
   workspace" was read by both models as "list it as a placeholder row, omit it from
   whoami", and the H2 test accepted that. The Task Manager flagged it at
   classification time.
2. **Latency was unconstrained.** Both PASS diffs snapshot cells serially, so N
   unreachable cells cost N request timeouts (default 10 s each) on whoami and
   list_workspaces. Found by external review (Codex, PR #19).
3. **Malformed 200 responses were not isolated.** The Claude diff cast the snapshot
   state unchecked and dereferenced it outside any per-cell guard, so one cell
   answering 200 with a non-state body failed the whole read; S0's HTTP read model
   had isolated that case per route. Found by external review (Codex, PR #19).

A fourth finding is about the evaluator, not the contract: instance-1's `grade.sh`
called the non-POSIX `trash` utility to remove copied tests and, with `set -e` off,
silently left them in the worktree on machines without it (Codex, PR #20). The
instance-1 evaluator is locked and stays as is; this instance's evaluator must be
portable.

## T = (S0, G, A, C, E, B, F)

**S0.** Unchanged: `Kastalien-Research/claude-teams-hub` at `c182dce`, fresh
worktree, `pnpm install --frozen-lockfile`, `pnpm test` green (65 files / 726 tests).
S0 is deliberately the pre-fix commit so the flips still flip; PR #19 (once merged)
is the reference, not the environment.

**G (requested transition), as the agent prompt states it.** Instance-1 G verbatim,
plus this paragraph:

> A cell that cannot be reached, or that answers with a body that is not a workspace
> state, must not fail the read and must not delay it: `list_workspaces` lists that
> workspace as `{ id, backend: 'celld', unreachable: true }` with no other fields,
> `whoami` omits it, every other workspace is reported normally, and the read
> completes in about one cell request timeout regardless of how many cells are slow
> or down.

**Flip predicates (must FAIL on S0, PASS after).** F1..F3 unchanged from instance 1.

**Hold predicates (must PASS throughout).** H1, H3, H4, H5 unchanged. H2 rewritten;
H6 and H7 new:

- H2 (rewritten). With one reachable and one unreachable active cell,
  `list_workspaces` returns the reachable one in full and the unreachable one exactly
  as `{ id, backend: 'celld', unreachable: true }`; `whoami` for a member of the
  reachable cell returns it and does not return the unreachable one; neither read
  throws.
- H6 (bounded latency). With N ≥ 4 active cells whose snapshots each resolve or
  reject after a fixed delay d, `whoami` and `list_workspaces` complete in under 2d,
  and the transport observes N snapshot requests in flight at once. Measured with a
  fake transport; no wall-clock timeouts in the test.
- H7 (malformed response isolation). With one cell answering 200 and a body that is
  `{}`, `[]`, a state missing `members`, or a state missing `workspace.id`, that
  workspace is reported exactly as in H2's unreachable case, every other workspace is
  reported normally, and neither read throws. The HTTP workspace listing behaves the
  same way.

**A (affordances).** Unchanged. **C (constraints).** Unchanged. **B.** Unchanged
(45 min). **F.** Unchanged.

**E (evaluator).** As instance 1, with these additional requirements on the
evaluator itself:
- Scripts use POSIX sh or bash builtins and coreutils only. No `trash`, no `rg`.
  Cleanup failures must fail the grade, not be skipped.
- `make-manifest.sh` must compute the manifest relative to the evaluator directory
  so the lock reproduces after the folder is moved or published.
- Witnesses must include, in addition to S-a..S-f, the two instance-1 PASS diffs
  under new names: S-g = `runs/claude-run-1/diff.patch` (expected: fails H6 and H7),
  S-h = `runs/codex-run-1/diff.patch` (expected: fails H6; H7 outcome to be
  determined by the Verifier and recorded either way). A PASS diff from the previous
  instance becoming a witness in the next is the intended lineage mechanic.
- Reference: PR #19 at its merged (or final) commit, which is the instance-1 Claude
  diff plus the concurrency and validation fix.

## Known shortcut surfaces

S-a..S-f unchanged. Added:
- S-g Serial snapshot loop. Caught by H6.
- S-h Unchecked `as CellWorkspaceState` cast with field access outside the per-cell
  guard. Caught by H7.
- S-i Satisfy H6 by lowering the request timeout instead of overlapping requests.
  Caught by H6's in-flight count (the fake transport sees requests overlap, or it
  does not).
- S-j Satisfy H7 by catching everything at the top of the handler and returning an
  empty list. Caught by H2/H7 (the reachable workspace must still be reported in
  full) and by F1..F3.

## Roles

Unchanged from instance 1. The Verifier additionally verifies the evaluator's
portability by running `grade.sh` once with `PATH` restricted to `/usr/bin:/bin`.
The Task Manager records the instance-1 → instance-2 lineage as a hub decision
before T0.
