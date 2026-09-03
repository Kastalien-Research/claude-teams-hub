/**
 * hub18 evaluator harness (NOT a test file — no .test.ts suffix).
 *
 * Composes the production shape from src/index.ts: a real filesystem
 * HubHandler over in-memory HubStorage, wrapped by createRoutedHubHandler
 * with an in-memory route registry and a fake CellTransport. The fake
 * transport is faithful: every cell command runs the real domain reducer
 * and every query runs the real domain query, per workspace, so membership,
 * revisions and rejections behave exactly as a cell would. It records every
 * call by kind so a grader can prove that reads issued no command.
 */

import { createHubHandler, type HubHandler } from '../../hub/hub-handler.js';
import { createInMemoryHubStorage, createInMemoryThoughtStore } from '../../hub/__tests__/test-helpers.js';
import type { HubStorage } from '../../hub/hub-types.js';
import type { BackendRegistry, WorkspaceRoute } from '../backend-registry.js';
import type { CellTransport } from '../client.js';
import { reduce, type ReducerCommand } from '../domain/reducer.js';
import { query } from '../domain/queries.js';
import type { CellWorkspaceState } from '../domain/state.js';
import { CelldError, rejection } from '../errors.js';
import { createHubReadModel } from '../read-model.js';
import { createRoutedHubHandler } from '../routed-handler.js';

export interface RecordedCall {
  kind: 'command' | 'query' | 'snapshot' | 'events' | 'health';
  workspaceId?: string;
  operation?: string;
  actorId?: string;
}

interface Cell {
  state: CellWorkspaceState | null;
  revision: number;
}

export interface FakeCellFleet extends CellTransport {
  calls: RecordedCall[];
  cells: Map<string, Cell>;
  /** Make every transport method for this workspace fail like a dead node. */
  setUnreachable(workspaceId: string, unreachable?: boolean): void;
  /**
   * H6: every snapshot of this workspace resolves (or, if unreachable,
   * rejects) only after `ms` on a setTimeout. Delays are short (single-digit
   * ms); no test asserts on wall-clock time, only on `maxInFlight`.
   */
  setSnapshotDelay(workspaceId: string, ms: number): void;
  /**
   * H7: the cell answers 200 with `body` as the snapshot `state`, whatever
   * it is ({}, [], a state missing fields...). The cell's real state is left
   * untouched so commands/queries keep working.
   */
  setSnapshotBody(workspaceId: string, body: unknown): void;
  /** Snapshot requests currently awaiting a delayed answer. */
  readonly inFlight: number;
  /** Highest `inFlight` seen since the last `resetInFlight()`. */
  readonly maxInFlight: number;
  resetInFlight(): void;
  stateOf(workspaceId: string): CellWorkspaceState | null;
  revisionOf(workspaceId: string): number;
}

