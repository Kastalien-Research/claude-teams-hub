import type { Express, Request, Response } from "express";
import type { HubHandler } from "../hub/hub-handler.js";
import type {
  AgentIdentity,
  Channel,
  HubStorage,
  Workspace,
} from "../hub/hub-types.js";

export interface HubApiSurface {
  mount(app: Express): void;
}

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

function joinAgents(
  workspace: Workspace,
  registry: AgentIdentity[],
): SnapshotAgent[] {
  const byId = new Map(registry.map((agent) => [agent.agentId, agent]));

  return workspace.agents.map((member) => {
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
    if (identity?.registeredAt !== undefined) {
      joined.registeredAt = identity.registeredAt;
    }
    return joined;
  });
}

export function createHubApiSurface(
  sharedHubHandler: HubHandler,
  hubStorage: HubStorage,
): HubApiSurface {
  function mount(app: Express): void {
    app.post("/hub/api", async (req: Request, res: Response) => {
      try {
        const { operation, agentId, ...args } = req.body as {
          operation: string;
          agentId?: string;
          [key: string]: unknown;
        };

        if (!operation) {
          res.status(400).json({ error: "operation is required" });
          return;
        }

        const result = await sharedHubHandler.handle(
          agentId ?? null,
          operation,
          args as Record<string, any>,
        );

        res.json(result);
      } catch (error) {
        const message =
          error instanceof Error ? error.message : String(error);
        res.status(400).json({ error: message });
      }
    });

    // The two read-only endpoints below deliberately bypass the hub's
    // stage-gating and membership checks: they read storage directly rather
    // than going through HubHandler, because this is a local single-trust-domain
    // server whose observer (the dashboard) has no agent identity to gate on.

    app.get("/hub/workspaces", async (_req: Request, res: Response) => {
      try {
        res.json({ workspaces: await hubStorage.listWorkspaces() });
      } catch (error) {
        const message =
          error instanceof Error ? error.message : String(error);
        res.status(500).json({ error: message });
      }
    });

    app.get(
      "/hub/workspaces/:id/snapshot",
      async (req: Request, res: Response) => {
        try {
          // Express 5 types a path param as string | string[] to cover
          // repeated segments; a single `:id` only ever produces a string.
          const rawId = req.params.id;
          const workspaceId = Array.isArray(rawId) ? String(rawId[0]) : rawId;
          const workspace = await hubStorage.getWorkspace(workspaceId);

          if (!workspace) {
            res
              .status(404)
              .json({ error: `Workspace not found: ${workspaceId}` });
            return;
          }

          const [registry, problems, proposals, consensus] = await Promise.all([
            hubStorage.getAgents(),
            hubStorage.listProblems(workspaceId),
            hubStorage.listProposals(workspaceId),
            hubStorage.listConsensusMarkers(workspaceId),
          ]);

          // Channels are keyed by problem, so the channel set is derived from
          // the problem list rather than listed directly.
          const channels = (
            await Promise.all(
              problems.map((problem) =>
                hubStorage.getChannel(workspaceId, problem.id),
              ),
            )
          ).filter((channel): channel is Channel => channel !== null);

          res.json({
            workspace,
            agents: joinAgents(workspace, registry),
            problems,
            proposals,
            consensus,
            channels,
          });
        } catch (error) {
          const message =
            error instanceof Error ? error.message : String(error);
          res.status(500).json({ error: message });
        }
      },
    );
  }

  return { mount };
}

export function shouldWarnOnExposedLocalMode(
  host: string | undefined,
  isMultiTenant: boolean,
): boolean {
  if (isMultiTenant) return false;
  return (host ?? "0.0.0.0") === "0.0.0.0";
}
