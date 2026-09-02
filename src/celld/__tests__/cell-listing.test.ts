/**
 * listActiveCells (RFC 0001): the shared enumeration behind whoami,
 * list_workspaces, and the HTTP workspace listing.
 *
 * Two properties beyond "unreachable cells are isolated":
 *  - snapshots are taken concurrently, so N slow cells cost one timeout, not N;
 *  - a cell that answers 200 with a state this reader cannot interpret is
 *    reported unreachable instead of throwing out of the whole read.
 */

import { describe, expect, it } from 'vitest';
import type { BackendRegistry, WorkspaceRoute } from '../backend-registry.js';
import type { CellSnapshot, CellTransport } from '../client.js';
import { listActiveCells } from '../cell-listing.js';
import type { CellWorkspaceState } from '../domain/state.js';

function route(workspaceId: string, status: WorkspaceRoute['status'] = 'active'): WorkspaceRoute {
  return { workspaceId, backend: 'celld', status, commandId: `create-${workspaceId}`, createdAt: '2026-08-07T00:00:00.000Z' };
}

function registryOf(routes: WorkspaceRoute[]): BackendRegistry {
  return {
    get: async id => routes.find(r => r.workspaceId === id),
    list: async () => [...routes],
    findByCommandId: async commandId => routes.find(r => r.commandId === commandId),
    findOrBeginProvisioning: async () => {
      throw new Error('not used');
    },
    markActive: async () => {
      throw new Error('not used');
    },
  };
}

function state(workspaceId: string): CellWorkspaceState {
  return {
    schemaVersion: 'workspace-state-v1',
    workspace: {
      id: workspaceId,
      name: `name-${workspaceId}`,
      description: '',
      createdBy: 'a',
      createdAt: '2026-08-07T00:00:00.000Z',
      updatedAt: '2026-08-07T00:00:00.000Z',
    },
    members: { a: { agentId: 'a', role: 'coordinator', joinedAt: '2026-08-07T00:00:00.000Z' } },
    problems: {},
    channels: {},
    intents: {},
    impacts: {},
    changes: {},
  };
}

/** `answers` maps workspaceId → a function producing the snapshot state (or throwing). */
function transportOf(answers: Record<string, () => Promise<unknown>>): CellTransport & { inFlight: number; maxInFlight: number } {
  const t = {
    inFlight: 0,
    maxInFlight: 0,
    async command() {
      throw new Error('not used');
    },
    async query() {
      throw new Error('not used');
    },
    async snapshot(workspaceId: string): Promise<CellSnapshot> {
      t.inFlight += 1;
      t.maxInFlight = Math.max(t.maxInFlight, t.inFlight);
      try {
        const answer = answers[workspaceId];
        if (answer === undefined) throw new Error(`no answer for ${workspaceId}`);
        const s = await answer();
        return { workspaceId, revision: 1, maxSequence: 1, state: s };
      } finally {
        t.inFlight -= 1;
      }
    },
    async events() {
      return { events: [], count: 0 };
    },
    async health() {
      return true;
    },
  };
  return t;
}

const tick = () => new Promise<void>(resolve => setTimeout(resolve, 5));

describe('listActiveCells', () => {
  it('snapshots every active route concurrently, not one after another', async () => {
    const ids = ['ws-1', 'ws-2', 'ws-3', 'ws-4'];
    const transport = transportOf(
      Object.fromEntries(ids.map(id => [id, async () => (await tick(), state(id))])),
    );
    const cells = await listActiveCells(registryOf(ids.map(id => route(id))), transport);

    expect(cells.map(c => c.route.workspaceId)).toEqual(ids);
    expect(cells.every(c => !c.unreachable)).toBe(true);
    expect(transport.maxInFlight).toBe(ids.length);
  });

  it('one unreachable cell hides only itself and does not delay the rest', async () => {
    const transport = transportOf({
      'ws-ok': async () => state('ws-ok'),
      'ws-dead': async () => (await tick(), Promise.reject(new Error('ECONNREFUSED'))),
      'ws-ok-2': async () => state('ws-ok-2'),
    });
    const cells = await listActiveCells(registryOf([route('ws-ok'), route('ws-dead'), route('ws-ok-2')]), transport);

    expect(cells.map(c => [c.route.workspaceId, c.unreachable])).toEqual([
      ['ws-ok', false],
      ['ws-dead', true],
      ['ws-ok-2', false],
    ]);
  });

  it('reports a cell whose 200 response is not a workspace state as unreachable instead of throwing', async () => {
    const transport = transportOf({
      'ws-ok': async () => state('ws-ok'),
      'ws-garbage': async () => ({ hello: 'world' }),
      'ws-no-members': async () => ({ ...state('ws-no-members'), members: undefined }),
      'ws-array': async () => [],
      'ws-null': async () => null,
    });
    const cells = await listActiveCells(
      registryOf([route('ws-ok'), route('ws-garbage'), route('ws-no-members'), route('ws-array'), route('ws-null')]),
      transport,
    );

    expect(cells.map(c => [c.route.workspaceId, c.unreachable])).toEqual([
      ['ws-ok', false],
      ['ws-garbage', true],
      ['ws-no-members', true],
      ['ws-array', true],
    ]);
  });

  it('omits provisioning routes and cells that have no state yet', async () => {
    const transport = transportOf({ 'ws-ok': async () => state('ws-ok'), 'ws-empty': async () => null });
    const cells = await listActiveCells(
      registryOf([route('ws-ok'), route('ws-empty'), route('ws-provisioning', 'provisioning')]),
      transport,
    );
    expect(cells.map(c => c.route.workspaceId)).toEqual(['ws-ok']);
  });
});
