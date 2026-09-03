/**
 * hub18 H7 (malformed response isolation) — one cell answers 200 with a body
 * that is not a workspace state: `{}`, `[]`, a state missing `members`, or a
 * state missing `workspace.id`. That workspace is reported exactly as H2's
 * unreachable placeholder `{ id, backend: 'celld', unreachable: true }` in
 * list_workspaces and omitted from whoami; every other workspace is reported
 * normally; neither read throws. The HTTP workspace listing
 * (src/celld/read-model.ts, `createHubReadModel().listWorkspaces()`) behaves
 * the same way.
 *
 * Invariant form as in H2: no row disappears, non-broken rows are unchanged,
 * any row attributable to the broken cell is exactly the placeholder.
 *
 * Task Manager ruling chg:tm2-change-h7-f4 (2026-09-02T23:33:56Z): the HTTP
 * listing case for the body "state missing workspace.id" FAILS on S0 (the S0
 * read model emits an { id: undefined } row), so it is a flip, not a hold; it
 * lives verbatim in hub18-f4-http-missing-workspace-id.test.ts. H7 keeps the
 * other 16 cases (all four bodies MCP-side; {}, [], missing-members HTTP-side).
 */
import { describe, expect, it } from 'vitest';
import type { CellWorkspaceState } from '../domain/state.js';
import {
  createHarness,
  createCelldWorkspace,
  createFsWorkspace,
  httpListWorkspaces,
  joinCelldWorkspace,
  listWorkspaces,
  registerAgent,
  whoami,
  type Harness,
} from './hub18-harness.js';

const placeholder = (id: string) => ({ id, backend: 'celld', unreachable: true });

function withoutMembers(state: CellWorkspaceState): unknown {
  const { members: _members, ...rest } = state;
  return rest;
}
function withoutWorkspaceId(state: CellWorkspaceState): unknown {
  const { id: _id, ...workspace } = state.workspace;
  return { ...state, workspace };
}

const BODIES: Array<[string, (state: CellWorkspaceState) => unknown]> = [
  ['{}', () => ({})],
  ['[]', () => []],
  ['state missing members', withoutMembers],
  ['state missing workspace.id', withoutWorkspaceId],
];

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

describe.each(BODIES)('hub18 H7 — cell answers 200 with %s', (_label, make) => {
  it('list_workspaces: broken cell exactly the placeholder, others unchanged, no throw', async () => {
    const f = await fixture();
    const before = await listWorkspaces(f.h);
    breakCell(f, make);

    await expect(listWorkspaces(f.h)).resolves.toBeDefined();
    const after = await listWorkspaces(f.h);

    expect(after.map(w => w.id)).toEqual(expect.arrayContaining(before.map(w => w.id)));
    expect(after.filter(w => w.id !== f.broken)).toEqual(before.filter(w => w.id !== f.broken));
    for (const row of after.filter(w => w.id === f.broken)) expect(row).toEqual(placeholder(f.broken));
    // Nothing else may be attributed to the broken cell: every row is either the fs
    // workspace, the live cell (in full, as before), or the placeholder.
    for (const row of after) expect([f.fsId, f.live, f.broken]).toContain(row.id);
    expect(after.find(w => w.id === f.fsId)).toMatchObject({ id: f.fsId, name: 'fs-ws', agentCount: 1 });
    const liveRow = after.find(w => w.id === f.live);
    if (liveRow !== undefined) expect(liveRow).toMatchObject({ id: f.live, name: 'cell-live', agentCount: 2 });
  });

  it('whoami: omits the broken cell, keeps the others, no throw', async () => {
    const f = await fixture();
    const before = (await whoami(f.h, f.alice)).workspaces;
    breakCell(f, make);

    await expect(whoami(f.h, f.alice)).resolves.toBeDefined();
    const after = (await whoami(f.h, f.alice)).workspaces;

    expect(after).toContain(f.fsId);
    expect(after).not.toContain(f.broken);
    expect([...after].sort()).toEqual(before.filter(id => id !== f.broken).sort());
  });

  it.skipIf(_label === 'state missing workspace.id')(
    'HTTP read model listing: broken cell exactly the placeholder, others unchanged, no throw (missing workspace.id => F4)',
    async () => {
    const f = await fixture();
    const before = await httpListWorkspaces(f.h);
    breakCell(f, make);

    await expect(httpListWorkspaces(f.h)).resolves.toBeDefined();
    const after = await httpListWorkspaces(f.h);

    expect(after.map(w => w.id)).toEqual(expect.arrayContaining(before.map(w => w.id)));
    expect(after.filter(w => w.id !== f.broken)).toEqual(before.filter(w => w.id !== f.broken));
    for (const row of after.filter(w => w.id === f.broken)) expect(row).toEqual(placeholder(f.broken));
    for (const row of after) expect([f.fsId, f.live, f.broken]).toContain(row.id);
    const liveRow = after.find(w => w.id === f.live);
    expect(liveRow).toMatchObject({ id: f.live, name: 'cell-live', backend: 'celld' });
    expect((liveRow!.agents as unknown[]).length).toBe(2);
  },
  );
});
