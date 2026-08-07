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

- `tb.hub` — 40 operations: identity, workspaces, problems, proposals,
  consensus, channels, status, decisions, coordination. The five coordination
  operations (`declareWorkIntent`, `recordWorkChange`, `listImpacts`,
  `acknowledgeImpact`, `readWorkspaceEvents`) require a celld-backed workspace
  (`createWorkspace({ backend: "celld" })`, RFC 0001, canary) and are rejected
  with `OPERATION_REQUIRES_CELLD_BACKEND` on the default filesystem backend.
- `tb.thought` / `tb.session` — the thought ledger, **transitional**: kept
  because consensus markers and proposal merges anchor to thought references.
  Agents are steered toward semantic `thoughtType`s (`action_report`,
  `belief_snapshot`, `decision_frame`) over raw `reasoning`. Its designated
  replacement is the Epistemic Engine (see the decision record
  `team-hub-keeps-the-thoughtbox-thought-engine-as-a-transitional-findings-substrate`
  in the parent workspace's decisions ledger).
- `tb.vars` — session-scoped variables.

## Decisions

The decision ledger (`recordDecision`, `recordAssumption`, `challengeAssumption`,
`supersedeDecision`, `recordOutcome`, `consultDecisions`) records durable choices about a
**scope** — a module or path — together with the assumptions they rest on and the raw
outcomes observed afterwards. It is hub-global rather than workspace-scoped: a decision
about a repo module has to be consultable from any session.

Two invariants: **append-only** (there is no update operation; a wrong decision is retired
by `supersedeDecision`, which writes a new record naming the old one, and the original file
is never rewritten) and **no numeric belief math** (nothing carries a confidence or a
posterior; `expectationAssessment` is a categorical adjudication kept separate from the raw
`data` it adjudicates). Health flags — `rests-on-challenged-assumption`,
`outcome-contradicts-expectation`, `superseded`, `regime-changed-since` — are computed at
consult time and never stored.

The schema deliberately mirrors the parent repo's `dev-processes/ledger/data/decisions.jsonl`
so the two can converge: `slug` ← `decision_id`, `evidenceRefs` ← `evidence[]`, and each
`reversal_conditions[]` entry maps to an assumption linked via `assumptionIds`. A fired
reversal condition is then `challengeAssumption`, which surfaces on every future consult of
the decisions that rest on it. Records live as flat per-record JSON under
`$HUB_DATA_DIR/hub/decisions/`, so a consultation hook can read them with a glob and a
`json.load`, with no server in the path. Importing the parent ledger is a later, parent-repo
phase — nothing here touches it.

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
Leaving `HUB_DATA_DIR` unset logs a loud startup line naming the resolved
default path — an unpinned data dir is how a durable agent/workspace identity
can fork or vanish across sessions and environments, so pin it explicitly for
anything you want to survive.

Every record write (workspace, problem, proposal, consensus marker, channel
metadata, channel message) goes through temp-file + atomic `rename`, so a
crash mid-write leaves either the previous file or the new one, never a
truncated hybrid. Channel messages are additionally append-per-file
(`channels/<problemId>/NNNN.json`) rather than a whole-channel rewrite, so
posting message N+1 cannot corrupt messages 1..N; the read path merges the
per-file messages with whatever a channel's `<problemId>.json` metadata file
already holds, so channels written before this split keep reading with no
migration step. None of this adds concurrency safety — local mode is still
single-process, per the existing storage-module doc comment.

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
