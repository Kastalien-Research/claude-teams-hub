# Known issues

Found during the phase-6 two-agent live smoke (2026-07-29), each verified
against source and live server state, not just observed. Ordered by bite.

> **Superseded by SPEC-HUB-003 (durable agent identity).** Issues #1 and #5
> below are written against a model that no longer exists: identity bound to
> the MCP session, a "session default" agentId taken from the first
> registration, and an explicit `agentId` accepted only if it was registered
> on the same connection. Identity is now resolved per request from the
> durable agent record — `SessionIdentityRegistry` is deleted, agentId-less
> mutations resolve only from `THOUGHTBOX_AGENT_ID`/`THOUGHTBOX_AGENT_NAME`,
> and coordinator power survives reconnection (see README "Identity"). The
> old workaround "register/quickJoin at most once per MCP session" is
> obsolete: pass your `agentId` on every call instead, from any connection.
> The reports are kept verbatim for the record.

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

## 2. ~~Catalog inputSchema for `thoughtbox_thought` omits type-required payloads~~ FIXED

**Fixed 2026-07-29.** The payload contract is now transcribed from the
validator into `THOUGHT_TYPE_REQUIRED_FIELDS` (`src/thought/operations.ts`),
and all three discovery surfaces derive from it: the catalog `inputSchema`
(every payload is a declared property with its own enforced `required` keys,
plus standard JSON Schema `allOf` if/then for the conditional half), the
`thought.thoughtbox_thought` annotation in `CATALOG_ANNOTATIONS`, and the
`tb.thought(...)` declaration in `sdk-types.ts`. `catalog-drift.test.ts`
holds the map against the RUNNING validator — it asks the validator which
types it accepts, submits a minimal payload for each, and asserts each typed
form is rejected when its payload is omitted — so the published schema
cannot claim a contract the server does not enforce.

The full enforced contract, as read from `ThoughtHandler.validateStructuredFields`:

| thoughtType | enforced payload |
| --- | --- |
| `reasoning`, `finding`, `synthesis`, `question`, `conclusion` | none beyond `thought` |
| `decision_frame` | `confidence` ∈ high/medium/low, `options` non-empty with exactly one `selected: true` |
| `action_report` | `actionResult` `{success: boolean, reversible: 'yes'\|'no'\|'partial', tool, target}` |
| `belief_snapshot` | `beliefs.entities` non-empty (item keys NOT validated) |
| `assumption_update` | `assumptionChange.newStatus` ∈ believed/uncertain/refuted (`text`/`oldStatus` NOT validated) |
| `context_snapshot` | `contextData` is an object (no key validated) |
| `progress` | `progressData` `{task, status ∈ pending/in_progress/done/blocked}` |
| `action_receipt` | `receiptData` `{toolName, match: boolean}` |

Two findings beyond the original report:

- **`action_receipt` was missing from the advertised enum entirely**, in the
  catalog, in `sdk-types.ts`, and in `thoughtToolInputSchema` — the reverse
  lie: a type the validator accepts (verified by submitting one through
  `tb.thought`) that no discovery surface admitted existed. Added to all
  three, along with the `receiptData` property/`ReceiptDataSchema` that only
  existed on the internal `ThoughtData` type.
- **Three payloads are looser than their declared TypeScript shape.**
  `beliefs.entities` items, `assumptionChange.text`/`oldStatus`, and every
  `contextData` key are accepted absent. The schema documents them as
  properties but does NOT mark them required, because marking them so would
  be a new lie in the strict direction.

## 3. ~~`thoughtbox_search` sandbox lacks `search()` and `tb`~~ FIXED (and partly misdiagnosed)

**Fixed 2026-07-29.** Each hub catalog entry now carries `sdkMethod` — the
fully-qualified call that runs it, e.g. `review_proposal` →
`sdkMethod: "tb.hub.reviewProposal"` — so a discovered operation names its
own callable. Both surfaces read ONE map, `HUB_SDK_METHODS`, extracted to the
import-free leaf module `src/code-mode/hub-sdk-methods.ts`: `execute-tool.ts`
builds `tb.hub` from it and `search-index.ts` stamps the catalog from its
derived inverse, so the two cannot diverge. `SEARCH_TOOL`'s description now
states the sandbox contract and points at `sdkMethod`. Pinned by
`catalog-drift.test.ts` (all 28 hub ops, and the catalog's `sdkMethod`
compared against an independent inversion of the map `execute-tool` iterates)
and `server-surface.test.ts` (the same, on the served gateway resource).

Deliberately NOT done: no `search()` helper and no `tb` in the search
sandbox. That would widen a read-only discovery surface into an executing
one; making the catalog carry callable names is the honest fix.

**The report's other half was wrong.** "Discovery code must parse
`__catalogJson` by hand" does not hold — `search-tool.ts` wraps the submitted
code with `const catalog = Object.freeze(JSON.parse(__catalogJson))`, so
`catalog` is lexically in scope, already parsed and frozen. Verified by
probe and by `search-tool.test.ts`. Only the snake_case/camelCase mismatch
was real. The tool description now says so explicitly, since an agent reading
the old issue would have written pointless parsing code.

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
