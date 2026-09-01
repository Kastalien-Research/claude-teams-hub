# celld Canary — Native Claude Agent Teams Proof (runbook)

Companion to RFC 0001 §Verification gates. The automated gauntlet
(`pnpm test:celld:integration`) proves the race and recovery gates; this
runbook is the impact gate: two native Claude Agent Teams teammates adapting
to a durable impact at a safe point. It is DRIVEN BY THE ORCHESTRATOR SESSION
— no repo code executes it; the repo ships the protocol so the proof is
reproducible and the deterministic verifier knows the observation shape.

## Preconditions

1. `pnpm canary:celld -- setup --run-id <uuid>` succeeded (it refuses to seed
   unless hub, both celld nodes, MCP, the cell protocol, and the
   celld-workspace authority marker all verify).
2. The orchestrator's MCP client (`.mcp.json` team-hub entry) points at the
   canary hub (`http://localhost:<CANARY_HUB_PORT>/mcp`, default 17321) — NOT
   the standing :1731 hub.
3. `setup.json` in the evidence dir carries: workspaceId, `claim-alpha` /
   `claim-beta` durable agentIds, the coordination/contention/schema-owner/
   api-consumer problemIds, and the deterministic command-ID prefix.

## Cast

- **Leader/relay**: the orchestrator session. Pre-mints nothing at proof time —
  identities came from setup. Creates TWO native Task records, then spawns two
  `general-purpose` teammates. The leader is the ONLY bridge between celld
  and Claude: celld wakes cells, never Claude processes.
- **Alpha** (`claim-alpha-<runId>`): schema owner.
- **Beta** (`claim-beta-<runId>`): API consumer.

Teammate briefs must include: hub MCP endpoint, their agentId (they NEVER
register or quick_join), workspaceId, their problemIds, the coordination
problemId (its channel is the coordination channel), the runId, their
deterministic command-ID prefix (`canary-<runId>-alpha-*` / `-beta-*`), and
the rules: at most ONE Team Hub mutation per thoughtbox_execute call; read the
coordination channel at startup AND before finishing; report raw command IDs /
revisions / errors, never verdicts.

## Protocol (numbered observations land in native-observations.json)

1. Both teammates send targeted `READY <agentId>` native messages to the leader.
2. Leader sends `GO` to each individually.
3. Both claim the CONTENTION problem with distinct command IDs; each reports
   its raw outcome (accepted result or error code). Expected: one accepted,
   one `PROBLEM_ALREADY_CLAIMED`.
4. The winner repeats its byte-identical claim command; reports the
   `coordination.replayed` flag. (Verifier later confirms one claim event.)
5. Alpha claims schema-owner and declares a WRITE intent; beta claims
   api-consumer and declares a READ intent — both over:
   - contractRef `contract://celld-canary/<runId>/payment-method-id`
   - scope `canary/<runId>/db/payments`
   (leaseUntil: now + 30 minutes; teamRunId = the native team run id.)
6. Beta drafts an integer `paymentMethodId` design, records its current
   `coordination.revision` and intent generation, posts `SAFEPOINT_READY` to
   the coordination channel, sends the leader `SAFEPOINT_READY`, and WAITS.
7. Alpha records a blocking `contract_changed` work change: "paymentMethodId
   changes from integer to UUIDv7 string" (same contractRef + scope).
8. Beta attempts completion of api-consumer with its PRE-CHANGE revision
   (expectedRevision) — expected `REVISION_CONFLICT`.
9. The leader reads the durable journal (`read_workspace_events`), finds the
   impact targeting beta, and sends beta ONLY `workspaceId`, `impactId`, and
   the event sequence — never the change payload. (Delivery is a Team
   message; there is no celld→Claude wake-up.)
10. Beta fetches the impact via `list_impacts`/the impactId over MCP. BEFORE
    acknowledging, beta attempts completion at the CURRENT revision —
    expected `BLOCKING_IMPACT_UNACKNOWLEDGED`.
11. Beta acknowledges the impact as `accepted`, revises its output, and
    completes api-consumer with output:
    `{ "paymentMethodIdType": "string", "sourceImpactId": "<impactId>" }`.
12. Each teammate posts exactly ONE completion message to the coordination
    channel with raw command IDs, operation counts, revision/event cursors,
    and observed error codes. Neither teammate grades the canary.
13. The leader collects raw observations into
    `<evidenceDir>/native-observations.json` (shape below), runs
    `canary:celld -- export` then `-- verify`.
14. Leader requests graceful teammate shutdown, waits for acknowledgements,
    cleans up the native team. Never read or write undocumented
    `~/.claude/teams` or task files.

## native-observations.json shape (consumed by verify)

```json
{
  "runId": "…",
  "teamRunId": "…",
  "raceGate": {
    "winnerAgentId": "…", "winnerCommandId": "…",
    "loserAgentId": "…", "loserCode": "PROBLEM_ALREADY_CLAIMED",
    "replayedCoordination": { "replayed": true, "revision": 0 }
  },
  "impactGate": {
    "impactId": "…", "impactEventSequence": 0,
    "revisionConflict": { "citedRevision": 0, "code": "REVISION_CONFLICT" },
    "blockingUnacknowledged": { "code": "BLOCKING_IMPACT_UNACKNOWLEDGED" },
    "acknowledgement": { "disposition": "accepted", "commandId": "…" },
    "completion": { "commandId": "…", "output": { "paymentMethodIdType": "string", "sourceImpactId": "…" } }
  },
  "messages": { "alphaCompletion": "…", "betaCompletion": "…" }
}
```

The impact gate passes only if (verifier-checked against the journal): exactly
one impact targets beta and none targets alpha; matchingReasons name the
contract AND the scope; detection precedes acknowledgement; both
stale-completion rejections fired; beta's final output cites the previously
unknown impactId; completion succeeded only after acknowledgement. Report the
mechanism as Team-message → MCP-fetch → safe-point adaptation — never as
automatic wake-up or mid-token interruption.
