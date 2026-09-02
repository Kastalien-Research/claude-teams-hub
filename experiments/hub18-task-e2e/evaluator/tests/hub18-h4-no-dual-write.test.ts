/**
 * hub18 H4 — no celld membership is copied into filesystem HubStorage: after
 * create_workspace with backend 'celld' and a join on that workspace, the
 * filesystem storage holds no workspace rows and the inner handler saw no
 * workspace create/join; the cell is the only holder of the membership.
 */
import { describe, expect, it } from 'vitest';
import { createHarness, createCelldWorkspace, joinCelldWorkspace, registerAgent } from './hub18-harness.js';

describe('hub18 H4 — celld create/join never dual-writes filesystem storage', () => {
  it('filesystem storage stays empty of workspaces and the cell holds both members', async () => {
    const h = createHarness();
    const alice = await registerAgent(h, 'alice');
    const bob = await registerAgent(h, 'bob');
    expect(await h.storage.listWorkspaces()).toEqual([]);

    const cellId = await createCelldWorkspace(h, alice, 'cell-ws');
    await joinCelldWorkspace(h, bob, cellId);

    expect(await h.storage.listWorkspaces()).toEqual([]);
    expect(await h.storage.getWorkspace(cellId)).toBeNull();
    expect(
      h.innerCalls.filter(call => call.operation === 'create_workspace' || call.operation === 'join_workspace'),
    ).toEqual([]);
    expect((await h.storage.getAgents()).map(a => a.agentId).sort()).toEqual([alice, bob].sort());

    const members = Object.keys(h.transport.stateOf(cellId)?.members ?? {}).sort();
    expect(members).toEqual([alice, bob].sort());
  });
});
