> `whoami` and `list_workspaces` (the MCP hub operations reached via
> `tb.hub.whoami` / `tb.hub.listWorkspaces`) omit celld-backed workspaces:
> a member of a celld workspace gets `workspaces: []` from `whoami`, and
> `list_workspaces` never lists the workspace at all, while
> `workspace_status` on the same workspace reports the membership. Make
> both operations include celld-backed workspaces and their memberships,
> matching what `workspace_status` and the HTTP read model
> (`src/celld/read-model.ts`) already report. Keep `pnpm test` green.

> A cell that cannot be reached, or that answers with a body that is not a workspace
> state, must not fail the read and must not delay it: `list_workspaces` lists that
> workspace as `{ id, backend: 'celld', unreachable: true }` with no other fields,
> `whoami` omits it, every other workspace is reported normally, and the read
> completes in about one cell request timeout regardless of how many cells are slow
> or down.

Do not modify `src/__tests__/architecture.test.ts` or any locked test. Do not add a dependency.

You have the full repository, node 22+, pnpm and vitest. You may run `pnpm test`, `pnpm check:types`, `pnpm check:cycles`. There is no network access. Do not modify `src/__tests__/architecture.test.ts` or any existing test file. Do not add a dependency.
