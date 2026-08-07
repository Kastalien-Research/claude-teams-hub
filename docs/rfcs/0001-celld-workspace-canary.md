# RFC 0001 — celld WorkspaceCell Canary

Status: accepted (canary-scoped) · Date: 2026-08-06 · Owner: team-hub
Target: celld v0.1.0, commit `553ae73f83c87c3f7c7a5f73c32c2211d9d7341f` (vendored
read-only at `references/celld`, gitignored)

## Purpose

An experimental, opt-in coordination path that routes a single workspace's
coordination state through one celld Durable Object — `WorkspaceCell(workspaceId)`
— to prove three things and nothing more:

1. Atomic, idempotent coordination under competing claims.
2. Durable impact detection, targeted delivery, safe-point acknowledgement,
   and runtime adaptation.
3. Recovery from a celld owner failure without filesystem fallback.

Production adoption is explicitly out of scope. celld v0.1.0 is an alpha
(released 2026-08-05); it is suitable here only for a private,
single-trust-domain canary.

## Decisions

- **The Node/MCP/HTTP server remains the public façade.** Clients never talk to
  celld directly; the two Code Mode MCP tools and `/hub/api` are unchanged as
  entry points.
- **One `WorkspaceCell(workspaceId)` per newly opted-in workspace.**
  `create_workspace({ backend: "celld" })` is the only opt-in gate.
- **Routing happens at the high-level `HubHandler` boundary.** There is
  deliberately NO record-level `CelldHubStorage` adapter: claims, membership,
  current work, impacts, receipts, and events must commit together inside one
  cell transaction. A storage-interface adapter would preserve exactly the
  multi-record transaction gaps this canary exists to close.
- **Existing filesystem workspaces are untouched and never migrated.** The
  filesystem path stays byte-for-byte compatible (enforced by replaying the
  existing hub-handler suite through the routed handler).
- **Global agent identities, profiles, decisions, assumptions, outcomes, and
  transitional thought/session data remain on current storage.** Only
  workspace-scoped coordination moves.
- **`$HUB_DATA_DIR/hub/workspace-backends.json` is a crash-safe
  routing/provisioning index only** — never workspace-state authority. Entries
  move `provisioning → active`, keyed by the creating caller's command ID, so a
  crashed `create_workspace` retry resumes the same workspace and command.
- **A routed celld workspace is authoritative** for its membership, problems,
  channels, work intents, impacts, revisions, command receipts, and durable
  events.
- **SSE remains an ephemeral notification hint.** `read_workspace_events` is
  the replay authority. Celld-backed hints carry the durable `eventId` inside
  `data`; consumers must dedupe by it, because a commit-before-reply retry can
  legitimately rebroadcast the same event IDs.
- **Claude Agent Teams remains the execution/lifecycle plane.** Celld wakes
  cells, not Claude processes: it cannot awaken or interrupt Claude. The team
  leader is the explicit v1 bridge, and agents react at safe points
  (Team-message → MCP-fetch → safe-point adaptation).

## Authority table

| Concern | V1 authority |
|---|---|
| Agent identity and global decisions | Existing filesystem stores |
| Workspace backend routing | Atomic local route registry (`workspace-backends.json`) |
| Opted-in workspace coordination | `WorkspaceCell` |
| Durable ordering and replay | Cell event journal |
| Live browser notification | Existing SSE, deduped by durable event ID |
| Claude teammate lifecycle and messaging | Native Claude Agent Teams |

## Antigravity analysis — dispositions

| Claim | Disposition |
|---|---|
| Single-writer workspace coordination | **Plausible — must be proven by the race gate.** Not assumed. |
| Drop-in `CelldHubStorage` | **Rejected.** Preserves multi-record transaction gaps; the cell must own whole-command atomicity. |
| Cell-per-problem / per-scope / per-agent | **Deferred.** V1 uses one workspace aggregate to avoid distributed-transaction and graph-traversal complexity. |
| "Instant Claude wake-up" / "mid-loop interruption" | **Unsupported.** celld wakes cells, not Claude processes. V1 proves safe-point adaptation only. |
| Hibernatable WebSockets eliminating polling | **Unproven, deferred.** Durable cursors (`read_workspace_events?after=`) come first. |
| Worker Loader replacing Code Mode securely | **Deferred.** Experimental in celld and unrelated to the coordination proof. |
| "Zero control plane" | **Qualified.** MinIO/S3 is the fleet authority and an availability dependency; the local route registry is additionally a single-Team-Hub-process limitation. |
| Exactly-once delivery | **Not claimed.** We claim effectively-once *state transitions* via application command deduplication. Delivery of hints is at-least-once. |
| Production readiness | **Out of scope.** celld v0.1.0 is an alpha; private single-trust-domain canary only. |

## Wire contracts (v1)

Zod-backed, in `src/celld/contracts.ts`. Schema versions are literal strings; a
mismatch is `CELLD_PROTOCOL_MISMATCH`.

