/**
 * Workspace Module — Workspace CRUD & presence tracking
 *
 * ADR-002 Section 2.2: Workspace Operations
 */

import { randomUUID } from 'node:crypto';
import type {
  HubStorage,
  Workspace,
  WorkspaceAgent,
  Problem,
  Proposal,
} from './hub-types.js';
import { PENDING_PROPOSAL_STATUSES } from './hub-types.js';

export interface ThoughtStoreForWorkspace {
  createSession(sessionId: string): Promise<void>;
  getThoughts(sessionId: string): Promise<unknown[]>;
  getThoughtCount(sessionId: string): Promise<number>;
}

export interface WorkspaceManager {
  createWorkspace(
    agentId: string,
    args: { name: string; description: string; sessionId?: string },
  ): Promise<{ workspaceId: string; mainSessionId: string }>;

  joinWorkspace(
    agentId: string,
    args: { workspaceId: string },
  ): Promise<{ workspace: Workspace; problems: Problem[]; proposals: Proposal[] }>;

  /**
   * SPEC-HUB-003 c6. Hands coordinatorship of a workspace to another agent.
   *
   * Local mode: only the current coordinator may transfer, and only to an
   * agent that is already a member. Hosted mode adds the recovery path the
   * spec exists for — the principal owning the workspace-creating agent may
   * take coordinatorship onto an agent it owns even when the original
   * coordinator agentId is lost; that agent is added to the workspace if it
   * is not a member yet, since a lost identity cannot have joined. Credential
   * rotation without a prior transfer stays unrecoverable in v1.
   */
  transferCoordinator(
    agentId: string,
    args: { workspaceId: string; toAgentId: string },
    context?: { hostedMode?: boolean; requestPrincipal?: string },
  ): Promise<{
    workspaceId: string;
    coordinator: string;
    previousCoordinator: string | null;
    via: 'coordinator' | 'owning-principal';
  }>;

  listWorkspaces(): Promise<{
    workspaces: Array<{ id: string; name: string; agentCount: number; problemCount: number }>;
  }>;

  workspaceStatus(args: { workspaceId: string }): Promise<{
    workspace: Workspace;
    agents: WorkspaceAgent[];
    openProblems: number;
    openProposals: number;
  }>;

  isAgentInWorkspace(agentId: string, workspaceId: string): Promise<boolean>;
  getAgentRole(agentId: string, workspaceId: string): Promise<'coordinator' | 'contributor' | null>;
}

