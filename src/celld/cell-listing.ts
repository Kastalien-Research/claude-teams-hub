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
 * Snapshot every active route concurrently. Routes whose cell answers with a
 * null state (not yet initialized) are omitted; routes whose cell cannot be
 * reached, or answers with a state this reader cannot interpret, are returned
 * with `unreachable: true` so callers can surface the row without claiming to
 * know its contents. One slow or broken cell therefore costs at most its own
 * request timeout and never fails the read for the others.
 */
export async function listActiveCells(registry: BackendRegistry, transport: CellTransport): Promise<ActiveCell[]> {
  const routes = (await registry.list()).filter(route => route.status === 'active');
  const cells = await Promise.all(
    routes.map(async (route): Promise<ActiveCell | undefined> => {
      try {
        const snapshot = await transport.snapshot(route.workspaceId);
        if (snapshot.state === null) return undefined;
        const state = asWorkspaceState(snapshot.state);
        if (state === undefined) return { route, state: null, unreachable: true };
        return { route, state, unreachable: false };
      } catch {
        return { route, state: null, unreachable: true };
      }
    }),
  );
  return cells.filter((cell): cell is ActiveCell => cell !== undefined);
}

/**
 * The minimum shape every consumer of an ActiveCell dereferences. A cell that
 * answers 200 with anything else is a broken cell, not a broken read.
 */
function asWorkspaceState(value: unknown): CellWorkspaceState | undefined {
  if (!isRecord(value)) return undefined;
  const workspace = value.workspace;
  if (!isRecord(workspace) || typeof workspace.id !== 'string') return undefined;
  if (!isRecord(value.members) || !isRecord(value.problems)) return undefined;
  return value as unknown as CellWorkspaceState;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