```ts
interface HubCommandV1 {
  schemaVersion: "hub-command-v1";
  commandId: string;
  operation: string;
  workspaceId: string;
  actor: { agentId: string; promptVersion?: string };
  issuedAt: string;                 // excluded from payloadHash
  expectedRevision?: number;
  context: { teamRunId?: string; nativeTaskId?: string; processRunId?: string };
  correlationId?: string;
  causationId?: string;
  payloadHash: string;              // excluded from payloadHash
  payload: Record<string, JsonValue>;
}

interface HubEventV1 {
  schemaVersion: "hub-event-v1";
  eventId: string;
  workspaceId: string;
  sequence: number;                 // journal position, gap-free, one per event
  aggregateRevision: number;        // advances once per accepted command
  type: string;
  commandId: string;
  actor: HubCommandV1["actor"] & HubCommandV1["context"];
  occurredAt: string;
  data: Record<string, JsonValue>;
}
```

`payloadHash` = SHA-256 over the canonical JSON (recursive sorted object keys)
of the semantic command: operation, workspace, actor, context, expectedRevision,
correlationId, causationId, payload — everything except `issuedAt` and
`payloadHash` themselves. The canonical-JSON + hash module is runtime-portable
(Web Crypto only; probed byte-identical between Node and the celld worker).

`CommandMetadataV1` is the caller-facing slice, passed as `command` on celld
mutations:

```ts
interface CommandMetadataV1 {
  id: string;
  expectedRevision?: number;
  teamRunId?: string;
  nativeTaskId?: string;
  processRunId?: string;
  promptVersion?: string;
  correlationId?: string;
  causationId?: string;
}
```

## Cell command semantics

1. Validate envelope and workspace route.
2. Look up `commandId` in the receipts table.
3. Same ID + same hash → return the stored result/rejection with
   `replayed: true`; no new state, no new events.
4. Same ID + different hash → `IDEMPOTENCY_KEY_REUSED`.
5. Execute the pure reducer inside ONE synchronous storage transaction
   (`storage.transactionSync`, no `await` inside). Probed: a throw rolls back
   every write in the transaction; therefore **domain rejections do not throw**
   — they return normally and persist a rejection receipt WITHOUT advancing
   revision or event sequence. Only unexpected errors throw (full rollback, no
   receipt).
6. Accepted commands persist state, revision (+1), events (one row per event),
   and the success receipt atomically.
7. **Revision vs sequence are separate.** One command advances
   `aggregateRevision` once but may append several events (e.g. one
   `record_work_change` → one `work_change_recorded` + N `impact_detected`).

Client retry policy: retry ONLY on transport ambiguity, with the byte-identical
envelope. Never retry a parsed 4xx/domain rejection; never mint a replacement
command ID for a retry. Probed failure shapes: both-nodes-down =
ECONNREFUSED (unambiguous; safe to fail over / retry identically); a timeout
after the request was sent is ambiguous and is exactly what the dedup exists
for. Endpoint failover across `HUB_CELLD_ENDPOINTS` is safe: probed that a
non-owner node transparently proxies reads and writes to the owner with
consistent results.

## Work intent and impact model

```ts
interface WorkIntentV1 {
  intentId: string; workspaceId: string; problemId: string; agentId: string;
  teamRunId: string; nativeTaskId?: string; processRunId?: string;
  readScopes: string[]; writeScopes: string[];
  contractRefs: string[]; assumptionIds: string[];
  branchId?: string; leaseUntil: string; generation: number;
  declaredAt: string; updatedAt: string;
}

interface ImpactV1 {
  impactId: string; changeId: string; targetAgentId: string;
  targetProblemId: string; targetNativeTaskId?: string;
  targetIntentGeneration: number;
  severity: "blocking" | "advisory";
  status: "pending" | "acknowledged";
  matchingReasons: Array<{ kind: "scope" | "contractRef" | "assumptionId";
                           source: string; target: string }>;
  disposition?: "accepted" | "not_applicable";
  note?: string; detectedAt: string; acknowledgedAt?: string;
}
```

`record_work_change` accepts `kind`, `summary`, `scopes`, `contractRefs`,
`assumptionIds`, `severity`. Matching against active, unexpired intents:

- The change author is excluded.
- `contractRefs` / `assumptionIds` match by exact string equality.
- Scopes are slash-separated paths; match on exact, ancestor, or descendant at
  **segment boundaries** (`a/b` matches `a/b/c` and `a`, never `a/bc`).
- At most one impact per `(changeId, targetAgentId, intentGeneration)`.
- The exact matching reasons are recorded on the impact.

Completion gates: `update_problem` to `resolved`/`closed` rejects
stale `expectedRevision` (`REVISION_CONFLICT`), stale intent generation
(`WORK_INTENT_GENERATION_STALE`), and any unacknowledged blocking impact
targeting that intent (`BLOCKING_IMPACT_UNACKNOWLEDGED`). Acknowledgement is
durable and must precede successful completion.

## Operation surface

Supported on celld workspaces (routed to the cell): `create_workspace`,
`join_workspace`, `create_problem`, `claim_problem`, `update_problem`,
`list_problems`, `post_message`, `read_channel`, `workspace_status`,
`workspace_digest`, plus five new operations (catalog 35 → 40):

