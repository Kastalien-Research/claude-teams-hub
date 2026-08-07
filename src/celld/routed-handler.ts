/**
 * Routed hub handler (RFC 0001 §Decisions).
 *
 * Wraps the filesystem HubHandler and routes each call by the workspace's
 * backend: filesystem workspaces flow to the inner handler byte-for-byte
 * unchanged; workspaces with an active celld route become cell commands and
 * queries. Routing happens at this high-level boundary deliberately — there
 * is no record-level storage adapter, so claims, membership, impacts,
 * receipts, and events commit together inside one cell transaction.
 *
 * Dependency direction: src/celld -> src/hub only (architecture-tested).
 * The hub never learns this module exists; composition injects it in
 * src/index.ts / server-factory.
 */

import { randomUUID } from 'node:crypto';
import type { HubEvent, HubHandler } from '../hub/hub-handler.js';
import { commandPayloadHash, type JsonValue } from './canonical-json.js';
import {
  commandMetadataV1Schema,
  COMMAND_SCHEMA_VERSION,
  isCelldMutation,
  isCelldSupportedOperation,
  CELLD_NEW_OPERATIONS,
  type CellCommandResult,
  type CommandMetadataV1,
  type HubCommandV1,
} from './contracts.js';
import { CelldError, rejection } from './errors.js';
import type { BackendRegistry } from './backend-registry.js';
import type { CellTransport } from './client.js';

export interface RoutedHubHandlerOptions {
  inner: HubHandler;
  transport: CellTransport;
  registry: BackendRegistry;
  /** SSE hint sink — same shape the inner handler emits; celld events carry
   *  the durable eventId inside `data` and consumers dedupe by it. */
  onEvent?: (event: HubEvent) => void;
}

interface PersistedCellEvent {
  eventId?: unknown;
  sequence?: unknown;
  aggregateRevision?: unknown;
  type?: unknown;
  data?: unknown;
  occurredAt?: unknown;
}

const NEW_OPERATIONS: ReadonlySet<string> = new Set(CELLD_NEW_OPERATIONS);

