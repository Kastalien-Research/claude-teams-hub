Implemented celld workspace discovery for MCP hub operations.

- `whoami` now includes celld memberships from authoritative cell snapshots.
- `list_workspaces` now includes active celld workspaces, member/problem counts, and unreachable placeholders.
- HTTP and MCP reads share the same celld snapshot loader.
- Filesystem behavior remains unchanged.
- No tests or dependencies modified.

Changed:

- [read-model.ts](/Users/b.c.nims/dev/employment-ops-home/mechanize/hub18/executor-s0/src/celld/read-model.ts:71)
- [routed-handler.ts](/Users/b.c.nims/dev/employment-ops-home/mechanize/hub18/executor-s0/src/celld/routed-handler.ts:57)

Validation:

- Typecheck, lint, cycle check: passed
- Routed-handler tests: 17/17 passed
- Listener-free feature assertion: passed
- Full suite: 721 passed; five HTTP tests could not bind a local port due to sandbox `EPERM`, with no assertion failures.