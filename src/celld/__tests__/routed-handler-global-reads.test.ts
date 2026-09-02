/**
 * whoami / list_workspaces across backends (RFC 0001).
 *
 * Both operations are global — they carry no workspaceId, so routing cannot
 * pick a cell — yet a member of a celld workspace must see it from whoami
 * and list_workspaces exactly as workspace_status and the HTTP read model
 * already report it. The filesystem half still comes from the inner handler
 * unchanged; the celld half is merged from active routes + cell snapshots.
 */

import { describe, expect, it } from 'vitest';
import type { HubHandler } from '../../hub/hub-handler.js';
import type { BackendRegistry, WorkspaceRoute } from '../backend-registry.js';
import type { CellSnapshot, CellTransport } from '../client.js';
import type { CellWorkspaceState } from '../domain/state.js';
import { createRoutedHubHandler } from '../routed-handler.js';

function registryOf(routes: WorkspaceRoute[]): BackendRegistry {
  const byId = new Map(routes.map(route => [route.workspaceId, route]));
  return {
    get: async id => byId.get(id),
    list: async () => [...byId.values()],
    findByCommandId: async commandId => [...byId.values()].find(route => route.commandId === commandId),
    findOrBeginProvisioning: async () => {
      throw new Error('not used');
    },
    markActive: async () => {
      throw new Error('not used');
    },
  };
}

function route(workspaceId: string, status: WorkspaceRoute['status'] = 'active'): WorkspaceRoute {
  return { workspaceId, backend: 'celld', status, commandId: `create-${workspaceId}`, createdAt: '2026-08-07T00:00:00.000Z' };
}

function cellState(workspaceId: string, members: string[], problemCount = 0): CellWorkspaceState {
  const state: CellWorkspaceState = {
    schemaVersion: 'workspace-state-v1',
    workspace: {
      id: workspaceId,
      name: `name-${workspaceId}`,
      description: '',
      createdBy: members[0] ?? 'nobody',
      createdAt: '2026-08-07T00:00:00.000Z',
      updatedAt: '2026-08-07T00:00:00.000Z',
    },
    members: {},
    problems: {},
    channels: {},
    intents: {},
    impacts: {},
    changes: {},
  };
  for (const [index, agentId] of members.entries()) {
    state.members[agentId] = { agentId, role: index === 0 ? 'coordinator' : 'contributor', joinedAt: '2026-08-07T00:00:00.000Z' };
  }
  for (let i = 0; i < problemCount; i++) {
    state.problems[`p${i}`] = {
      id: `p${i}`,
      workspaceId,
      title: 't',
      description: 'd',
      createdBy: members[0] ?? 'nobody',
      status: 'open',
      branchFromThought: 0,
      createdAt: '2026-08-07T00:00:00.000Z',
      updatedAt: '2026-08-07T00:00:00.000Z',
    };
  }
  return state;
}

/** Snapshot-only transport: `snapshots` maps workspaceId → state, null state, or a thrown error. */
function snapshotTransport(
  snapshots: Record<string, CellWorkspaceState | null | Error>,
): CellTransport & { snapshotCalls: string[] } {
  const snapshotCalls: string[] = [];
  return {
    snapshotCalls,
    async command() {
      throw new Error('not used');
    },
    async query() {
      throw new Error('not used');
    },
    async snapshot(workspaceId): Promise<CellSnapshot> {
      snapshotCalls.push(workspaceId);
      const entry = snapshots[workspaceId];
      if (entry instanceof Error) throw entry;
      return { workspaceId, revision: entry === null ? 0 : 3, maxSequence: entry === null ? 0 : 3, state: entry ?? null };
    },
    async events() {
      return { events: [], count: 0 };
    },
    async health() {
      return true;
    },
  };
}

function innerReturning(perOperation: Record<string, unknown>): HubHandler & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async handle(_agentId, operation) {
      calls.push(operation);
      if (operation in perOperation) return perOperation[operation];
      throw new Error(`unexpected inner operation ${operation}`);
    },
  };
}

const FS_WHOAMI = { agentId: 'agent-1', name: 'One', role: 'contributor', workspaces: ['ws-fs'], profile: 'REVIEWER' };
const FS_LIST = { workspaces: [{ id: 'ws-fs', name: 'fs', agentCount: 1, problemCount: 2 }] };

