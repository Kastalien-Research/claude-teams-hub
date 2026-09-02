/**
 * hub18 H6 (bounded latency) — with N ≥ 4 active cells whose snapshots each
 * resolve or reject only after a short setTimeout, `whoami` and
 * `list_workspaces` must issue all N snapshot requests so that they overlap:
 * the fake transport observes N snapshot requests in flight at once. Results
 * keep route (registration) order regardless of which cell answers first.
 *
 * Decided purely by the transport's in-flight counter: no wall-clock
 * assertion, no timing threshold. Delays are 2..8 ms and only serve to keep
 * the requests open long enough to overlap (a serial loop can never have
 * more than one in flight, whatever the delay).
 *
 * Invariant form so it holds on S0 (which issues no snapshot at all for these
 * reads) and after the fix alike: if the read snapshots any cell, it snapshots
 * every active cell and all of them are in flight together.
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
  type Harness,
} from './hub18-harness.js';

const N = 4;

async function fleet(): Promise<{ h: Harness; alice: string; ids: string[] }> {
  const h = createHarness();
  const alice = await registerAgent(h, 'alice');
  const bob = await registerAgent(h, 'bob');
  await createFsWorkspace(h, alice, 'fs-ws');
  const ids: string[] = [];
  for (let i = 0; i < N; i++) ids.push(await createCelldWorkspace(h, alice, `cell-${i}`));
  await joinCelldWorkspace(h, bob, ids[1]!);
  // First route slowest, last fastest: a "push as they resolve" merge would reorder.
  ids.forEach((id, i) => h.transport.setSnapshotDelay(id, 2 * (N - i)));
  return { h, alice, ids };
}

function snapshotsSince(h: Harness, mark: number): string[] {
  return h.transport.calls.slice(mark).filter(c => c.kind === 'snapshot').map(c => c.workspaceId!);
}

function expectAllInFlightTogether(h: Harness, ids: string[], mark: number): void {
  const snapped = snapshotsSince(h, mark);
  if (snapped.length === 0) return; // S0: these reads consult no cell.
  expect([...new Set(snapped)].sort()).toEqual([...ids].sort());
  expect(h.transport.maxInFlight).toBe(ids.length);
}

describe('hub18 H6 — N slow cells are snapshotted concurrently, results keep route order', () => {
  it('list_workspaces: N snapshots in flight at once; celld rows in route order', async () => {
    const { h, ids } = await fleet();
    const mark = h.transport.calls.length;
    h.transport.resetInFlight();

    const listing = await listWorkspaces(h);

    expectAllInFlightTogether(h, ids, mark);
    expect(h.transport.inFlight).toBe(0);
    const celldOrder = listing.map(w => w.id).filter(id => ids.includes(id));
    expect(celldOrder).toEqual(ids.filter(id => celldOrder.includes(id)));
    const row1 = listing.find(w => w.id === ids[1]);
    if (row1 !== undefined) expect(row1).toMatchObject({ name: 'cell-1', agentCount: 2 });
  });

  it('whoami: N snapshots in flight at once; memberships in route order', async () => {
    const { h, alice, ids } = await fleet();
    const mark = h.transport.calls.length;
    h.transport.resetInFlight();

    const me = await whoami(h, alice);

    expectAllInFlightTogether(h, ids, mark);
    expect(h.transport.inFlight).toBe(0);
    const celldOrder = me.workspaces.filter(id => ids.includes(id));
    expect(celldOrder).toEqual(ids.filter(id => celldOrder.includes(id)));
  });

  it('with two of the N cells rejecting after their delay, requests still overlap and both reads resolve', async () => {
    const { h, alice, ids } = await fleet();
    h.transport.setUnreachable(ids[0]!);
    h.transport.setUnreachable(ids[2]!);
    const mark = h.transport.calls.length;
    h.transport.resetInFlight();

    const listing = await listWorkspaces(h);
    expectAllInFlightTogether(h, ids, mark);

    const mark2 = h.transport.calls.length;
    h.transport.resetInFlight();
    const me = await whoami(h, alice);
    expectAllInFlightTogether(h, ids, mark2);

    expect(listing.map(w => w.id).filter(id => ids.includes(id))).toEqual(
      ids.filter(id => listing.some(w => w.id === id)),
    );
    expect(me.workspaces).not.toContain(ids[0]);
    expect(me.workspaces).not.toContain(ids[2]);
  });
});
