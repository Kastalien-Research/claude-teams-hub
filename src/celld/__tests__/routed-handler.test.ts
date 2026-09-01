/**
 * Routed hub handler tests (RFC 0001).
 *
 * The filesystem regression bar: for a workspace with NO celld route, the
 * routed handler must delegate to the inner handler with IDENTICAL arguments
 * and return the inner result object untouched — the existing hub-handler
 * suite then covers real filesystem behavior. The celld path is tested
 * against a fake CellTransport that records every envelope.
 */

import { describe, expect, it } from 'vitest';
import type { HubEvent, HubHandler } from '../../hub/hub-handler.js';
import { commandPayloadHash } from '../canonical-json.js';
import type { CellCommandResult } from '../contracts.js';
import { CelldError } from '../errors.js';
import type { BackendRegistry, WorkspaceRoute } from '../backend-registry.js';
import type { CellSnapshot, CellTransport } from '../client.js';
import { createRoutedHubHandler } from '../routed-handler.js';

function memoryRegistry(initial: WorkspaceRoute[] = []): BackendRegistry & { routes: Map<string, WorkspaceRoute> } {
  const routes = new Map(initial.map(route => [route.workspaceId, route]));
  return {
    routes,
    get: async id => routes.get(id),
    list: async () => [...routes.values()],
    findByCommandId: async commandId => [...routes.values()].find(route => route.commandId === commandId),
    findOrBeginProvisioning: async (commandId, candidateWorkspaceId) => {
      const existing = [...routes.values()].find(route => route.commandId === commandId);
      if (existing !== undefined) return existing;
      const route: WorkspaceRoute = {
        workspaceId: candidateWorkspaceId,
        backend: 'celld',
        status: 'provisioning',
        commandId,
        createdAt: new Date().toISOString(),
      };
      routes.set(candidateWorkspaceId, route);
      return route;
    },
    markActive: async workspaceId => {
      const route = routes.get(workspaceId);
      if (route === undefined) throw new Error(`no route ${workspaceId}`);
      routes.set(workspaceId, { ...route, status: 'active', activatedAt: new Date().toISOString() });
    },
  };
}

interface RecordedCall {
  kind: 'command' | 'query' | 'snapshot' | 'events';
  workspaceId: string;
  payload?: unknown;
}

function fakeTransport(overrides?: {
  commandResult?: (command: Record<string, unknown>) => CellCommandResult & { events?: unknown[] };
  queryResult?: (operation: string, actorId: string) => CellCommandResult;
  snapshot?: CellSnapshot;
}): CellTransport & { calls: RecordedCall[]; commands: Record<string, unknown>[] } {
  const calls: RecordedCall[] = [];
  const commands: Record<string, unknown>[] = [];
  return {
    calls,
    commands,
    async command(workspaceId, command) {
      calls.push({ kind: 'command', workspaceId, payload: command });
      commands.push(command as unknown as Record<string, unknown>);
      return (
        overrides?.commandResult?.(command as unknown as Record<string, unknown>) ?? {
          outcome: 'accepted',
          replayed: false,
          revision: 1,
          result: { ok: true },
          events: [
            {
              eventId: `${workspaceId}:1`,
              sequence: 1,
              aggregateRevision: 1,
              type: 'problem_created',
              data: { marker: 'from-cell' },
              occurredAt: '2026-08-07T00:00:00.000Z',
            },
          ],
          firstEventSequence: 1,
          lastEventSequence: 1,
        }
      );
    },
    async query(workspaceId, operation, actorId, payload) {
      calls.push({ kind: 'query', workspaceId, payload: { operation, actorId, payload } });
      return (
        overrides?.queryResult?.(operation, actorId) ?? {
          outcome: 'accepted',
          replayed: false,
          revision: 7,
          result: { queried: operation },
        }
      );
    },
    async snapshot(workspaceId) {
      calls.push({ kind: 'snapshot', workspaceId });
      return (
        overrides?.snapshot ?? {
          workspaceId,
          revision: 1,
          maxSequence: 1,
          state: { schemaVersion: 'workspace-state-v1' },
        }
      );
    },
    async events(workspaceId, after, limit) {
      calls.push({ kind: 'events', workspaceId, payload: { after, limit } });
      return { events: [], count: 0 };
    },
    async health() {
      return true;
    },
  };
}