export function createFakeCellFleet(): FakeCellFleet {
  const calls: RecordedCall[] = [];
  const cells = new Map<string, Cell>();
  const unreachable = new Set<string>();
  const delays = new Map<string, number>();
  const bodies = new Map<string, unknown>();
  let inFlight = 0;
  let maxInFlight = 0;

  function cellFor(workspaceId: string): Cell {
    let cell = cells.get(workspaceId);
    if (cell === undefined) {
      cell = { state: null, revision: 0 };
      cells.set(workspaceId, cell);
    }
    return cell;
  }

  function guard(workspaceId: string): void {
    if (unreachable.has(workspaceId)) {
      throw new CelldError(
        rejection('CELLD_UNAVAILABLE', 'All 1 celld endpoint(s) unreachable', {
          endpointCount: 1,
          lastError: 'connect ECONNREFUSED',
        }),
      );
    }
  }

  return {
    calls,
    cells,
    setUnreachable(workspaceId, flag = true) {
      if (flag) unreachable.add(workspaceId);
      else unreachable.delete(workspaceId);
    },
    setSnapshotDelay(workspaceId, ms) {
      delays.set(workspaceId, ms);
    },
    setSnapshotBody(workspaceId, body) {
      bodies.set(workspaceId, body);
    },
    get inFlight() {
      return inFlight;
    },
    get maxInFlight() {
      return maxInFlight;
    },
    resetInFlight() {
      inFlight = 0;
      maxInFlight = 0;
    },
    stateOf(workspaceId) {
      return cells.get(workspaceId)?.state ?? null;
    },
    revisionOf(workspaceId) {
      return cells.get(workspaceId)?.revision ?? 0;
    },
    async command(workspaceId, command) {
      calls.push({ kind: 'command', workspaceId, operation: command.operation, actorId: command.actor.agentId });
      guard(workspaceId);
      const cell = cellFor(workspaceId);
      const reducerCommand: ReducerCommand = {
        commandId: command.commandId,
        operation: command.operation,
        workspaceId,
        actorId: command.actor.agentId,
        issuedAt: command.issuedAt,
        context: command.context ?? {},
        payload: command.payload,
      };
      if (command.expectedRevision !== undefined) reducerCommand.expectedRevision = command.expectedRevision;
      const outcome = reduce(cell.state, reducerCommand, cell.revision);
      if (!outcome.ok) {
        return { outcome: 'rejected', replayed: false, revision: cell.revision, rejection: outcome.rejection };
      }
      cell.state = outcome.state;
      cell.revision += 1;
      return {
        outcome: 'accepted',
        replayed: false,
        revision: cell.revision,
        result: outcome.result,
        events: [],
        firstEventSequence: cell.revision,
        lastEventSequence: cell.revision,
      };
    },
    async query(workspaceId, operation, actorId, payload) {
      calls.push({ kind: 'query', workspaceId, operation, actorId });
      guard(workspaceId);
      const cell = cellFor(workspaceId);
      const outcome = query(cell.state, operation, actorId, payload);
      if (!outcome.ok) {
        return { outcome: 'rejected', replayed: false, revision: cell.revision, rejection: outcome.rejection };
      }
      return { outcome: 'accepted', replayed: false, revision: cell.revision, result: outcome.result };
    },
    async snapshot(workspaceId) {
      calls.push({ kind: 'snapshot', workspaceId });
      const delay = delays.get(workspaceId);
      inFlight += 1;
      if (inFlight > maxInFlight) maxInFlight = inFlight;
      try {
        if (delay !== undefined) await new Promise<void>(resolve => setTimeout(resolve, delay));
        guard(workspaceId);
        const cell = cellFor(workspaceId);
        const state = bodies.has(workspaceId)
          ? structuredClone(bodies.get(workspaceId))
          : cell.state === null
            ? null
            : structuredClone(cell.state);
        return { workspaceId, revision: cell.revision, maxSequence: cell.revision, state };
      } finally {
        inFlight -= 1;
      }
    },
    async events(workspaceId) {
      calls.push({ kind: 'events', workspaceId });
      guard(workspaceId);
      return { events: [], count: 0 };
    },
    async health() {
      calls.push({ kind: 'health' });
      return true;
    },
  };
}

export function memoryRegistry(initial: WorkspaceRoute[] = []): BackendRegistry & { routes: Map<string, WorkspaceRoute> } {
  const routes = new Map(initial.map(route => [route.workspaceId, route]));
  return {
    routes,
    get: async id => routes.get(id),
    list: async () => [...routes.values()],
    findByCommandId: async commandId => [...routes.values()].find(route => route.commandId === commandId),
    findOrBeginProvisioning: async (commandId, candidateWorkspaceId) => {
      const existing = [...routes.values()].find(route => route.commandId === commandId);
      if (existing !== undefined) return existing;
      const route: WorkspaceRoute = {
        workspaceId: candidateWorkspaceId,
        backend: 'celld',
        status: 'provisioning',
        commandId,
        createdAt: new Date().toISOString(),
      };
      routes.set(candidateWorkspaceId, route);
      return route;
    },
    markActive: async workspaceId => {
      const route = routes.get(workspaceId);
      if (route === undefined) throw new Error(`no route ${workspaceId}`);
      routes.set(workspaceId, { ...route, status: 'active', activatedAt: new Date().toISOString() });
    },
  };
}

