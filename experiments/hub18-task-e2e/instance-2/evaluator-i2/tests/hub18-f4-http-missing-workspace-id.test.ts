/**
 * hub18 F4 (flip; reclassified from H7 by Task Manager ruling chg:tm2-change-h7-f4)
 * — the HTTP workspace listing (src/celld/read-model.ts,
 * `createHubReadModel().listWorkspaces()`) with one cell answering 200 and a
 * state missing `workspace.id`: that workspace is reported exactly as
 * `{ id, backend: 'celld', unreachable: true }`, every other workspace is
 * reported normally, and the read does not throw.
 *
 * FAILS on S0: the S0 read model casts the state unchecked and, since nothing
 * throws for this body, pushes `{ id: undefined, name, ..., backend: 'celld' }`.
 * The assertions are byte-identical to H7's HTTP case; only the class differs.
 */
import { describe, expect, it } from 'vitest';
import type { CellWorkspaceState } from '../domain/state.js';
import {
  createHarness,
  createCelldWorkspace,
  createFsWorkspace,
  httpListWorkspaces,
  joinCelldWorkspace,
  registerAgent,
  type Harness,
} from './hub18-harness.js';

const placeholder = (id: string) => ({ id, backend: 'celld', unreachable: true });

function withoutWorkspaceId(state: CellWorkspaceState): unknown {
  const { id: _id, ...workspace } = state.workspace;
  return { ...state, workspace };
}

interface Fixture {
  h: Harness;
  alice: string;
  fsId: string;
  live: string;
  broken: string;
}

async function fixture(): Promise<Fixture> {
  const h = createHarness();
  const alice = await registerAgent(h, 'alice');
  const bob = await registerAgent(h, 'bob');
  const fsId = await createFsWorkspace(h, alice, 'fs-ws');
  const live = await createCelldWorkspace(h, alice, 'cell-live');
  const broken = await createCelldWorkspace(h, alice, 'cell-broken');
  await joinCelldWorkspace(h, bob, live);
  return { h, alice, fsId, live, broken };
}

function breakCell(f: Fixture, make: (state: CellWorkspaceState) => unknown): void {
  const real = f.h.transport.stateOf(f.broken);
  if (real === null) throw new Error('fixture: broken cell has no state');
  f.h.transport.setSnapshotBody(f.broken, make(structuredClone(real)));
}

describe('hub18 F4 — cell answers 200 with state missing workspace.id', () => {
  it('HTTP read model listing: broken cell exactly the placeholder, others unchanged, no throw', async () => {
    const f = await fixture();
    const before = await httpListWorkspaces(f.h);
    breakCell(f, withoutWorkspaceId);

    await expect(httpListWorkspaces(f.h)).resolves.toBeDefined();
    const after = await httpListWorkspaces(f.h);

    expect(after.map(w => w.id)).toEqual(expect.arrayContaining(before.map(w => w.id)));
    expect(after.filter(w => w.id !== f.broken)).toEqual(before.filter(w => w.id !== f.broken));
    for (const row of after.filter(w => w.id === f.broken)) expect(row).toEqual(placeholder(f.broken));
    for (const row of after) expect([f.fsId, f.live, f.broken]).toContain(row.id);
    const liveRow = after.find(w => w.id === f.live);
    expect(liveRow).toMatchObject({ id: f.live, name: 'cell-live', backend: 'celld' });
    expect((liveRow!.agents as unknown[]).length).toBe(2);
  });
});
