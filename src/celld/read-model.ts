/**
 * HubReadModel (RFC 0001): the read surface behind GET /hub/workspaces and
 * GET /hub/workspaces/:id/snapshot. The filesystem implementation reproduces
 * the assembly hub-http.ts used to do inline (byte-compatible responses for
 * filesystem workspaces); the routed implementation additionally surfaces
 * celld workspaces from the route registry + cell snapshots. The registry is
 * routing authority only — workspace STATE authority for a routed workspace
 * is always the cell.
 */

import type { HubHandler } from '../hub/hub-handler.js';
import type { AgentIdentity, Channel, HubStorage, Workspace } from '../hub/hub-types.js';
import type { BackendRegistry } from './backend-registry.js';
import type { CellTransport } from './client.js';
import type { CellWorkspaceState } from './domain/state.js';

/** A workspace member joined against the global agent registry. */
export interface SnapshotAgent {
  agentId: string;
  name: string;
  role: string;
  status: string;
  joinedAt: string;
  lastSeenAt: string;
  currentWork?: string;
  profile?: string;
  registeredAt?: string;
}

export interface WorkspaceSnapshot {
  workspace: unknown;
  agents: SnapshotAgent[];
  problems: unknown[];
  proposals: unknown[];
  consensus: unknown[];
  channels: unknown[];
  coordination?: { backend: 'celld'; revision: number; maxSequence: number };
}

export interface HubReadModel {
  listWorkspaces(): Promise<unknown[]>;
  /** undefined = not found. */
  workspaceSnapshot(workspaceId: string): Promise<WorkspaceSnapshot | undefined>;
}

function joinAgents(workspace: Workspace, registry: AgentIdentity[]): SnapshotAgent[] {
  const byId = new Map(registry.map(agent => [agent.agentId, agent]));
  return workspace.agents.map(member => {
    const identity = byId.get(member.agentId);
    const joined: SnapshotAgent = {
      agentId: member.agentId,
      name: identity?.name ?? member.agentId,
      role: member.role,
      status: member.status,
      joinedAt: member.joinedAt,
      lastSeenAt: member.lastSeenAt,
    };
    if (member.currentWork !== undefined) joined.currentWork = member.currentWork;
    if (identity?.profile !== undefined) joined.profile = identity.profile;
    if (identity?.registeredAt !== undefined) joined.registeredAt = identity.registeredAt;
    return joined;
  });
}

export interface HubReadModelOptions {
  hubStorage: HubStorage;
  registry?: BackendRegistry;
  transport?: CellTransport;
}

export function createHubReadModel(options: HubReadModelOptions): HubReadModel {
  const { hubStorage, registry, transport } = options;

  async function celldWorkspaceEntries(): Promise<unknown[]> {
    if (registry === undefined || transport === undefined) return [];
    const routes = (await registry.list()).filter(route => route.status === 'active');
    const entries: unknown[] = [];
    for (const route of routes) {
      try {
        const snapshot = await transport.snapshot(route.workspaceId);
        const state = snapshot.state as CellWorkspaceState | null;
        if (state === null) continue;
        entries.push({
          id: state.workspace.id,
          name: state.workspace.name,
          description: state.workspace.description,
          createdBy: state.workspace.createdBy,
          createdAt: state.workspace.createdAt,
          updatedAt: state.workspace.updatedAt,
          mainSessionId: `celld:${state.workspace.id}`,
          agents: Object.values(state.members).map(member => ({
            agentId: member.agentId,
            role: member.role,
            joinedAt: member.joinedAt,
            status: 'online',
            lastSeenAt: member.joinedAt,
          })),
          backend: 'celld',
        });
      } catch {
        // An unreachable cell hides that workspace from the listing rather
        // than failing the whole read; the registry row still proves routing.
        entries.push({ id: route.workspaceId, backend: 'celld', unreachable: true });
      }
    }
    return entries;
  }

  return {
    async listWorkspaces() {
      const filesystem = await hubStorage.listWorkspaces();
      const celld = await celldWorkspaceEntries();
      return [...filesystem, ...celld];
    },

    async workspaceSnapshot(workspaceId) {
      const route = registry !== undefined ? await registry.get(workspaceId) : undefined;
      if (route !== undefined && transport !== undefined) {
        const snapshot = await transport.snapshot(workspaceId);
        const state = snapshot.state as CellWorkspaceState | null;
        if (state === null) return undefined;
        return {
          workspace: { ...state.workspace, id: workspaceId, mainSessionId: `celld:${workspaceId}` },
          agents: Object.values(state.members).map(member => ({
            agentId: member.agentId,
            name: member.agentId,
            role: member.role,
            status: 'online',
            joinedAt: member.joinedAt,
            lastSeenAt: member.joinedAt,
          })),
          problems: Object.values(state.problems),
          proposals: [],
          consensus: [],
          channels: Object.entries(state.channels).map(([problemId, messages]) => ({
            id: problemId,
            workspaceId,
            problemId,
            messages,
          })),
          coordination: { backend: 'celld', revision: snapshot.revision, maxSequence: snapshot.maxSequence },
        };
      }

      const workspace = await hubStorage.getWorkspace(workspaceId);
      if (!workspace) return undefined;
      const [agentRegistry, problems, proposals, consensus] = await Promise.all([
        hubStorage.getAgents(),
        hubStorage.listProblems(workspaceId),
        hubStorage.listProposals(workspaceId),
        hubStorage.listConsensusMarkers(workspaceId),
      ]);
      const channels = (
        await Promise.all(problems.map(problem => hubStorage.getChannel(workspaceId, problem.id)))
      ).filter((channel): channel is Channel => channel !== null);
      return {
        workspace,
        agents: joinAgents(workspace, agentRegistry),
        problems,
        proposals,
        consensus,
        channels,
      };
    },
  };
}

/** Narrow re-export so composition code can type the injected handler without importing src/hub deeply. */
export type { HubHandler };
