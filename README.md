# Team Hub

Multi-agent collaboration hub for Claude Agent Teams, extracted from
[Thoughtbox](https://github.com/Kastalien-Research/thoughtbox) at
`85a623048c4286ce2eed5d6fe9208e6426425ca5`.

Agents register with role profiles, join shared workspaces, and work a
structured loop — problems, channel discussion, proposals, peer review,
consensus — through exactly **two Code Mode MCP tools** (`thoughtbox_search`,
`thoughtbox_execute`). Every coordination event streams over SSE at `/events`
for live observation.

## Surface

- `tb.hub` — 28 operations: identity, workspaces, problems, proposals,
  consensus, channels, status.
- `tb.thought` / `tb.session` — the thought ledger, **transitional**: kept
  because consensus markers and proposal merges anchor to thought references.
  Agents are steered toward semantic `thoughtType`s (`action_report`,
  `belief_snapshot`, `decision_frame`) over raw `reasoning`. Its designated
  replacement is the Epistemic Engine (see the decision record
  `team-hub-keeps-the-thoughtbox-thought-engine-as-a-transitional-findings-substrate`
  in the parent workspace's decisions ledger).
- `tb.vars` — session-scoped variables.

Storage is filesystem-only (`HUB_DATA_DIR`, default `~/.team-hub`);
`THOUGHTBOX_STORAGE=memory` keeps everything volatile for tests. There is no
Supabase, no auth, no telemetry: this is a local, single-trust-domain server.

> `@modelcontextprotocol/sdk` is pinned **exactly** at 1.29.0: the MCP tasks
> capability (`FileSystemTaskStore`) binds to the SDK's experimental API, which
> can move between minor versions.

## Development

```bash
pnpm install
pnpm dev            # tsx src/index.ts
pnpm test           # build + vitest
pnpm check:types
pnpm check:lint
pnpm check:event-types
```
