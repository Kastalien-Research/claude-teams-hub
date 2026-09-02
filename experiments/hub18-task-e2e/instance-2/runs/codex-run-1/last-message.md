Implemented celld-aware MCP reads.

- `whoami` now includes valid celld workspace memberships and omits unreachable/malformed cells.
- `list_workspaces` includes celld summaries; failures produce exactly `{ id, backend: 'celld', unreachable: true }`.
- Cell snapshots run concurrently, bounding latency to roughly one request timeout.
- HTTP workspace listing now shares the same validation and concurrency logic.
- No dependencies or tests changed.

Key files: [workspace-state-reader.ts](/Users/b.c.nims/dev/employment-ops-home/mechanize/hub18/executor-s0/src/celld/workspace-state-reader.ts:1), [routed-handler.ts](/Users/b.c.nims/dev/employment-ops-home/mechanize/hub18/executor-s0/src/celld/routed-handler.ts:61), [read-model.ts](/Users/b.c.nims/dev/employment-ops-home/mechanize/hub18/executor-s0/src/celld/read-model.ts:75).

Verification:

- Type check, cycle check, lint, and direct behavioral checks passed.
- 717/717 socket-free tests passed.
- Full `pnpm test` reached 721 passing tests; five existing HTTP tests could not run because the sandbox rejects `listen(0)` with `EPERM`. No test assertion failed.