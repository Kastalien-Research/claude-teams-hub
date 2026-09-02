/** hub18 F3 — one filesystem workspace and one celld workspace: both appear in list_workspaces, and whoami for an agent in both returns both. */
import { describe, expect, it } from 'vitest';
import {
  createHarness,
  createCelldWorkspace,
  createFsWorkspace,
  listWorkspaces,
  registerAgent,
  whoami,
} from './hub18-harness.js';

describe('hub18 F3 — filesystem and celld workspaces side by side', () => {
  it('list_workspaces shows both and whoami returns both memberships', async () => {
    const h = createHarness();
    const alice = await registerAgent(h, 'alice');
    const fsId = await createFsWorkspace(h, alice, 'fs-ws');
    const cellId = await createCelldWorkspace(h, alice, 'cell-ws');
    expect(fsId).not.toBe(cellId);

    const listing = await listWorkspaces(h);
    expect(listing.find(w => w.id === fsId)).toMatchObject({ id: fsId, name: 'fs-ws', agentCount: 1 });
    expect(listing.find(w => w.id === cellId)).toMatchObject({ id: cellId, name: 'cell-ws', agentCount: 1 });

    const me = await whoami(h, alice);
    expect([...me.workspaces].sort()).toEqual([fsId, cellId].sort());
  });
});