export interface InnerCall {
  agentId: string | null;
  operation: string;
  args: unknown;
}

export interface Harness {
  storage: HubStorage;
  inner: HubHandler;
  /** Every call that reached the filesystem handler, in order. */
  innerCalls: InnerCall[];
  transport: FakeCellFleet;
  registry: BackendRegistry & { routes: Map<string, WorkspaceRoute> };
  routed: HubHandler;
}

export function createHarness(): Harness {
  const storage = createInMemoryHubStorage();
  const thoughtStore = createInMemoryThoughtStore();
  const filesystem = createHubHandler(storage, thoughtStore);
  const innerCalls: InnerCall[] = [];
  const inner: HubHandler = {
    async handle(agentId, operation, args, requestPrincipal) {
      innerCalls.push({ agentId, operation, args });
      return filesystem.handle(agentId, operation, args, requestPrincipal);
    },
  };
  const transport = createFakeCellFleet();
  const registry = memoryRegistry();
  const routed = createRoutedHubHandler({ inner, transport, registry });
  return { storage, inner, innerCalls, transport, registry, routed };
}

let seq = 0;
function nextId(prefix: string): string {
  seq += 1;
  return `${prefix}-${seq}`;
}

export async function registerAgent(h: Harness, name: string): Promise<string> {
  const result = (await h.routed.handle(null, 'register', { name })) as { agentId: string };
  return result.agentId;
}

export async function createCelldWorkspace(h: Harness, agentId: string, name: string): Promise<string> {
  const result = (await h.routed.handle(agentId, 'create_workspace', {
    backend: 'celld',
    name,
    description: `${name} (celld-backed)`,
    command: { id: nextId('create'), teamRunId: 'hub18' },
  })) as { workspaceId: string };
  return result.workspaceId;
}

export async function joinCelldWorkspace(h: Harness, agentId: string, workspaceId: string): Promise<void> {
  await h.routed.handle(agentId, 'join_workspace', {
    workspaceId,
    command: { id: nextId('join'), teamRunId: 'hub18' },
  });
}

export async function createFsWorkspace(h: Harness, agentId: string, name: string): Promise<string> {
  const result = (await h.routed.handle(agentId, 'create_workspace', {
    name,
    description: `${name} (filesystem-backed)`,
  })) as { workspaceId: string };
  return result.workspaceId;
}

export interface WhoamiResult {
  agentId: string;
  name: string;
  role: string;
  workspaces: string[];
}

export async function whoami(h: Harness, agentId: string): Promise<WhoamiResult> {
  return (await h.routed.handle(agentId, 'whoami', {})) as WhoamiResult;
}

export interface WorkspaceSummary {
  id: string;
  name: string;
  agentCount: number;
  problemCount: number;
}

/** list_workspaces is unauthenticated: the tool handler resolves agentId to null (hub-tool-handler.ts). */
export async function listWorkspaces(h: Harness): Promise<WorkspaceSummary[]> {
  const result = (await h.routed.handle(null, 'list_workspaces', {})) as { workspaces: WorkspaceSummary[] };
  return result.workspaces;
}

/**
 * H7: the HTTP read model behind GET /hub/workspaces (src/celld/read-model.ts),
 * composed over the same storage, registry and transport as the routed
 * handler. Exists at S0, so it is a test seam for the HTTP listing.
 */
export async function httpListWorkspaces(h: Harness): Promise<Array<Record<string, unknown>>> {
  const model = createHubReadModel({ hubStorage: h.storage, registry: h.registry, transport: h.transport });
  return (await model.listWorkspaces()) as Array<Record<string, unknown>>;
}
