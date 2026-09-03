/**
 * hub18 H2 (instance 2, rewritten) — with one reachable and one unreachable
 * active cell, `list_workspaces` returns the reachable one in full and the
 * unreachable one exactly as `{ id, backend: 'celld', unreachable: true }`;
 * `whoami` for a member of the reachable cell returns it and does not return
 * the unreachable one; neither read throws.
 *
 * Stated as an invariant over the before/after reads so it holds on S0 (which
 * lists no celld workspace at all) and after the fix alike:
 *  - neither read rejects;
 *  - the outage removes NO row from list_workspaces: every id listed before is
 *    listed after, and every row that is not the dead cell is unchanged;
 *  - any row carrying the dead cell's id is exactly the placeholder;
 *  - whoami after == whoami before minus the dead cell (fs and the live cell
 *    keep whatever presence they had; the dead cell is never asserted).
 * Together with F2/F3 (celld rows must be listed after the fix) this is the
 * contract's H2.
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

const placeholder = (id: string) => ({ id, backend: 'celld', unreachable: true });

describe('hub18 H2 — one unreachable cell: placeholder row, omitted from whoami, others in full', () => {
  it('list_workspaces: reachable cell in full, dead cell exactly the placeholder, no throw', async () => {
    const h = createHarness();
    const alice = await registerAgent(h, 'alice');
    const bob = await registerAgent(h, 'bob');
    const fsId = await createFsWorkspace(h, alice, 'fs-ws');
    const live = await createCelldWorkspace(h, alice, 'cell-live');
    const dead = await createCelldWorkspace(h, alice, 'cell-dead');
    await joinCelldWorkspace(h, bob, live);

    const before = await listWorkspaces(h);
    h.transport.setUnreachable(dead);

    await expect(listWorkspaces(h)).resolves.toBeDefined();
    const after = await listWorkspaces(h);

    // No row disappears: the outage reduces the dead cell to a placeholder, never hides it.
    expect(after.map(w => w.id)).toEqual(expect.arrayContaining(before.map(w => w.id)));
    // Every row that is not the dead cell is byte-for-byte what it was.
    expect(after.filter(w => w.id !== dead)).toEqual(before.filter(w => w.id !== dead));
    // Any row for the dead cell is exactly { id, backend: 'celld', unreachable: true }.
    for (const row of after.filter(w => w.id === dead)) expect(row).toEqual(placeholder(dead));
    // The filesystem workspace is always there; the live cell, if listed, is listed in full.
    expect(after.find(w => w.id === fsId)).toMatchObject({ id: fsId, name: 'fs-ws', agentCount: 1 });
    const liveRow = after.find(w => w.id === live);
    if (liveRow !== undefined) expect(liveRow).toMatchObject({ id: live, name: 'cell-live', agentCount: 2 });
    expect(liveRow).toEqual(before.find(w => w.id === live));
  });

  it('whoami: returns the reachable cell as before, never the dead one, no throw', async () => {
    const h = createHarness();
    const alice = await registerAgent(h, 'alice');
    const fsId = await createFsWorkspace(h, alice, 'fs-ws');
    const live = await createCelldWorkspace(h, alice, 'cell-live');
    const dead = await createCelldWorkspace(h, alice, 'cell-dead');

    const before = (await whoami(h, alice)).workspaces;
    h.transport.setUnreachable(dead);

    await expect(whoami(h, alice)).resolves.toBeDefined();
    const after = (await whoami(h, alice)).workspaces;

    expect(after).toContain(fsId);
    expect(after).not.toContain(dead);
    // Exactly "before minus the dead cell": the live cell's presence is unchanged by the outage.
    expect([...after].sort()).toEqual(before.filter(id => id !== dead).sort());
    expect(after.includes(live)).toBe(before.includes(live));
  });

  it('every cell dead: both reads resolve, filesystem workspace present, dead cells only as placeholders', async () => {
    const h = createHarness();
    const alice = await registerAgent(h, 'alice');
    const fsId = await createFsWorkspace(h, alice, 'fs-ws');
    const a = await createCelldWorkspace(h, alice, 'cell-a');
    const b = await createCelldWorkspace(h, alice, 'cell-b');
    const before = await listWorkspaces(h);
    h.transport.setUnreachable(a);
    h.transport.setUnreachable(b);

    const listing = await listWorkspaces(h);
    expect(listing.map(w => w.id)).toEqual(expect.arrayContaining(before.map(w => w.id)));
    expect(listing.find(w => w.id === fsId)).toMatchObject({ id: fsId, name: 'fs-ws' });
    for (const row of listing.filter(w => w.id === a || w.id === b)) expect(row).toEqual(placeholder(row.id));

    const me = await whoami(h, alice);
    expect(me.workspaces).toEqual([fsId]);
  });
});