export function createRoutedHubHandler(options: RoutedHubHandlerOptions): HubHandler {
  const { inner, transport, registry, onEvent } = options;

  function emitCellEvents(workspaceId: string, commandId: string, events: unknown): void {
    if (onEvent === undefined || !Array.isArray(events)) return;
    for (const raw of events as PersistedCellEvent[]) {
      if (typeof raw?.type !== 'string') continue;
      onEvent({
        // The cell's event vocabulary is a subset of HubEventType plus the
        // four coordination types added alongside this canary; the parity
        // check pins both unions.
        type: raw.type as HubEvent['type'],
        workspaceId,
        data: {
          ...(typeof raw.data === 'object' && raw.data !== null ? (raw.data as Record<string, unknown>) : {}),
          eventId: raw.eventId,
          sequence: raw.sequence,
          aggregateRevision: raw.aggregateRevision,
          commandId,
        },
      });
    }
  }

  function requireCommandMetadata(args: Record<string, unknown>, operation: string): CommandMetadataV1 {
    const parsed = commandMetadataV1Schema.safeParse(args.command);
    if (!parsed.success) {
      throw new CelldError(
        rejection(
          'VALIDATION_FAILED',
          `${operation} on a celld workspace requires a 'command' object (CommandMetadataV1 with at least an id); see RFC 0001`,
          { issue: parsed.error.issues[0]?.message ?? 'missing' },
        ),
      );
    }
    return parsed.data;
  }

  async function buildCommand(
    operation: string,
    workspaceId: string,
    agentId: string,
    metadata: CommandMetadataV1,
    payload: Record<string, JsonValue>,
  ): Promise<HubCommandV1> {
    const command: HubCommandV1 = {
      schemaVersion: COMMAND_SCHEMA_VERSION,
      commandId: metadata.id,
      operation,
      workspaceId,
      actor: {
        agentId,
        ...(metadata.promptVersion !== undefined ? { promptVersion: metadata.promptVersion } : {}),
      },
      issuedAt: new Date().toISOString(),
      context: {
        ...(metadata.teamRunId !== undefined ? { teamRunId: metadata.teamRunId } : {}),
        ...(metadata.nativeTaskId !== undefined ? { nativeTaskId: metadata.nativeTaskId } : {}),
        ...(metadata.processRunId !== undefined ? { processRunId: metadata.processRunId } : {}),
      },
      payload,
      payloadHash: '',
    };
    if (metadata.expectedRevision !== undefined) command.expectedRevision = metadata.expectedRevision;
    if (metadata.correlationId !== undefined) command.correlationId = metadata.correlationId;
    if (metadata.causationId !== undefined) command.causationId = metadata.causationId;
    command.payloadHash = await commandPayloadHash(command);
    return command;
  }

  function coordinationOf(result: CellCommandResult, commandId?: string): Record<string, JsonValue> {
    const coordination: Record<string, JsonValue> = {
      backend: 'celld',
      revision: result.revision,
    };
    if (commandId !== undefined) coordination.commandId = commandId;
    if (result.replayed) coordination.replayed = true;
    if (result.firstEventSequence !== undefined) coordination.firstEventSequence = result.firstEventSequence;
    if (result.lastEventSequence !== undefined) coordination.lastEventSequence = result.lastEventSequence;
    return coordination;
  }

  function throwRejection(result: CellCommandResult): never {
    throw new CelldError(
      result.rejection ?? rejection('VALIDATION_FAILED', 'Cell rejected the command without a rejection body'),
    );
  }

  /** Strip envelope-level keys from args to form the cell payload. */
  function payloadOf(args: Record<string, unknown>): Record<string, JsonValue> {
    const { command: _command, workspaceId: _workspaceId, backend: _backend, agentId: _agentId, ...rest } = args;
    return rest as Record<string, JsonValue>;
  }

  async function executeCelldMutation(
    operation: string,
    workspaceId: string,
    agentId: string,
    args: Record<string, unknown>,
  ): Promise<unknown> {
    const metadata = requireCommandMetadata(args, operation);
    const command = await buildCommand(operation, workspaceId, agentId, metadata, payloadOf(args));
    const result = await transport.command(workspaceId, command);
    if (result.outcome !== 'accepted') throwRejection(result);
    // Replays may legitimately rebroadcast the same event IDs — a
    // commit-before-reply retry can make this the façade's first chance to
    // hint; SSE consumers dedupe by the durable eventId (RFC 0001).
    emitCellEvents(workspaceId, command.commandId, result.events);
    return {
      ...(result.result ?? {}),
      coordination: coordinationOf(result, command.commandId),
    };
  }

  async function executeCelldQuery(
    operation: string,
    workspaceId: string,
    agentId: string,
    args: Record<string, unknown>,
  ): Promise<unknown> {
    if (operation === 'read_workspace_events') {
      const after = typeof args.after === 'number' ? args.after : 0;
      const limit = typeof args.limit === 'number' ? args.limit : 100;
      const page = await transport.events(workspaceId, after, limit);
      const last = page.events[page.events.length - 1];
      return {
        events: page.events,
        count: page.count,
        coordination: {
          backend: 'celld',
          revision: last?.aggregateRevision ?? 0,
        },
      };
    }
    const result = await transport.query(workspaceId, operation, agentId, payloadOf(args));
    if (result.outcome !== 'accepted') throwRejection(result);
    return {
      ...(result.result ?? {}),
      coordination: coordinationOf(result),
    };
  }

  async function createCelldWorkspace(agentId: string, args: Record<string, unknown>): Promise<unknown> {
    const metadata = requireCommandMetadata(args, 'create_workspace');

    // A retry with the same command ID resumes the SAME workspace: the
    // provisioning route is keyed by the creating command (RFC 0001).
    const existing = await registry.findByCommandId(metadata.id);
    const workspaceId = existing?.workspaceId ?? `ws-${randomUUID()}`;
    await registry.beginProvisioning(workspaceId, metadata.id);

    const command = await buildCommand('create_workspace', workspaceId, agentId, metadata, {
      name: String(args.name ?? ''),
      description: String(args.description ?? ''),
    });
    const result = await transport.command(workspaceId, command);
    if (result.outcome !== 'accepted') throwRejection(result);

    // Verify the cell actually holds the initialized aggregate before the
    // route goes active — an active route never falls back to filesystem.
    const snapshot = await transport.snapshot(workspaceId);
    if (snapshot.revision < 1 || snapshot.state === null) {
      throw new CelldError(
        rejection('CELLD_UNAVAILABLE', `Cell for ${workspaceId} did not verify after create (revision ${snapshot.revision})`),
      );
    }
    await registry.markActive(workspaceId);

    emitCellEvents(workspaceId, command.commandId, result.events);
    return {
      ...(result.result ?? {}),
      workspaceId,
      // Compatibility with thought-tool callers: celld workspaces carry a
      // synthetic main session; thought-branch integration is deferred.
      mainSessionId: `celld:${workspaceId}`,
      coordination: coordinationOf(result, command.commandId),
    };
  }

  return {
    async handle(agentId, operation, args, requestPrincipal) {
      const record = (args ?? {}) as Record<string, unknown>;

      if (operation === 'create_workspace' && record.backend === 'celld') {
        if (agentId === null) throw new Error('create_workspace requires a resolved agentId');
        return createCelldWorkspace(agentId, record);
      }

      const workspaceId = typeof record.workspaceId === 'string' ? record.workspaceId : undefined;
      const route = workspaceId !== undefined ? await registry.get(workspaceId) : undefined;

      if (route === undefined) {
        // Filesystem path. The five coordination operations must never reach
        // filesystem storage — reject before delegating (RFC 0001).
        if (NEW_OPERATIONS.has(operation)) {
          throw new CelldError(
            rejection(
              'OPERATION_REQUIRES_CELLD_BACKEND',
              `${operation} requires a celld-backed workspace; workspace ${workspaceId ?? '(none)'} is not routed to celld`,
            ),
          );
        }
        return inner.handle(agentId, operation, args, requestPrincipal);
      }

      // Routed workspace. Never fall back to filesystem — a provisioning
      // route is not yet writable and an unreachable cell stays celld's.
      if (route.status !== 'active') {
        throw new CelldError(
          rejection('CELLD_UNAVAILABLE', `Workspace ${route.workspaceId} is still provisioning (command ${route.commandId})`),
        );
      }
      if (!isCelldSupportedOperation(operation)) {
        throw new CelldError(
          rejection(
            'CELLD_CANARY_OPERATION_UNSUPPORTED',
            `${operation} is not part of the celld canary surface (RFC 0001 §Operation surface)`,
            { operation },
          ),
        );
      }
      if (agentId === null) throw new Error(`${operation} requires a resolved agentId`);
      if (isCelldMutation(operation)) {
        return executeCelldMutation(operation, route.workspaceId, agentId, record);
      }
      return executeCelldQuery(operation, route.workspaceId, agentId, record);
    },
  };
}
