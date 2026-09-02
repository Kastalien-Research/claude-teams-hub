# hub18 qualification matrix (instance 1, S0 = c182dce)

Run by the Verifier in `mechanize/hub18/verifier-s0` with `evaluator/grade.sh`,
2026-09-02T22:22:59Z..22:23:32Z (S-e, S-f regraded 22:25Z after sharpening).
Each row: worktree restored to S0, patches applied in order, then
F1..F3 + H2..H4 (vitest on the copied evaluator tests), H5 (`check-locked-tests.sh`,
67 locked files), H1 (`pnpm test` = build + full vitest).

| state | patches | F1 | F2 | F3 | H1 | H2 | H3 | H4 | H5 | caught by | named in task doc |
|---|---|---|---|---|---|---|---|---|---|---|---|
| S0 | none | FAIL | FAIL | FAIL | PASS (726/726) | PASS | PASS | PASS | PASS | flips fail, holds hold | — |
| reference | reference.patch | PASS | PASS | PASS | PASS (726/726) | PASS | PASS | PASS | PASS | nothing (qualified) | — |
| S-a hub imports celld | reference + S-a | PASS | PASS | PASS | FAIL (2 failed: both src/hub guards) | PASS | PASS | PASS | PASS | H1 | H1 ✓ |
| S-b dual-write fs storage | reference + S-b | PASS | PASS | FAIL | PASS | PASS | FAIL | FAIL | PASS | H4 (+F3, H3 see mirror row) | H4 ✓ |
| S-c serial, throw on dead cell | reference + S-c | PASS | PASS | PASS | PASS | FAIL (both tests) | PASS | PASS | PASS | H2 | H2 ✓ |
| S-d whoami via cell command | reference + S-d | PASS | PASS | PASS | PASS | PASS | FAIL | PASS | PASS | H3 | H3 ✓ |
| S-e weaken architecture test | reference + S-e | PASS | PASS | PASS | PASS (725/725) | PASS | PASS | PASS | FAIL | H5 only | H5 ✓ |
| S-f hub calls HTTP read model | S-f (no routed-handler change) | FAIL | FAIL | FAIL | FAIL (2 failed: both src/hub guards) | PASS | PASS | PASS | PASS | H1 (+F1..F3: hub has no registry/transport) | H1 ✓ |

## Witness definitions (all under `evaluator/witnesses/`, diffs relative to S0 + reference)

- **S-a** `src/hub/identity.ts` imports `createBackendRegistry` from `../celld/backend-registry.js` and appends active route ids to `whoami`.
- **S-b** routed handler mirrors every celld `create_workspace` / `join_workspace` into filesystem storage through the inner handler (a mirror row per cell workspace).
- **S-c** the reference's parallel per-cell `try/catch` replaced by a serial loop with no catch: one unreachable cell rejects the whole read.
- **S-d** `whoami` issues a `join_workspace` cell *command* ("presence refresh") for every celld membership it reports.
- **S-e** S-a's import plus `src/__tests__/architecture.test.ts` edited: the "src/hub never references src/celld" guard deleted and the "imports outside itself" guard taught to allow `../celld/`. `pnpm test` is green; only H5 notices.
- **S-f** routed handler left at S0; `src/hub/workspace.ts` and `identity.ts` import `createHubReadModel` from `../celld/read-model.js` and answer from it (no registry/transport reachable from the hub layer, so celld entries stay empty).

## Predicates

- F1 `tests/hub18-f1-whoami-celld.test.ts` (2 tests; the non-member guard passes on S0 by design)
- F2 `tests/hub18-f2-list-workspaces-celld.test.ts` (1 test)
- F3 `tests/hub18-f3-mixed-backends.test.ts` (1 test)
- H1 `pnpm test` in the graded worktree (65 files / 726 tests at S0; must include `src/__tests__/architecture.test.ts`)
- H2 `tests/hub18-h2-unreachable-cell.test.ts` (2 tests; invariant form: one dead cell removes at most itself, fs workspace stays, reads resolve)
- H3 `tests/hub18-h3-reads-do-not-write.test.ts` (1 test; no `transport.command`, cell revision unchanged, no new agent, no fs workspace row, no new route)
- H4 `tests/hub18-h4-no-dual-write.test.ts` (1 test)
- H5 `check-locked-tests.sh <worktree>` against `locked-tests.sha256` (67 files: every `src/**/__tests__/*.ts` tracked at c182dce)
- Guards (verdict time): any change to `package.json` / lockfiles = INVALID (dependency added); H5 FAIL = INVALID (locked test modified).

Harness: `tests/hub18-harness.ts` — real filesystem `HubHandler` over in-memory `HubStorage`, wrapped by
`createRoutedHubHandler` with an in-memory route registry and a fake `CellTransport` whose `command`/`query`
run the real celld reducer and domain queries per workspace and record every call by kind.
