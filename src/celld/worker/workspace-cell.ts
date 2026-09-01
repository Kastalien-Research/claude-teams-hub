/**
 * WorkspaceCell — the celld Durable Object hosting one workspace aggregate
 * (RFC 0001). Thin shell: parse/validate at the edge, decide with the pure
 * reducer, persist snapshot + receipts + events in ONE synchronous storage
 * transaction. Three tables: cell_meta (snapshot + revision), command_receipts,
 * events. Domain rejections are persisted as receipts WITHOUT advancing
 * revision or sequence — they return normally; only unexpected errors throw
 * (probed: a throw rolls the whole transaction back, receipt included).
 *
 * Bundled by `celld deploy` (esbuild) from this TypeScript entry; the Node
 * server never imports this module.
 */

import { canonicalJson, commandPayloadHash, type JsonValue } from '../canonical-json.js';
import { hubCommandV1Schema, COMMAND_SCHEMA_VERSION, type HubCommandV1 } from '../contracts.js';
import { rejection, type CelldRejection } from '../errors.js';
import { apply, reduce, type ReducerCommand } from '../domain/reducer.js';
import { query } from '../domain/queries.js';
import type { CellWorkspaceState } from '../domain/state.js';
import { decideDedup, type StoredReceipt } from './receipts.js';
import type { CellSqlStorage, CellState, WorkerEnv } from './runtime-types.js';

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function rejectionResponse(r: CelldRejection, status: number): Response {
  return json({ outcome: 'rejected', replayed: false, rejection: r }, status);
}

const SCHEMA_SQL = [
  `CREATE TABLE IF NOT EXISTS cell_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS command_receipts (
     command_id TEXT PRIMARY KEY,
     payload_hash TEXT NOT NULL,
     outcome TEXT NOT NULL,
     revision INTEGER NOT NULL,
     result_json TEXT NOT NULL,
     first_event_sequence INTEGER,
     last_event_sequence INTEGER,
     issued_at TEXT NOT NULL,
     recorded_at TEXT NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS events (
     sequence INTEGER PRIMARY KEY,
     aggregate_revision INTEGER NOT NULL,
     event_id TEXT NOT NULL UNIQUE,
     type TEXT NOT NULL,
     command_id TEXT NOT NULL,
     actor_json TEXT NOT NULL,
     occurred_at TEXT NOT NULL,
     data_json TEXT NOT NULL
   )`,
];

export class WorkspaceCell {
  private readonly state: CellState;

  constructor(state: CellState) {
    this.state = state;
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const match = /^\/v1\/workspaces\/([^/]+)\/(commands|queries|snapshot|events)$/.exec(url.pathname);
    if (url.pathname === '/health') return new Response('ok');
    if (match === null) return json({ error: 'not found', path: url.pathname }, 404);
    const workspaceId = decodeURIComponent(match[1] as string);
    const route = match[2] as string;

    try {
      switch (route) {
        case 'commands':
          return await this.handleCommand(workspaceId, request);
        case 'queries':
          return this.handleQuery(workspaceId, await request.json());
        case 'snapshot':
          return this.handleSnapshot(workspaceId);
        case 'events':
          return this.handleEvents(url);
        default:
          return json({ error: 'not found' }, 404);
      }
    } catch (error) {
      return json({ error: String(error) }, 500);
    }
  }

  private async handleCommand(workspaceId: string, request: Request): Promise<Response> {
    const parsed = hubCommandV1Schema.safeParse(await request.json());
    if (!parsed.success) {
      const versionIssue = parsed.error.issues.some(issue => issue.path[0] === 'schemaVersion');
      if (versionIssue) {
        return rejectionResponse(
          rejection('CELLD_PROTOCOL_MISMATCH', `Cell speaks ${COMMAND_SCHEMA_VERSION}`, {
            issues: parsed.error.issues.length,
          }),
          409,
        );
      }
      return rejectionResponse(
        rejection('VALIDATION_FAILED', `Invalid command envelope: ${parsed.error.issues[0]?.message ?? 'unknown'}`),
        400,
      );
    }
    const command: HubCommandV1 = parsed.data;
    if (command.workspaceId !== workspaceId) {
      return rejectionResponse(
        rejection('VALIDATION_FAILED', `Command workspaceId ${command.workspaceId} does not match cell ${workspaceId}`),
        400,
      );
    }
    // Async hashing must finish before the synchronous transaction opens.
    const recomputedHash = await commandPayloadHash(command);
    if (recomputedHash !== command.payloadHash) {
      return rejectionResponse(
        rejection('VALIDATION_FAILED', 'payloadHash does not match canonical command content', {
          expected: recomputedHash,
        }),
        400,
      );
    }

    const outcome = this.state.storage.transactionSync(() => this.executeCommand(command));
    return json(outcome, 200);
  }

