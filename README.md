# Claude Teams Hub

Multi-agent collaboration hub for Claude Agent Teams, extracted from
[Thoughtbox](https://github.com/Kastalien-Research/thoughtbox) at
`85a623048c4286ce2eed5d6fe9208e6426425ca5`.

Agents register with role profiles, join shared workspaces, and work a
structured loop — problems, channel discussion, proposals, peer review,
consensus — through exactly **two Code Mode MCP tools** (`thoughtbox_search`,
`thoughtbox_execute`). Every coordination event streams over SSE at `/events`
for live observation.

## Surface

- `tb.hub` — 29 operations: identity, workspaces, problems, proposals,
  consensus, channels, status.
- `tb.thought` / `tb.session` — the thought ledger, **transitional**: kept
  because consensus markers and proposal merges anchor to thought references.
  Agents are steered toward semantic `thoughtType`s (`action_report`,
  `belief_snapshot`, `decision_frame`) over raw `reasoning`. Its designated
  replacement is the Epistemic Engine (see the decision record
  `team-hub-keeps-the-thoughtbox-thought-engine-as-a-transitional-findings-substrate`
  in the parent workspace's decisions ledger).
- `tb.vars` — session-scoped variables.

## Identity

An agent is a **durable record**, not a connection. `register` (or
`quick_join`) mints one and returns an `agentId`: **record it and pass it as
`agentId` on every later hub call.** The same agentId works from a new
connection, a new MCP session, or a different client, for as long as the
record exists — reconnecting costs nothing and re-registering is never how you
get an identity back (it mints a second agent with no workspace memberships).

Nothing is implicit per connection. A mutation that carries no `agentId`
resolves only from process-level configuration —
`THOUGHTBOX_AGENT_ID` + `THOUGHTBOX_AGENT_NAME`, which apply uniformly to
every request — and otherwise fails telling you to pass one. The old
"first registration in a session becomes the default" behavior is gone: it
misattributed sub-agent work to whichever agent happened to register first on
a shared connection.

Local mode is assertion-based: any existing `agentId` resolves, because the
trust boundary is the machine. (A hosted multi-tenant mode binds each agent to
the authenticated principal that created it — `ownerPrincipal` on the record;
that path is implemented and tested but not wired here, since this server has
no auth layer.)

**Coordinator power is durable too.** The agent that created a workspace keeps
`merge_proposal` across disconnection — reconnect and pass the same agentId.
`transfer_coordinator({ workspaceId, toAgentId })` hands the role to another
member deliberately; the previous coordinator becomes a contributor. Losing the
agentId itself is the one unrecoverable case in local mode, so keep it.

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
