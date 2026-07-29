# Known issues

Found during the phase-6 two-agent live smoke (2026-07-29), each verified
against source and live server state, not just observed. Ordered by bite.

## 1. `quickJoin` in an already-identified MCP session mints an orphan agent

`hub-handler.ts` places `quick_join` in the "Stage 0: no agent needed" branch,
so `handle()`'s `agentId` parameter is never consulted: it unconditionally
calls `identity.register(...)` and joins the NEW agent. `session-identity.ts`
keeps "the first registration" as the session default, so the caller's
subsequent calls still act as the old agent and fail
`Not a member of this workspace` — while `quickJoin` returned success
describing an agent the caller is not. Observed live: workspace
`smoke-ws-2` acquired an undriven contributor wearing a real agent's name;
no leave/remove operation exists to clean it up.

**Workaround** (documented in the parent's `docs/team-hub-brief.md`):
register/quickJoin at most once per MCP session; every later workspace via
`tb.hub.joinWorkspace({ workspaceId })` alone.

**Fix direction**: `quick_join` should rebind or reuse the session's existing
identity when one exists (or refuse loudly), never silently register a second.

## 2. Catalog inputSchema for `thoughtbox_thought` omits type-required payloads

The server enforces per-`thoughtType` payloads (`thought-handler.ts`):
`decision_frame` requires `confidence` + `options` (exactly one
`selected: true`); `action_report` requires
`actionResult: {success, reversible, tool, target}`; `belief_snapshot`
requires `beliefs: {entities: [{name, state}], constraints?, risks?}`. The
catalog's advertised schema lists required
`["thought","nextThoughtNeeded","thoughtType"]` only — a client that trusts
the published schema cannot construct a valid typed thought and learns the
real shape from serial validation errors.

**Fix direction**: surface the per-type requirements in the catalog schema
(or at minimum in the operation's annotation text).

## 3. `thoughtbox_search` sandbox lacks `search()` and `tb`

Sandbox globals are exactly `["__catalogJson","console","setTimeout",
"clearTimeout"]`. Discovery code must parse `__catalogJson` by hand; catalog
keys are also snake_case (`review_proposal`) while the executable SDK is
camelCase (`tb.hub.reviewProposal`), so nothing discovered is directly
callable by its discovered name.

## 4. `hub-storage-fs` channel read/write key asymmetry

`getChannel(workspaceId, problemId)` reads `channels/${problemId}.json` while
`saveChannel(channel)` writes `channels/${channel.id}.json`. The invariant
`channel.id === problemId` holds today only because `problems.ts` always
constructs channels with `id: problemId` — nothing enforces it at the storage
boundary, so any future caller minting its own channel id silently splits
read and write paths.

## Design note, not a defect: consensus markers are immutable

`consensus.ts` exposes only mark/endorse/list — no update, delete or
supersede. A marker whose description turns out false stays on the record
verbatim; the sanctioned correction is ADDITIVE (a new marker citing a new
thought and naming the superseded one), which the smoke exercised. Worth
knowing before writing marker descriptions that assert facts about other
agents' behaviour.
