/**
 * hub18 H3 — reads do not write: after whoami and list_workspaces, no agent
 * record was created, no cell command was issued (transport.command not
 * called, cell revisions unchanged, no new route), and filesystem storage
 * gained no workspace rows.
 */
import { describe, expect, it } from 'vitest';
import {
  createHarness,
  createCelldWorkspace,
  createFsWorkspace,
  joinCelldWorkspace,
  listWorkspaces,
  registerAgent,
  whoami,
} from './hub18-harness.js';

describe('hub18 H3 — whoami and list_workspaces are pure reads', () => {
  it('issues no cell command, mints no agent, adds no filesystem workspace row, adds no route', async () => {
    const h = createHarness();
    const alice = await registerAgent(h, 'alice');
    const bob = await registerAgent(h, 'bob');
    const fsId = await createFsWorkspace(h, alice, 'fs-ws');
    const cellId = await createCelldWorkspace(h, alice, 'cell-ws');
    await joinCelldWorkspace(h, bob, cellId);

    const agentsBefore = (await h.storage.getAgents()).map(a => a.agentId).sort();
    const fsRowsBefore = (await h.storage.listWorkspaces()).map(w => w.id).sort();
    const routesBefore = [...h.registry.routes.keys()].sort();
    const revisionBefore = h.transport.revisionOf(cellId);
    const callMark = h.transport.calls.length;

    await whoami(h, alice);
    await listWorkspaces(h);
    await whoami(h, bob);
    await listWorkspaces(h);

    const newCalls = h.transport.calls.slice(callMark);
    expect(newCalls.filter(call => call.kind === 'command')).toEqual([]);
    expect(h.transport.revisionOf(cellId)).toBe(revisionBefore);
    expect((await h.storage.getAgents()).map(a => a.agentId).sort()).toEqual(agentsBefore);
    expect((await h.storage.listWorkspaces()).map(w => w.id).sort()).toEqual(fsRowsBefore);
    expect(fsRowsBefore).toEqual([fsId]);
    expect([...h.registry.routes.keys()].sort()).toEqual(routesBefore);
    expect(h.registry.routes.get(cellId)?.status).toBe('active');
  });
});