| Operation | SDK method |
|---|---|
| `declare_work_intent` | `tb.hub.declareWorkIntent` |
| `record_work_change` | `tb.hub.recordWorkChange` |
| `list_impacts` | `tb.hub.listImpacts` |
| `acknowledge_impact` | `tb.hub.acknowledgeImpact` |
| `read_workspace_events` | `tb.hub.readWorkspaceEvents` |

Rejected on celld workspaces with `CELLD_CANARY_OPERATION_UNSUPPORTED`:
`quick_join`, `transfer_coordinator`, `add_dependency`, `remove_dependency`,
`ready_problems`, `blocked_problems`, `create_sub_problem`, all proposal and
consensus operations, `post_system_message`. An unsupported or unavailable
celld operation is never forwarded to filesystem storage.

The five new operations on a FILESYSTEM workspace are rejected with
`OPERATION_REQUIRES_CELLD_BACKEND` before any storage call. (This code is a
canary addition; the spec named only the inverse direction.)

Celld operation results add, without removing any existing field:

```ts
coordination: {
  backend: "celld";
  commandId?: string;
  revision: number;
  replayed?: boolean;
  firstEventSequence?: number;
  lastEventSequence?: number;
}
```

Compatibility: a celld workspace's `mainSessionId` is `celld:<workspaceId>` and
claim results carry `branchFromThought: 0`; the celld claim path never touches
the thought store. Thought-branch integration is explicitly deferred.

## Error codes

Stable `code`, human message, retryability, optional details. Codes survive the
MCP boundary (serialized alongside `error`) and the HTTP boundary; Code Mode
sandbox errors include the code in the thrown message text.

| Code | Retryable | Meaning |
|---|---|---|
| `CELLD_UNAVAILABLE` | yes (later) | No configured celld endpoint reachable |
| `CELLD_PROTOCOL_MISMATCH` | no | schemaVersion mismatch between hub and cell |
| `CELLD_CANARY_OPERATION_UNSUPPORTED` | no | Operation not in the canary surface for celld workspaces |
| `OPERATION_REQUIRES_CELLD_BACKEND` | no | One of the five new ops targeted a filesystem workspace |
| `IDEMPOTENCY_KEY_REUSED` | no | commandId reused with a different payloadHash |
| `REVISION_CONFLICT` | no (re-read first) | expectedRevision does not match the aggregate |
| `PROBLEM_ALREADY_CLAIMED` | no | Claim race lost |
| `NOT_WORKSPACE_MEMBER` | no | Actor is not a member of the routed workspace |
| `BLOCKING_IMPACT_UNACKNOWLEDGED` | no | Completion attempted with a pending blocking impact |
| `WORK_INTENT_GENERATION_STALE` | no | Completion cited an outdated intent generation |

## Deployment pins (probed 2026-08-06)

- celld image: `ghcr.io/denoland/celld:553ae73f83c87c3f7c7a5f73c32c2211d9d7341f-<arch>`
  (`-arm64` / `-amd64` selected by `uname -m`; the spec's `sha-…` multi-arch tag
  was never published and `latest` is celld 0.0.2 — do not use either). Evidence
  manifests record the resolved digest.
- `minio/minio:RELEASE.2025-09-07T16-13-09Z`, `minio/mc:RELEASE.2025-08-13T08-35-41Z`
  — disposable private-network canary dependencies only, not a storage
  recommendation.
- esbuild `0.25.12` exact (celld deploy shells out to esbuild; the deployer
  image carries the standalone binary).
- `celld deploy` runs as a one-shot service BEFORE either node starts — nodes
  load their deployment at startup (probed).
- `CELLD_TTL_MS=5000` (node lease lifetime; default 10000). Probed failover:
  SIGKILL of the owner → the surviving node serves the cell in ~4s with prior
  state intact; a single node restarted after total loss recovers full state
  from the bucket.

## Verification gates

The canary passes only if all three hold, decided by the deterministic verifier
(`canary:celld -- verify`), never by a producing agent:

1. **Race gate** — two independent MCP sessions racing one claim yield exactly
   one success and one `PROBLEM_ALREADY_CLAIMED`; canonical replay of the
   winner returns `replayed: true` with no new events; altered-payload reuse
   yields `IDEMPOTENCY_KEY_REUSED`; event sequences are unique, increasing,
   gap-free.
2. **Impact gate** — exactly one impact targets the reader (beta), none targets
   the author (alpha); matching reasons name the contract and scope; detection
   precedes acknowledgement; both stale-completion rejections fired
   (`REVISION_CONFLICT`, then `BLOCKING_IMPACT_UNACKNOWLEDGED`); the final
   payload cites the previously unknown `impactId`; completion succeeds only
   after acknowledgement.
3. **Recovery gate** — state and events survive owner SIGKILL via the second
   (initially empty) node; with both nodes down a unique mutation fails
   `CELLD_UNAVAILABLE`; after restart the marker was never written to cell or
   filesystem state; no filesystem fallback occurred at any point.