export function createWorkspaceManager(
  storage: HubStorage,
  thoughtStore: ThoughtStoreForWorkspace,
): WorkspaceManager {
  return {
    async createWorkspace(agentId, { name, description, sessionId }) {
      const mainSessionId = sessionId ?? randomUUID();

      // Create a new session if no existing one provided
      if (!sessionId) {
        await thoughtStore.createSession(mainSessionId);
      }

      const now = new Date().toISOString();
      const workspaceId = randomUUID();

      const agent: WorkspaceAgent = {
        agentId,
        role: 'coordinator',
        joinedAt: now,
        status: 'online',
        lastSeenAt: now,
      };

      const workspace: Workspace = {
        id: workspaceId,
        name,
        description,
        createdBy: agentId,
        mainSessionId,
        agents: [agent],
        createdAt: now,
        updatedAt: now,
      };

      await storage.saveWorkspace(workspace);

      return { workspaceId, mainSessionId };
    },

    async joinWorkspace(agentId, { workspaceId }) {
      const workspace = await storage.getWorkspace(workspaceId);
      if (!workspace) {
        throw new Error(`Workspace not found: ${workspaceId}`);
      }

      const now = new Date().toISOString();

      // Check if agent is already a member
      const existingAgent = workspace.agents.find(a => a.agentId === agentId);
      
      if (existingAgent) {
        // Agent already exists - update their status (reconnect scenario)
        existingAgent.status = 'online';
        existingAgent.lastSeenAt = now;
      } else {
        // New agent - add them as contributor
        const agent: WorkspaceAgent = {
          agentId,
          role: 'contributor',
          joinedAt: now,
          status: 'online',
          lastSeenAt: now,
        };
        workspace.agents.push(agent);
      }

      workspace.updatedAt = now;
      await storage.saveWorkspace(workspace);

      const problems = await storage.listProblems(workspaceId);
      const proposals = await storage.listProposals(workspaceId);

      return { workspace, problems, proposals };
    },

    async transferCoordinator(agentId, { workspaceId, toAgentId }, context) {
      const hostedMode = context?.hostedMode ?? false;
      const requestPrincipal = context?.requestPrincipal;

      const workspace = await storage.getWorkspace(workspaceId);
      if (!workspace) {
        throw new Error(`Workspace not found: ${workspaceId}`);
      }

      const target = await storage.getAgent(toAgentId);
      const callerMembership = workspace.agents.find(a => a.agentId === agentId);
      const callerIsCoordinator = callerMembership?.role === 'coordinator';

      let via: 'coordinator' | 'owning-principal';
      if (callerIsCoordinator) {
        via = 'coordinator';
      } else {
        const creator = hostedMode && requestPrincipal !== undefined
          ? await storage.getAgent(workspace.createdBy)
          : null;
        const ownsWorkspace = creator?.ownerPrincipal !== undefined
          && creator.ownerPrincipal === requestPrincipal;
        if (!ownsWorkspace) {
          throw new Error(
            'Only the current coordinator can transfer coordinatorship of this workspace.',
          );
        }
        if (!target) {
          throw new Error(`Unknown agent '${toAgentId}': no durable agent record exists.`);
        }
        if (target.ownerPrincipal !== requestPrincipal) {
          throw new Error(`Agent '${toAgentId}' is owned by another principal.`);
        }
        via = 'owning-principal';
      }

      if (!target) {
        throw new Error(`Unknown agent '${toAgentId}': no durable agent record exists.`);
      }

      const now = new Date().toISOString();
      let targetMembership = workspace.agents.find(a => a.agentId === toAgentId);
      if (targetMembership?.role === 'coordinator') {
        throw new Error(`Agent '${toAgentId}' is already the coordinator of this workspace.`);
      }
      if (!targetMembership) {
        if (via === 'coordinator') {
          throw new Error(
            `Agent '${toAgentId}' is not a member of this workspace. ` +
              'Coordinatorship transfers only to an agent that has joined it.',
          );
        }
        targetMembership = {
          agentId: toAgentId,
          role: 'contributor',
          joinedAt: now,
          status: 'online',
          lastSeenAt: now,
        };
        workspace.agents.push(targetMembership);
      }

      const previousCoordinator = workspace.agents.find(a => a.role === 'coordinator')?.agentId
        ?? null;
      for (const member of workspace.agents) {
        if (member.role === 'coordinator') member.role = 'contributor';
      }
      targetMembership.role = 'coordinator';

      workspace.updatedAt = now;
      await storage.saveWorkspace(workspace);

      return { workspaceId, coordinator: toAgentId, previousCoordinator, via };
    },

    async listWorkspaces() {
      const allWorkspaces = await storage.listWorkspaces();
      const summaries = await Promise.all(
        allWorkspaces.map(async (ws) => {
          const problems = await storage.listProblems(ws.id);
          return {
            id: ws.id,
            name: ws.name,
            agentCount: ws.agents.length,
            problemCount: problems.length,
          };
        }),
      );
      return { workspaces: summaries };
    },

    async workspaceStatus({ workspaceId }) {
      const workspace = await storage.getWorkspace(workspaceId);
      if (!workspace) {
        throw new Error(`Workspace not found: ${workspaceId}`);
      }

      const problems = await storage.listProblems(workspaceId);
      const proposals = await storage.listProposals(workspaceId);

      return {
        workspace,
        agents: workspace.agents,
        openProblems: problems.filter(p => p.status === 'open' || p.status === 'in-progress').length,
        openProposals: proposals.filter(p => PENDING_PROPOSAL_STATUSES.includes(p.status)).length,
      };
    },

    async isAgentInWorkspace(agentId, workspaceId) {
      const workspace = await storage.getWorkspace(workspaceId);
      if (!workspace) return false;
      return workspace.agents.some(a => a.agentId === agentId);
    },

    async getAgentRole(agentId, workspaceId) {
      const workspace = await storage.getWorkspace(workspaceId);
      if (!workspace) return null;
      const agent = workspace.agents.find(a => a.agentId === agentId);
      return agent?.role ?? null;
    },
  };
}