function echoInner(): HubHandler & { calls: Array<{ agentId: string | null; operation: string; args: unknown }> } {
  const calls: Array<{ agentId: string | null; operation: string; args: unknown }> = [];
  const result = { echoed: true };
  return {
    calls,
    async handle(agentId, operation, args) {
      calls.push({ agentId, operation, args });
      return result;
    },
  };
}

const CMD = { id: 'cmd-1', teamRunId: 'run-1' };

describe('routed handler — filesystem passthrough', () => {
  it('delegates unrouted workspaces to the inner handler with identical args and result', async () => {
    const inner = echoInner();
    const routed = createRoutedHubHandler({ inner, transport: fakeTransport(), registry: memoryRegistry() });
    const args = { workspaceId: 'ws-fs', title: 't', description: 'd' };
    const result = await routed.handle('agent-1', 'create_problem', args);
    expect(inner.calls).toHaveLength(1);
    expect(inner.calls[0]).toEqual({ agentId: 'agent-1', operation: 'create_problem', args });
    expect(inner.calls[0]?.args).toBe(args); // identity, not copy
    expect(result).toEqual({ echoed: true });
  });

  it('delegates stage-0/1 operations without workspaceId untouched', async () => {
    const inner = echoInner();
    const routed = createRoutedHubHandler({ inner, transport: fakeTransport(), registry: memoryRegistry() });
    for (const operation of ['register', 'whoami', 'list_workspaces', 'record_decision', 'consult_decisions']) {
      await routed.handle('agent-1', operation, { name: 'x' });
    }
    expect(inner.calls.map(call => call.operation)).toEqual([
      'register',
      'whoami',
      'list_workspaces',
      'record_decision',
      'consult_decisions',
    ]);
  });

  it('rejects the five coordination ops on unrouted workspaces BEFORE inner/storage', async () => {
    const inner = echoInner();
    const transport = fakeTransport();
    const routed = createRoutedHubHandler({ inner, transport, registry: memoryRegistry() });
    for (const operation of [
      'declare_work_intent',
      'record_work_change',
      'list_impacts',
      'acknowledge_impact',
      'read_workspace_events',
    ]) {
      await expect(routed.handle('agent-1', operation, { workspaceId: 'ws-fs' })).rejects.toMatchObject({
        code: 'OPERATION_REQUIRES_CELLD_BACKEND',
      });
    }
    expect(inner.calls).toHaveLength(0);
    expect(transport.calls).toHaveLength(0);
  });
});