  /** Runs entirely inside one storage transaction. No awaits, no clock, no randomness. */
  private executeCommand(command: HubCommandV1): Record<string, JsonValue> {
    const sql = this.state.storage.sql;
    for (const ddl of SCHEMA_SQL) sql.exec(ddl);

    const existing = this.readReceipt(sql, command.commandId);
    const decision = decideDedup(existing, command.payloadHash);
    if (decision.kind === 'replay') {
      const receipt = decision.receipt;
      const replayResult: Record<string, JsonValue> = {
        outcome: receipt.outcome,
        replayed: true,
        revision: receipt.revision,
      };
      const stored = JSON.parse(receipt.resultJson) as Record<string, JsonValue>;
      if (receipt.outcome === 'accepted') {
        replayResult.result = stored;
        if (receipt.firstEventSequence !== undefined) replayResult.firstEventSequence = receipt.firstEventSequence;
        if (receipt.lastEventSequence !== undefined) replayResult.lastEventSequence = receipt.lastEventSequence;
        replayResult.events = this.readEventsForCommand(sql, command.commandId);
      } else {
        replayResult.rejection = stored;
      }
      return replayResult;
    }
    if (decision.kind === 'conflict') {
      return {
        outcome: 'rejected',
        replayed: false,
        revision: decision.receipt.revision,
        rejection: rejection('IDEMPOTENCY_KEY_REUSED', `commandId ${command.commandId} was already used with a different payload`, {
          commandId: command.commandId,
        }) as unknown as JsonValue,
      } as Record<string, JsonValue>;
    }

    const { state, revision } = this.readSnapshot(sql);
    const reducerCommand: ReducerCommand = {
      commandId: command.commandId,
      operation: command.operation,
      workspaceId: command.workspaceId,
      actorId: command.actor.agentId,
      issuedAt: command.issuedAt,
      context: command.context,
      payload: command.payload,
    };
    if (command.expectedRevision !== undefined) reducerCommand.expectedRevision = command.expectedRevision;

    const outcome = reduce(state, reducerCommand, revision);

    if (!outcome.ok) {
      this.writeReceipt(sql, command, {
        outcome: 'rejected',
        revision,
        resultJson: JSON.stringify(outcome.rejection),
      });
      return {
        outcome: 'rejected',
        replayed: false,
        revision,
        rejection: outcome.rejection as unknown as JsonValue,
      } as Record<string, JsonValue>;
    }

    const newRevision = revision + 1;
    const maxSeqRow = sql.exec(`SELECT COALESCE(MAX(sequence), 0) AS max_seq FROM events`).one();
    let sequence = Number(maxSeqRow.max_seq);
    const actor = { ...command.actor, ...command.context };
    const persistedEvents: Record<string, JsonValue>[] = [];
    for (const draft of outcome.events) {
      sequence += 1;
      const eventId = `${command.workspaceId}:${sequence}`;
      sql.exec(
        `INSERT INTO events (sequence, aggregate_revision, event_id, type, command_id, actor_json, occurred_at, data_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        sequence,
        newRevision,
        eventId,
        draft.type,
        command.commandId,
        JSON.stringify(actor),
        command.issuedAt,
        JSON.stringify(draft.data),
      );
      persistedEvents.push({
        eventId,
        sequence,
        aggregateRevision: newRevision,
        type: draft.type,
        data: draft.data,
        occurredAt: command.issuedAt,
      });
    }
    const firstEventSequence = persistedEvents.length > 0 ? Number(persistedEvents[0]?.sequence) : undefined;
    const lastEventSequence =
      persistedEvents.length > 0 ? Number(persistedEvents[persistedEvents.length - 1]?.sequence) : undefined;

    sql.exec(
      `INSERT INTO cell_meta (key, value) VALUES ('state', ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      JSON.stringify(outcome.state),
    );
    sql.exec(
      `INSERT INTO cell_meta (key, value) VALUES ('revision', ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      String(newRevision),
    );
    this.writeReceipt(sql, command, {
      outcome: 'accepted',
      revision: newRevision,
      resultJson: JSON.stringify(outcome.result),
      firstEventSequence,
      lastEventSequence,
    });

    const response: Record<string, JsonValue> = {
      outcome: 'accepted',
      replayed: false,
      revision: newRevision,
      result: outcome.result,
      events: persistedEvents as unknown as JsonValue,
    };
    if (firstEventSequence !== undefined) response.firstEventSequence = firstEventSequence;
    if (lastEventSequence !== undefined) response.lastEventSequence = lastEventSequence;
    return response;
  }

  private handleQuery(workspaceId: string, body: unknown): Response {
    if (typeof body !== 'object' || body === null) {
      return rejectionResponse(rejection('VALIDATION_FAILED', 'Query body must be an object'), 400);
    }
    const { operation, actorId, payload } = body as {
      operation?: unknown;
      actorId?: unknown;
      payload?: unknown;
    };
    if (typeof operation !== 'string' || typeof actorId !== 'string') {
      return rejectionResponse(rejection('VALIDATION_FAILED', 'Query requires operation and actorId strings'), 400);
    }
    const { state, revision } = this.state.storage.transactionSync(() => {
      const sql = this.state.storage.sql;
      for (const ddl of SCHEMA_SQL) sql.exec(ddl);
      return this.readSnapshot(sql);
    });
    const outcome = query(state, operation, actorId, (payload ?? {}) as Record<string, JsonValue>);
    if (!outcome.ok) {
      return json({ outcome: 'rejected', replayed: false, revision, rejection: outcome.rejection }, 200);
    }
    void workspaceId;
    return json({ outcome: 'accepted', replayed: false, revision, result: outcome.result }, 200);
  }

  private handleSnapshot(workspaceId: string): Response {
    const { state, revision, maxSequence } = this.state.storage.transactionSync(() => {
      const sql = this.state.storage.sql;
      for (const ddl of SCHEMA_SQL) sql.exec(ddl);
      const snapshot = this.readSnapshot(sql);
      const maxSeqRow = sql.exec(`SELECT COALESCE(MAX(sequence), 0) AS max_seq FROM events`).one();
      return { ...snapshot, maxSequence: Number(maxSeqRow.max_seq) };
    });
    return json({ workspaceId, revision, maxSequence, state });
  }

  private handleEvents(url: URL): Response {
    const after = Number(url.searchParams.get('after') ?? '0');
    const limitParam = Number(url.searchParams.get('limit') ?? '100');
    const limit = Number.isFinite(limitParam) && limitParam > 0 ? Math.min(Math.floor(limitParam), 1000) : 100;
    if (!Number.isFinite(after) || after < 0) {
      return rejectionResponse(rejection('VALIDATION_FAILED', `'after' must be a non-negative number`), 400);
    }
    const rows = this.state.storage.transactionSync(() => {
      const sql = this.state.storage.sql;
      for (const ddl of SCHEMA_SQL) sql.exec(ddl);
      return sql
        .exec(
          `SELECT sequence, aggregate_revision, event_id, type, command_id, actor_json, occurred_at, data_json
           FROM events WHERE sequence > ? ORDER BY sequence ASC LIMIT ?`,
          Math.floor(after),
          limit,
        )
        .toArray();
    });
    const events = rows.map(row => ({
      schemaVersion: 'hub-event-v1',
      eventId: String(row.event_id),
      workspaceId: undefined as unknown as string, // filled below from the cell context
      sequence: Number(row.sequence),
      aggregateRevision: Number(row.aggregate_revision),
      type: String(row.type),
      commandId: String(row.command_id),
      actor: JSON.parse(String(row.actor_json)) as Record<string, JsonValue>,
      occurredAt: String(row.occurred_at),
      data: JSON.parse(String(row.data_json)) as Record<string, JsonValue>,
    }));
    for (const event of events) {
      // eventId is `<workspaceId>:<sequence>`; recover the workspaceId prefix.
      event.workspaceId = event.eventId.slice(0, event.eventId.lastIndexOf(':'));
    }
    return json({ events, count: events.length });
  }

  // ---------------------------------------------------------------------------

  private readSnapshot(sql: CellSqlStorage): { state: CellWorkspaceState | null; revision: number } {
    const rows = sql.exec(`SELECT key, value FROM cell_meta WHERE key IN ('state', 'revision')`).toArray();
    let state: CellWorkspaceState | null = null;
    let revision = 0;
    for (const row of rows) {
      if (row.key === 'state') state = JSON.parse(String(row.value)) as CellWorkspaceState;
      if (row.key === 'revision') revision = Number(row.value);
    }
    return { state, revision };
  }

  private readReceipt(sql: CellSqlStorage, commandId: string): StoredReceipt | undefined {
    const rows = sql
      .exec(
        `SELECT command_id, payload_hash, outcome, revision, result_json, first_event_sequence, last_event_sequence
         FROM command_receipts WHERE command_id = ?`,
        commandId,
      )
      .toArray();
    const row = rows[0];
    if (row === undefined) return undefined;
    const receipt: StoredReceipt = {
      commandId: String(row.command_id),
      payloadHash: String(row.payload_hash),
      outcome: row.outcome === 'accepted' ? 'accepted' : 'rejected',
      revision: Number(row.revision),
      resultJson: String(row.result_json),
    };
    if (row.first_event_sequence !== null) receipt.firstEventSequence = Number(row.first_event_sequence);
    if (row.last_event_sequence !== null) receipt.lastEventSequence = Number(row.last_event_sequence);
    return receipt;
  }

  private writeReceipt(
    sql: CellSqlStorage,
    command: HubCommandV1,
    receipt: {
      outcome: 'accepted' | 'rejected';
      revision: number;
      resultJson: string;
      firstEventSequence?: number;
      lastEventSequence?: number;
    },
  ): void {
    sql.exec(
      `INSERT INTO command_receipts
         (command_id, payload_hash, outcome, revision, result_json, first_event_sequence, last_event_sequence, issued_at, recorded_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      command.commandId,
      command.payloadHash,
      receipt.outcome,
      receipt.revision,
      receipt.resultJson,
      receipt.firstEventSequence ?? null,
      receipt.lastEventSequence ?? null,
      command.issuedAt,
      command.issuedAt,
    );
  }

  private readEventsForCommand(sql: CellSqlStorage, commandId: string): JsonValue {
    return sql
      .exec(
        `SELECT sequence, aggregate_revision, event_id, type, occurred_at, data_json
         FROM events WHERE command_id = ? ORDER BY sequence ASC`,
        commandId,
      )
      .toArray()
      .map(row => ({
        eventId: String(row.event_id),
        sequence: Number(row.sequence),
        aggregateRevision: Number(row.aggregate_revision),
        type: String(row.type),
        occurredAt: String(row.occurred_at),
        data: JSON.parse(String(row.data_json)) as JsonValue,
      })) as unknown as JsonValue;
  }
}

// Sanity export used by the deploy smoke: proves canonicalJson bundles into the worker.
export const CANONICAL_PROBE = canonicalJson({ probe: 'workspace-cell' });

// The apply function must stay reachable from the worker bundle so replay
// verification can one day run cell-side; referencing it here also guarantees
// bundler-level type compatibility between reducer and worker.
export const REPLAY_AUTHORITY = apply;

export default {
  async fetch(request: Request, env: WorkerEnv): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === '/health') return new Response('ok');
    const match = /^\/v1\/workspaces\/([^/]+)\//.exec(url.pathname);
    if (match === null) return json({ error: 'not found', path: url.pathname }, 404);
    const id = env.WORKSPACES.idFromName(decodeURIComponent(match[1] as string));
    return env.WORKSPACES.get(id).fetch(request);
  },
};
