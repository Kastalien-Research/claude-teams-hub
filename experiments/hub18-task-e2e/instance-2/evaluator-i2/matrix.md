# hub18 qualification matrix (instance 2, S0 = c182dce)

Run by the Verifier in `mechanize/hub18/verifier-s0` with `evaluator-i2/grade.sh`,
2026-09-02T23:35:10Z (S0), 23:35:20Z (reference), 23:37:11Z..23:38:49Z (witnesses).
Each row: worktree restored to S0, patches applied in order, evaluator tests copied
into `src/celld/__tests__/`, each predicate file run alone under vitest (exit status),
copied files removed (a leftover fails the grade), then H5 (`check-locked-tests.sh`,
67 locked files) and H1 (`pnpm test` = tsc build + full vitest).

| state | patches | F1 | F2 | F3 | F4 | H2 | H3 | H4 | H6 | H7 | H1 | H5 | caught by | expected (task doc / ruling) |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| S0 | none | FAIL | FAIL | FAIL | FAIL | PASS | PASS | PASS | PASS | PASS | PASS (726/726) | PASS | flips fail, holds hold | — |
| reference | reference.patch (PR #19 d9c48e9) | PASS | PASS | PASS | PASS | PASS | PASS | PASS | PASS | PASS | PASS (738/738) | PASS | nothing (qualified) | — |
| S-a hub imports celld | reference + S-a | PASS | PASS | PASS | PASS | PASS | PASS | PASS | PASS | PASS | FAIL (2 failed: both src/hub guards) | PASS | H1 | H1 ✓ |
| S-b dual-write fs storage | reference + S-b | PASS | PASS | FAIL | FAIL | FAIL | FAIL | FAIL | PASS | FAIL | PASS | PASS | H4 (+H3, F3; mirror rows also break H2/H7/F4 before-after equality) | H4 ✓ |
| S-c serial, throw on dead cell | reference + S-c (rebased onto `cell-listing.ts`) | PASS | PASS | PASS | PASS | FAIL (3/3) | PASS | PASS | FAIL (3/3) | PASS | FAIL (4: reference's own tests) | PASS | H2, H6 | H2 ✓ |
| S-d whoami via cell command | reference + S-d (rebased onto `withCelldMemberships`) | PASS | PASS | PASS | PASS | PASS | FAIL | PASS | PASS | PASS | FAIL (3) | PASS | H3 | H3 ✓ |
| S-e weaken architecture test | reference + S-e | PASS | PASS | PASS | PASS | PASS | PASS | PASS | PASS | PASS | PASS (737/737) | FAIL | H5 only | H5 ✓ |
| S-f hub calls HTTP read model | S-f alone (hub hunks; routed handler at S0) | FAIL | FAIL | FAIL | FAIL | PASS | PASS | PASS | PASS | PASS | FAIL (2 failed: both src/hub guards) | PASS | H1 (+F1..F4: hub has no registry/transport) | H1 ✓ |
| S-g instance-1 Claude PASS diff (serial loop, unchecked cast) | S-g alone | PASS | PASS | PASS | FAIL | PASS | PASS | PASS | FAIL (3/3) | FAIL (11/11 tests: all 8 MCP cases + HTTP `{}`/`[]`/missing-members) | PASS (734/734) | PASS | H6, H7, F4 | fails H6 and H7 ✓ |
| S-h instance-1 Codex PASS diff (serial loop, unchecked cast in `readCelldWorkspaces`) | S-h alone | PASS | PASS | PASS | FAIL | PASS | PASS | PASS | FAIL (3/3) | FAIL (11/11, same as S-g) | PASS (726/726) | PASS | H6, H7, F4 | fails H6; H7 to be recorded: **FAIL** |
| S-i timeout lowered instead of overlapping | reference + S-i | PASS | PASS | PASS | PASS | PASS | PASS | PASS | FAIL (3/3, max in-flight 1) | PASS | FAIL (1: reference's `cell-listing` concurrency test) | PASS | H6 only | H6 in-flight count ✓ |
| S-j catch-all returning empty list | reference + S-j | PASS | PASS | PASS | FAIL | FAIL (3/3) | PASS | PASS | PASS | FAIL | FAIL (4) | PASS | H2, H7, F4 | H2/H7 ✓; **F1..F3 do not catch it** (the happy path never reaches the catch-all) |

H6 determinism (stop rule: in-flight count only, no wall-clock assertion, 2..8 ms setTimeout delays):
reference 5 consecutive runs 5/5 PASS (23:34:16Z..23:34:20Z); S0 5/5 PASS (vacuous: S0 issues no
snapshot for these reads); S-g 5 consecutive runs 5/5 FAIL, 3 failed tests each (23:38:0xZ). One attempt.

## Witness definitions (all under `evaluator-i2/witnesses/`)

- **S-a** `src/hub/identity.ts` imports `createBackendRegistry` from `../celld/backend-registry.js` and appends active route ids to `whoami`. (instance-1 file, applies unchanged on the reference)
- **S-b** routed handler mirrors every celld `create_workspace` / `join_workspace` into filesystem storage through the inner handler. (instance-1 file, applies with offset)
- **S-c** `listActiveCells` in `src/celld/cell-listing.ts` rewritten as a serial loop with no `try/catch`: one unreachable cell rejects the whole read. (rebased)
- **S-d** `withCelldMemberships` in `src/celld/routed-handler.ts` issues a `join_workspace` cell *command* ("presence refresh") for every membership it reports. (rebased)
- **S-e** S-a's import plus `src/__tests__/architecture.test.ts` edited so `pnpm test` stays green; only H5 notices. (instance-1 file)
- **S-f** routed handler left at S0; `src/hub/workspace.ts` and `identity.ts` answer from `createHubReadModel` imported from `../celld/read-model.js`. Instance-1 patch reduced to its two hub hunks (its routed-handler hunk was a revert of the instance-1 reference and does not apply here).
- **S-g** `mechanize/hub18/runs/claude-run-1/diff.patch` (instance-1 PASS) as delivered by the Task Manager: serial snapshot loop in `cell-listing.ts`, `snapshot.state as CellWorkspaceState` unchecked.
- **S-h** `mechanize/hub18/runs/codex-run-1/diff.patch` (instance-1 PASS) as delivered: serial loop in `readCelldWorkspaces` (`read-model.ts`), unchecked cast, field access outside the per-cell guard.
- **S-i** reference's `listActiveCells` made serial, each snapshot raced against a 50 ms timer and treated as unreachable on timeout; per-cell `try/catch` and validation kept. Bounded per cell, still N × timeout overall; the transport never sees two requests overlap.
- **S-j** reference's `listActiveCells` without per-cell `try/catch` or validation, plus a `try/catch` around the whole whoami/list_workspaces merge in `routed-handler.ts` that answers `{ ...inner, workspaces: [] }` on any error.

## Predicates

- F1 `tests/hub18-f1-whoami-celld.test.ts` (2 tests; the non-member guard passes on S0 by design) — instance-1 file, unchanged
- F2 `tests/hub18-f2-list-workspaces-celld.test.ts` (1 test) — unchanged
- F3 `tests/hub18-f3-mixed-backends.test.ts` (1 test) — unchanged
- F4 `tests/hub18-f4-http-missing-workspace-id.test.ts` (1 test) — HTTP read model listing with one cell answering 200 and a state missing `workspace.id`: that route exactly `{ id, backend: 'celld', unreachable: true }`, others unchanged, no throw. Reclassified from H7 by Task Manager ruling `chg:tm2-change-h7-f4` (2026-09-02T23:33:56Z) because S0's `read-model.ts` emits an `{ id: undefined, ... }` row for that body (nothing throws, so its per-route catch never fires). Assertions byte-identical to H7's HTTP case.
- H1 `pnpm test` in the graded worktree (65 files / 726 tests at S0; must include `src/__tests__/architecture.test.ts`)
- H2 `tests/hub18-h2-unreachable-cell.test.ts` (3 tests; rewritten). Invariant form over before/after reads: neither read throws; the outage removes no row from `list_workspaces`; rows other than the dead cell are unchanged; any row carrying the dead cell's id is exactly `{ id, backend: 'celld', unreachable: true }`; `whoami` after == before minus the dead cell. With F2/F3 this is the contract's H2 (placeholder row exact shape, whoami omits, reachable one in full).
- H3 `tests/hub18-h3-reads-do-not-write.test.ts` (1 test) — unchanged
- H4 `tests/hub18-h4-no-dual-write.test.ts` (1 test) — unchanged
- H5 `check-locked-tests.sh <worktree>` against `locked-tests.sha256` (67 files: every `src/**/__tests__/*.ts` tracked at c182dce) — unchanged
- H6 `tests/hub18-h6-bounded-latency.test.ts` (3 tests). N = 4 active cells, each snapshot resolving (or, for two cells in the third test, rejecting) after a 2..8 ms `setTimeout` in the fake transport, slowest route first. Decided by the transport's in-flight counter: if the read snapshots any cell, it snapshots every active cell and `maxInFlight === N`; the read resolves; celld rows / memberships keep route order. No wall-clock assertion. Vacuous on S0 (no snapshots issued).
- H7 `tests/hub18-h7-malformed-response.test.ts` (11 tests + 1 skipped). Bodies `{}`, `[]`, state missing `members`, state missing `workspace.id`; for each, MCP `list_workspaces` (placeholder exact, others unchanged, no row disappears, no throw) and `whoami` (omits the broken cell, keeps the rest). HTTP read model listing (`createHubReadModel().listWorkspaces()` from `src/celld/read-model.ts`, a seam that exists at S0) for `{}`, `[]`, missing `members`; the missing-`workspace.id` HTTP case is skipped here and lives in F4.
- Guards (verdict time): any change to `package.json` / lockfiles = INVALID (dependency added); H5 FAIL = INVALID (locked test modified).

Harness: `tests/hub18-harness.ts` — instance-1 harness (real filesystem `HubHandler` over in-memory `HubStorage`, wrapped by
`createRoutedHubHandler` with an in-memory route registry and a fake `CellTransport` running the real celld reducer/queries)
plus, for this instance: per-workspace snapshot delay (`setSnapshotDelay`), per-workspace 200-with-body override
(`setSnapshotBody`), in-flight / max-in-flight counters (`inFlight`, `maxInFlight`, `resetInFlight`), and
`httpListWorkspaces()` composing `createHubReadModel` over the same storage/registry/transport.

## Evaluator portability

Scripts are bash (3.2-compatible) + coreutils + `git` + `pnpm`: `cp`, `rm -f` of the exact copied files (a leftover exits 3),
`find`, `sort`, `xargs`, `shasum`, `sed`, `grep`, `tr`, `cut`, `diff`, `wc`, `cmp`. No `trash`, `rg`, `python3`, `jq`.
Every script runs under `set -euo pipefail`. `make-manifest.sh` hashes paths relative to the parent of `evaluator-i2`
(e.g. `evaluator-i2/grade.sh`), so the lock reproduces after the folder is moved; the task contract is covered through
`evaluator-i2/TASK-instance-2.md` (byte copy of `mechanize/hub-issue-18-task-instance-2.md`). `check-lock.sh` recomputes
the manifest and compares with `LOCK.sha256`. Grading outputs go to `$GRADE_OUT` (default `../grading-i2`), never inside
`evaluator-i2`.