describe('routed handler — celld path', () => {
  const activeRoute: WorkspaceRoute = {
    workspaceId: 'ws-cell',
    backend: 'celld',
    status: 'active',
    commandId: 'create-cmd',
    createdAt: '2026-08-07T00:00:00.000Z',
  };

  it('builds a valid envelope: commandId, payloadHash, actor/context mapping — and never touches inner', async () => {
    const inner = echoInner();
    const transport = fakeTransport();
    const routed = createRoutedHubHandler({ inner, transport, registry: memoryRegistry([activeRoute]) });
    await routed.handle('agent-1', 'create_problem', {
      workspaceId: 'ws-cell',
      title: 't',
      description: 'd',
      command: { id: 'cmd-9', teamRunId: 'run-9', nativeTaskId: 'task-9', promptVersion: 'pv1', expectedRevision: 3 },
    });
    expect(inner.calls).toHaveLength(0);
    expect(transport.commands).toHaveLength(1);
    const sent = transport.commands[0] as Record<string, unknown>;
    expect(sent.commandId).toBe('cmd-9');
    expect(sent.operation).toBe('create_problem');
    expect(sent.workspaceId).toBe('ws-cell');
    expect(sent.actor).toEqual({ agentId: 'agent-1', promptVersion: 'pv1' });
    expect(sent.context).toEqual({ teamRunId: 'run-9', nativeTaskId: 'task-9' });
    expect(sent.expectedRevision).toBe(3);
    // payload excludes envelope-level keys
    expect(sent.payload).toEqual({ title: 't', description: 'd' });
    // hash is the canonical hash of the sent envelope
    expect(sent.payloadHash).toBe(await commandPayloadHash(sent as never));
  });

  it('adds the coordination envelope to accepted results', async () => {
    const routed = createRoutedHubHandler({
      inner: echoInner(),
      transport: fakeTransport(),
      registry: memoryRegistry([activeRoute]),
    });
    const result = (await routed.handle('agent-1', 'post_message', {
      workspaceId: 'ws-cell',
      problemId: 'p1',
      content: 'hi',
      command: CMD,
    })) as Record<string, unknown>;
    expect(result.ok).toBe(true);
    expect(result.coordination).toEqual({
      backend: 'celld',
      revision: 1,
      commandId: 'cmd-1',
      firstEventSequence: 1,
      lastEventSequence: 1,
    });
  });

  it('surfaces cell rejections as coded CelldErrors', async () => {
    const routed = createRoutedHubHandler({
      inner: echoInner(),
      transport: fakeTransport({
        commandResult: () => ({
          outcome: 'rejected',
          replayed: false,
          revision: 5,
          rejection: { code: 'PROBLEM_ALREADY_CLAIMED', message: 'taken', retryable: false },
        }),
      }),
      registry: memoryRegistry([activeRoute]),
    });
    await expect(
      routed.handle('agent-1', 'claim_problem', { workspaceId: 'ws-cell', problemId: 'p1', command: CMD }),
    ).rejects.toMatchObject({ code: 'PROBLEM_ALREADY_CLAIMED', retryable: false });
  });

  it('requires command metadata on mutations', async () => {
    const routed = createRoutedHubHandler({
      inner: echoInner(),
      transport: fakeTransport(),
      registry: memoryRegistry([activeRoute]),
    });
    await expect(
      routed.handle('agent-1', 'claim_problem', { workspaceId: 'ws-cell', problemId: 'p1' }),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });

  it('rejects non-canary operations with CELLD_CANARY_OPERATION_UNSUPPORTED and never forwards them', async () => {
    const inner = echoInner();
    const transport = fakeTransport();
    const routed = createRoutedHubHandler({ inner, transport, registry: memoryRegistry([activeRoute]) });
    for (const operation of [
      'quick_join',
      'transfer_coordinator',
      'add_dependency',
      'create_sub_problem',
      'create_proposal',
      'mark_consensus',
      'post_system_message',
    ]) {
      await expect(routed.handle('agent-1', operation, { workspaceId: 'ws-cell' })).rejects.toMatchObject({
        code: 'CELLD_CANARY_OPERATION_UNSUPPORTED',
      });
    }
    expect(inner.calls).toHaveLength(0);
    expect(transport.calls).toHaveLength(0);
  });

  it('a provisioning route never falls back and never reaches the cell', async () => {
    const inner = echoInner();
    const transport = fakeTransport();
    const routed = createRoutedHubHandler({
      inner,
      transport,
      registry: memoryRegistry([{ ...activeRoute, status: 'provisioning' }]),
    });
    await expect(
      routed.handle('agent-1', 'create_problem', { workspaceId: 'ws-cell', title: 't', description: 'd', command: CMD }),
    ).rejects.toMatchObject({ code: 'CELLD_UNAVAILABLE', retryable: true });
    expect(inner.calls).toHaveLength(0);
    expect(transport.calls).toHaveLength(0);
  });

  it('read_workspace_events authorizes membership through the cell query path before reading the journal', async () => {
    const transport = fakeTransport();
    const routed = createRoutedHubHandler({
      inner: echoInner(),
      transport,
      registry: memoryRegistry([activeRoute]),
    });
    await routed.handle('agent-1', 'read_workspace_events', { workspaceId: 'ws-cell' });
    const membershipCheck = transport.calls.find(call => call.kind === 'query');
    expect(membershipCheck?.payload).toMatchObject({ operation: 'workspace_status', actorId: 'agent-1' });
    expect(transport.calls.map(call => call.kind)).toEqual(['query', 'events']);
  });

  it('read_workspace_events rejects a non-member without touching the journal', async () => {
    const transport = fakeTransport({
      queryResult: () => ({
        outcome: 'rejected',
        replayed: false,
        revision: 7,
        rejection: { code: 'NOT_WORKSPACE_MEMBER', message: 'Agent outsider is not a member', retryable: false },
      }),
    });
    const routed = createRoutedHubHandler({
      inner: echoInner(),
      transport,
      registry: memoryRegistry([activeRoute]),
    });
    await expect(
      routed.handle('outsider', 'read_workspace_events', { workspaceId: 'ws-cell' }),
    ).rejects.toMatchObject({ code: 'NOT_WORKSPACE_MEMBER' });
    expect(transport.calls.every(call => call.kind !== 'events')).toBe(true);
  });

  it('routes queries through transport.query and read_workspace_events through transport.events', async () => {
    const transport = fakeTransport();
    const routed = createRoutedHubHandler({
      inner: echoInner(),
      transport,
      registry: memoryRegistry([activeRoute]),
    });
    const status = (await routed.handle('agent-1', 'workspace_status', { workspaceId: 'ws-cell' })) as Record<
      string,
      unknown
    >;
    expect(status.queried).toBe('workspace_status');
    expect(status.coordination).toEqual({ backend: 'celld', revision: 7 });

    const events = (await routed.handle('agent-1', 'read_workspace_events', {
      workspaceId: 'ws-cell',
      after: 5,
      limit: 10,
    })) as Record<string, unknown>;
    expect(events.count).toBe(0);
    expect(transport.calls.at(-1)).toEqual({ kind: 'events', workspaceId: 'ws-cell', payload: { after: 5, limit: 10 } });
  });

  it('emits SSE hints carrying the durable eventId inside data', async () => {
    const seen: HubEvent[] = [];
    const routed = createRoutedHubHandler({
      inner: echoInner(),
      transport: fakeTransport(),
      registry: memoryRegistry([activeRoute]),
      onEvent: event => seen.push(event),
    });
    await routed.handle('agent-1', 'create_problem', {
      workspaceId: 'ws-cell',
      title: 't',
      description: 'd',
      command: CMD,
    });
    expect(seen).toHaveLength(1);
    expect(seen[0]?.type).toBe('problem_created');
    expect(seen[0]?.workspaceId).toBe('ws-cell');
    expect(seen[0]?.data).toMatchObject({ marker: 'from-cell', eventId: 'ws-cell:1', sequence: 1, commandId: 'cmd-1' });
  });
});

describe('routed handler — celld create_workspace flow', () => {
  it('provisions, creates, verifies the snapshot, then activates', async () => {
    const registry = memoryRegistry();
    const transport = fakeTransport();
    const routed = createRoutedHubHandler({ inner: echoInner(), transport, registry });
    const result = (await routed.handle('agent-1', 'create_workspace', {
      backend: 'celld',
      name: 'w',
      description: 'd',
      command: { id: 'create-1', teamRunId: 'run-1' },
    })) as Record<string, unknown>;

    const workspaceId = result.workspaceId as string;
    expect(workspaceId).toMatch(/^ws-/);
    expect(result.mainSessionId).toBe(`celld:${workspaceId}`);
    expect(registry.routes.get(workspaceId)?.status).toBe('active');
    expect(transport.calls.map(call => call.kind)).toEqual(['command', 'snapshot']);
  });

  it('a retry with the same command ID resumes the same workspace', async () => {
    const registry = memoryRegistry();
    const transport = fakeTransport();
    const routed = createRoutedHubHandler({ inner: echoInner(), transport, registry });
    const args = { backend: 'celld', name: 'w', description: 'd', command: { id: 'create-2', teamRunId: 'run-1' } };
    const first = (await routed.handle('agent-1', 'create_workspace', args)) as Record<string, unknown>;
    const second = (await routed.handle('agent-1', 'create_workspace', args)) as Record<string, unknown>;
    expect(second.workspaceId).toBe(first.workspaceId);
    expect(registry.routes.size).toBe(1);
  });

  it('does not activate the route when the snapshot fails verification', async () => {
    const registry = memoryRegistry();
    const transport = fakeTransport({
      snapshot: { workspaceId: 'x', revision: 0, maxSequence: 0, state: null },
    });
    const routed = createRoutedHubHandler({ inner: echoInner(), transport, registry });
    await expect(
      routed.handle('agent-1', 'create_workspace', {
        backend: 'celld',
        name: 'w',
        description: 'd',
        command: { id: 'create-3', teamRunId: 'run-1' },
      }),
    ).rejects.toBeInstanceOf(CelldError);
    const route = [...registry.routes.values()][0];
    expect(route?.status).toBe('provisioning');
  });

  it('filesystem create_workspace (no backend arg) still delegates to inner', async () => {
    const inner = echoInner();
    const routed = createRoutedHubHandler({ inner, transport: fakeTransport(), registry: memoryRegistry() });
    await routed.handle('agent-1', 'create_workspace', { name: 'w', description: 'd' });
    expect(inner.calls).toHaveLength(1);
  });
});
