/**
 * Active celld workspace enumeration (RFC 0001).
 *
 * Shared by the HTTP read model and the routed hub handler so that every
 * "which workspaces exist / which am I in" surface sees the same set: every
 * ACTIVE route in the registry, with state read from the cell (the registry
 * is routing authority only; workspace state authority is the cell). An
 * unreachable cell is reported as such rather than failing the whole read.
 */

import type { BackendRegistry, WorkspaceRoute } from './backend-registry.js';
import type { CellTransport } from './client.js';
import type { CellWorkspaceState } from './domain/state.js';

export type ActiveCell =
  | { route: WorkspaceRoute; state: CellWorkspaceState; unreachable: false }
  | { route: WorkspaceRoute; state: null; unreachable: true };

/**
 * Snapshot every active route. Routes whose cell answers with a null state
 * (not yet initialized) are omitted; routes whose cell cannot be reached are
 * returned with `unreachable: true` so callers can surface the row without
 * claiming to know its contents.
 */
export async function listActiveCells(registry: BackendRegistry, transport: CellTransport): Promise<ActiveCell[]> {
  const routes = (await registry.list()).filter(route => route.status === 'active');
  const cells: ActiveCell[] = [];
  for (const route of routes) {
    try {
      const snapshot = await transport.snapshot(route.workspaceId);
      const state = snapshot.state as CellWorkspaceState | null;
      if (state === null) continue;
      cells.push({ route, state, unreachable: false });
    } catch {
      cells.push({ route, state: null, unreachable: true });
    }
  }
  return cells;
}
