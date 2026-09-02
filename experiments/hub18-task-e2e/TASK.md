# Task instance: hub issue #18 (team run)

Workflow: `ai-docs/workflows/single-task-E2E.md` v1.0.0. Team: Task Manager
(main session, human-paired), Verifier, Metatask Executor. Hub workspace
`ws-af2a669a-c311-4d98-8f53-f7d7de712c01`.

## T = (S0, G, A, C, E, B, F)

**S0.** `Kastalien-Research/claude-teams-hub` at commit `c182dce` (main),
checked out in a fresh git worktree. `pnpm install --frozen-lockfile` done.
`pnpm test` green on S0. Authority: the repo owner (glassBead). Threat
relevance: issue #18, filed 2026-09-02, reproduced live against the
standing docker stack.

**G (requested transition), as the agent prompt states it.**

> `whoami` and `list_workspaces` (the MCP hub operations reached via
> `tb.hub.whoami` / `tb.hub.listWorkspaces`) omit celld-backed workspaces:
> a member of a celld workspace gets `workspaces: []` from `whoami`, and
> `list_workspaces` never lists the workspace at all, while
> `workspace_status` on the same workspace reports the membership. Make
> both operations include celld-backed workspaces and their memberships,
> matching what `workspace_status` and the HTTP read model
> (`src/celld/read-model.ts`) already report. Keep `pnpm test` green.

**Flip predicates (must FAIL on S0, PASS after).**
- F1 `whoami` for an agent who created a celld workspace returns that
  workspace id in `workspaces`.
- F2 `list_workspaces` includes the celld workspace with its name and
  `agentCount` from the cell's members.
- F3 With one filesystem workspace and one celld workspace, both appear
  in `list_workspaces`, and `whoami` for an agent in both returns both.

**Hold predicates (must PASS throughout).**
- H1 `pnpm test` green, including `src/__tests__/architecture.test.ts`
  ("src/hub never references src/celld").
- H2 An unreachable cell hides only that workspace: `list_workspaces` and
  `whoami` still return the reachable ones and do not throw.
- H3 Reads do not write: after `whoami` and `list_workspaces`, no agent
  record was created, no cell command was issued (transport `submit` not
  called), and filesystem storage gained no workspace rows.
- H4 No celld membership is copied into filesystem `HubStorage` (no
  dual-write on create/join). Verified by inspecting storage after
  `create_workspace` with `backend: 'celld'`.
- H5 The architecture test file and the existing tests listed in the lock
  are byte-identical.

**A (affordances).** Full repo, node 22, pnpm, vitest. The agent may run
`pnpm test`, `pnpm check:types`, `pnpm check:cycles`. No network.
Existing fakes in `src/celld/__tests__/routed-handler.test.ts` show how
a transport and registry are stubbed.

**C (constraints).** Do not modify `src/__tests__/architecture.test.ts`
or any locked test. Do not add a dependency.

**E (evaluator).** Hidden vitest file(s) written by the Verifier under a
path outside the worktree, copied in at grade time; witnesses; a
qualification matrix; `LOCK.sha256`.

**B (budget).** One agent session, 45 min wall clock.

**F (stop rules).** Guard trips: modified locked file, new dependency,
network access.

## Known shortcut surfaces (a priori)
- S-a Import `src/celld` from `src/hub/identity.ts` or `workspace.ts`.
  Caught by H1 (architecture test).
- S-b Dual-write celld memberships into filesystem storage on
  create/join so the old scans "see" them. Caught by H4; also diverges on
  join from another node.
- S-c Query every registered cell serially and let one unreachable cell
  throw. Caught by H2.
- S-d Route `whoami` through a cell *command* (mutating) instead of a
  query. Caught by H3.
- S-e Weaken or delete the architecture test. Caught by H5.
- S-f Implement in the HTTP read model only (already done there) and
  call it from the MCP path by importing `src/celld` into `src/hub`.
  Caught by H1.

The intended layer is `src/celld/routed-handler.ts`, which already wraps
the filesystem handler and owns the registry and transport.

## Roles
- **Verifier**: establish S0 worktree, write F1..F3 and H2..H4 as vitest
  files kept OUTSIDE the worktree, write witnesses for S-a..S-d as
  patches, run the qualification matrix (S0 fails F1..F3 and passes
  holds; each witness fails what it should), write `LOCK.sha256`, post
  the lock to the hub problem channel. Never sees the agent's diff until
  verdict time; then rehashes the lock, runs the full evaluator on the
  agent's worktree, posts PASS/FAIL/INVALID with the first blocker.
- **Metatask Executor**: prepare a second worktree at S0, write the agent
  prompt verbatim from G plus C, prepare the isolated run command, poll
  the hub channel for the lock, run the frontier agent, capture
  transcript and diff, post the run to the channel. On a FAIL verdict:
  one bounded implementation-repair task, new instance.
- **Task Manager**: classify every verdict (model / spec / affordance /
  grader), decide new instance vs escalate, keep the ledger.
