# Known issues

Found during the phase-6 two-agent live smoke (2026-07-29), each verified
against source and live server state, not just observed. Ordered by bite.

## 1. ~~`quickJoin` in an already-identified MCP session mints an orphan agent~~ FIXED

**Fixed 2026-07-29** (same day it was found): the tool handler now passes the
session's default identity into `quick_join`, and the handler reuses it when
the requested `name` matches — joining the workspace as the caller instead of
minting an orphan. A DIFFERENT name still mints a sub-agent (the sanctioned
multi-agent flow, pinned by T-HTW-14), but the result now carries a `note`
stating that the session default is unchanged and that acting as the new agent
requires an explicit `agentId`. Pinned by `quick-join.test.ts` ("with an
existing session identity") and `per-session-identity.test.ts`. Original
report kept below for the record.

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

## 4. ~~`hub-storage-fs` channel read/write key asymmetry~~ FIXED

**Fixed 2026-07-29**: `saveChannel` now writes to
`channels/${channel.problemId}.json` — the same key `getChannel` reads — and
throws `Channel id must equal its problemId: <id> !== <problemId>` when the two
disagree, so a caller minting its own channel id gets a loud failure instead of
a silent split. The invariant is stated in the `HubStorage.saveChannel` contract
in `hub-types.ts` rather than left to `problems.ts`'s construction convention.
Pinned by two cases in `storage.test.ts` (problemId-key round trip including
`appendMessage`, and the rejected mismatch writing nothing under either key).
Original report kept below for the record.

`getChannel(workspaceId, problemId)` reads `channels/${problemId}.json` while
`saveChannel(channel)` writes `channels/${channel.id}.json`. The invariant
`channel.id === problemId` holds today only because `problems.ts` always
constructs channels with `id: problemId` — nothing enforces it at the storage
boundary, so any future caller minting its own channel id silently splits
read and write paths.

## 5. ~~Concurrent first registrations in one MCP session race for the default~~ FIXED

**Fixed 2026-07-29**: the tool handler now serializes registration per
sessionKey with a promise-chain mutex (`withRegistrationLock` in
`hub-tool-handler.ts`), making the resolve → register → capture window atomic.
Lock acquisition follows call order, so the FIRST-INITIATED registration
becomes the session default and every later one observes it: concurrent
same-name `quick_join`s now take issue #1's reuse path (one agent, both
callers holding the same identity, membership real in both workspaces)
instead of minting two. A concurrent DIFFERENT-name `quick_join` still mints
a sub-agent — the T-HTW-14 flow — but now sees the default and returns the
`note` saying so. `ensureEnvResolved` memoizes its promise rather than a
boolean flipped before the await, which was the same window for env-var
identities. Pinned by `per-session-identity.test.ts` ("concurrent
registration in one session"); two of those four tests fail on the unfixed
handler. Original report kept below for the record.

**Amended 2026-07-29**: that memoized promise also carried the
`identities.register` call, so the env identity was registered under the FIRST
caller's sessionKey only — every later MCP session awaited the settled promise,
was never registered, and failed authenticated ops with `Register first`. Only
the RESOLUTION is handler-wide now (a memoized `Promise<string | null>`);
registration runs on every call under that call's own sessionKey, which
`SessionIdentityRegistry.register` makes idempotent (it fills an empty default,
never displaces one). Pinned by the same file's "env-var identity across
sessions".

Two `register`/`quick_join` calls running concurrently in one session both
resolve a null session default before either result is captured, so both mint
agents; only the first-completed becomes the implicit identity, and the other
caller's IMPLICIT calls silently act as it (explicit `agentId` calls work for
both — every registration lands in the session registry). Pre-dates the
quick_join reuse fix; surfaced by Greptile's concurrent repro on that PR.

**Fix direction**: serialize registration per sessionKey in the tool handler
(an async mutex around resolve-register-capture).

## Design note, not a defect: consensus markers are immutable

`consensus.ts` exposes only mark/endorse/list — no update, delete or
supersede. A marker whose description turns out false stays on the record
verbatim; the sanctioned correction is ADDITIVE (a new marker citing a new
thought and naming the superseded one), which the smoke exercised. Worth
knowing before writing marker descriptions that assert facts about other
agents' behaviour.
