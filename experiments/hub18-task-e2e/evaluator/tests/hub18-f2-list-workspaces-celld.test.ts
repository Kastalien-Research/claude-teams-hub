/** hub18 F2 — list_workspaces includes the celld workspace with its name and agentCount from the cell's members. */
import { describe, expect, it } from 'vitest';
import { createHarness, createCelldWorkspace, joinCelldWorkspace, listWorkspaces, registerAgent } from './hub18-harness.js';

describe('hub18 F2 — list_workspaces includes celld workspaces', () => {
  it('lists the celld workspace with its cell name and member count', async () => {
    const h = createHarness();
    const alice = await registerAgent(h, 'alice');
    const bob = await registerAgent(h, 'bob');
    const cellId = await createCelldWorkspace(h, alice, 'cell-ws');

    const once = (await listWorkspaces(h)).find(w => w.id === cellId);
    expect(once).toBeDefined();
    expect(once).toMatchObject({ id: cellId, name: 'cell-ws', agentCount: 1 });

    await joinCelldWorkspace(h, bob, cellId);
    const twice = (await listWorkspaces(h)).find(w => w.id === cellId);
    expect(twice).toMatchObject({ id: cellId, name: 'cell-ws', agentCount: 2 });
  });
});