describe('whoami across backends', () => {
  it('includes every active celld workspace the agent is a member of, after the filesystem ones', async () => {
    const inner = innerReturning({ whoami: FS_WHOAMI });
    const routed = createRoutedHubHandler({
      inner,
      registry: registryOf([route('ws-a'), route('ws-b'), route('ws-c')]),
      transport: snapshotTransport({
        'ws-a': cellState('ws-a', ['agent-1', 'agent-2']),
        'ws-b': cellState('ws-b', ['agent-2']),
        'ws-c': cellState('ws-c', ['agent-9', 'agent-1']),
      }),
    });
    const result = (await routed.handle('agent-1', 'whoami', {})) as typeof FS_WHOAMI;
    expect(inner.calls).toEqual(['whoami']);
    expect(result.workspaces).toEqual(['ws-fs', 'ws-a', 'ws-c']);
    // Everything else the inner handler said is preserved verbatim.
    expect(result).toMatchObject({ agentId: 'agent-1', name: 'One', role: 'contributor', profile: 'REVIEWER' });
  });

  it('reports a celld-only member (filesystem says workspaces: [])', async () => {
    const routed = createRoutedHubHandler({
      inner: innerReturning({ whoami: { ...FS_WHOAMI, workspaces: [] } }),
      registry: registryOf([route('ws-a')]),
      transport: snapshotTransport({ 'ws-a': cellState('ws-a', ['agent-1']) }),
    });
    const result = (await routed.handle('agent-1', 'whoami', {})) as { workspaces: string[] };
    expect(result.workspaces).toEqual(['ws-a']);
  });

  it('skips provisioning routes, uninitialized cells, unreachable cells, and non-memberships', async () => {
    const transport = snapshotTransport({
      'ws-active': cellState('ws-active', ['agent-1']),
      'ws-empty': null,
      'ws-down': new Error('cell unreachable'),
      'ws-other': cellState('ws-other', ['agent-2']),
    });
    const routed = createRoutedHubHandler({
      inner: innerReturning({ whoami: { ...FS_WHOAMI, workspaces: [] } }),
      registry: registryOf([
        route('ws-active'),
        route('ws-provisioning', 'provisioning'),
        route('ws-empty'),
        route('ws-down'),
        route('ws-other'),
      ]),
      transport,
    });
    const result = (await routed.handle('agent-1', 'whoami', {})) as { workspaces: string[] };
    expect(result.workspaces).toEqual(['ws-active']);
    expect(transport.snapshotCalls).not.toContain('ws-provisioning');
  });

  it('returns the inner result object untouched when no route is active', async () => {
    const routed = createRoutedHubHandler({
      inner: innerReturning({ whoami: FS_WHOAMI }),
      registry: registryOf([route('ws-provisioning', 'provisioning')]),
      transport: snapshotTransport({}),
    });
    const result = await routed.handle('agent-1', 'whoami', {});
    expect(result).toBe(FS_WHOAMI);
  });

  it('propagates inner errors (unknown agent) without consulting cells', async () => {
    const transport = snapshotTransport({ 'ws-a': cellState('ws-a', ['agent-1']) });
    const routed = createRoutedHubHandler({
      inner: {
        async handle() {
          throw new Error("Unknown agent 'agent-1'");
        },
      },
      registry: registryOf([route('ws-a')]),
      transport,
    });
    await expect(routed.handle('agent-1', 'whoami', {})).rejects.toThrow("Unknown agent 'agent-1'");
    expect(transport.snapshotCalls).toEqual([]);
  });
});

describe('list_workspaces across backends', () => {
  it('appends every active celld workspace with the same summary shape plus backend', async () => {
    const inner = innerReturning({ list_workspaces: FS_LIST });
    const routed = createRoutedHubHandler({
      inner,
      registry: registryOf([route('ws-a'), route('ws-b')]),
      transport: snapshotTransport({
        'ws-a': cellState('ws-a', ['agent-1', 'agent-2'], 3),
        'ws-b': cellState('ws-b', ['agent-2']),
      }),
    });
    const result = (await routed.handle(null, 'list_workspaces', {})) as { workspaces: unknown[] };
    expect(inner.calls).toEqual(['list_workspaces']);
    expect(result.workspaces).toEqual([
      { id: 'ws-fs', name: 'fs', agentCount: 1, problemCount: 2 },
      { id: 'ws-a', name: 'name-ws-a', agentCount: 2, problemCount: 3, backend: 'celld' },
      { id: 'ws-b', name: 'name-ws-b', agentCount: 1, problemCount: 0, backend: 'celld' },
    ]);
  });

  it('marks unreachable cells like the HTTP read model and skips provisioning / uninitialized ones', async () => {
    const routed = createRoutedHubHandler({
      inner: innerReturning({ list_workspaces: { workspaces: [] } }),
      registry: registryOf([route('ws-down'), route('ws-provisioning', 'provisioning'), route('ws-empty')]),
      transport: snapshotTransport({ 'ws-down': new Error('cell unreachable'), 'ws-empty': null }),
    });
    const result = (await routed.handle(null, 'list_workspaces', {})) as { workspaces: unknown[] };
    expect(result.workspaces).toEqual([{ id: 'ws-down', backend: 'celld', unreachable: true }]);
  });

  it('returns the inner result object untouched when no route is active', async () => {
    const routed = createRoutedHubHandler({
      inner: innerReturning({ list_workspaces: FS_LIST }),
      registry: registryOf([]),
      transport: snapshotTransport({}),
    });
    expect(await routed.handle(null, 'list_workspaces', {})).toBe(FS_LIST);
  });
});
