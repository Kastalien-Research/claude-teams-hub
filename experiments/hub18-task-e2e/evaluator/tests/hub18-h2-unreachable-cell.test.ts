/**
 * hub18 H2 — an unreachable cell hides only that workspace: list_workspaces
 * and whoami still return the reachable ones and do not throw.
 *
 * Stated as an invariant so it holds on S0 and after the fix alike: with
 * one cell down, the set of workspaces that disappears from either read is
 * a subset of { the unreachable workspace }, the filesystem workspace is
 * always present, and neither read rejects.
 */
import { describe, expect, it } from 'vitest';
import {
  createHarness,
  createCelldWorkspace,
  createFsWorkspace,
  listWorkspaces,
  registerAgent,
  whoami,
} from './hub18-harness.js';

describe('hub18 H2 — unreachable cell hides only itself', () => {
  it('one dead cell: reads resolve, filesystem workspace stays, at most the dead workspace disappears', async () => {
    const h = createHarness();
    const alice = await registerAgent(h, 'alice');
    const fsId = await createFsWorkspace(h, alice, 'fs-ws');
    const cellA = await createCelldWorkspace(h, alice, 'cell-a');
    const cellB = await createCelldWorkspace(h, alice, 'cell-b');

    const listBefore = (await listWorkspaces(h)).map(w => w.id);
    const meBefore = (await whoami(h, alice)).workspaces;

    h.transport.setUnreachable(cellB);

    await expect(listWorkspaces(h)).resolves.toBeDefined();
    await expect(whoami(h, alice)).resolves.toBeDefined();
    const listAfter = (await listWorkspaces(h)).map(w => w.id);
    const meAfter = (await whoami(h, alice)).workspaces;

    expect(listAfter).toContain(fsId);
    expect(meAfter).toContain(fsId);

    const hiddenFromList = listBefore.filter(id => !listAfter.includes(id));
    const hiddenFromWhoami = meBefore.filter(id => !meAfter.includes(id));
    expect(hiddenFromList.filter(id => id !== cellB)).toEqual([]);
    expect(hiddenFromWhoami.filter(id => id !== cellB)).toEqual([]);

    // A membership that cannot be read must not be asserted.
    expect(meAfter).not.toContain(cellB);
    // cellA is untouched by cellB's outage: whatever it showed before, it still shows.
    expect(listAfter.includes(cellA)).toBe(listBefore.includes(cellA));
    expect(meAfter.includes(cellA)).toBe(meBefore.includes(cellA));
  });

  it('every cell dead: reads still resolve with the filesystem workspace', async () => {
    const h = createHarness();
    const alice = await registerAgent(h, 'alice');
    const fsId = await createFsWorkspace(h, alice, 'fs-ws');
    const cellA = await createCelldWorkspace(h, alice, 'cell-a');
    h.transport.setUnreachable(cellA);

    const listing = await listWorkspaces(h);
    expect(listing.map(w => w.id)).toContain(fsId);
    const me = await whoami(h, alice);
    expect(me.workspaces).toContain(fsId);
    expect(me.workspaces).not.toContain(cellA);
  });
});
