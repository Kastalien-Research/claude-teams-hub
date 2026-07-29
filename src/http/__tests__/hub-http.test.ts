import type { AddressInfo } from "node:net";
import express from "express";
import { describe, expect, it, vi } from "vitest";
import { createHubApiSurface, shouldWarnOnExposedLocalMode } from "../hub-http.js";
import type { HubHandler } from "../../hub/hub-handler.js";
import type {
  AgentIdentity,
  Channel,
  ConsensusMarker,
  HubStorage,
  Problem,
  Proposal,
  Workspace,
} from "../../hub/hub-types.js";

function listRoutes(app: express.Express): string[] {
  const router = (app as express.Express & {
    router?: { stack?: Array<{ route?: { path?: string } }> };
  }).router;

  return (router?.stack ?? [])
    .map((layer) => layer.route?.path)
    .filter((path): path is string => typeof path === "string");
}

const stubHandler: HubHandler = {
  handle: vi.fn(async () => ({ ok: true })),
};

function notUsed(name: string): () => never {
  return () => {
    throw new Error(`unexpected HubStorage call: ${name}`);
  };
}

interface FixtureOptions {
  workspaces?: Workspace[];
  agents?: AgentIdentity[];
  problems?: Problem[];
  proposals?: Proposal[];
  consensus?: ConsensusMarker[];
  channels?: Channel[];
}

function makeWorkspace(): Workspace {
  return {
    id: "ws-1",
    name: "Phase 4",
    description: "dashboard work",
    createdBy: "agent-lead",
    mainSessionId: "session-1",
    agents: [
      {
        agentId: "agent-lead",
        role: "coordinator",
        joinedAt: "2026-07-29T10:00:00.000Z",
        status: "online",
        lastSeenAt: "2026-07-29T10:05:00.000Z",
        currentWork: "prob-1",
      },
      {
        agentId: "agent-ghost",
        role: "contributor",
        joinedAt: "2026-07-29T10:01:00.000Z",
        status: "offline",
        lastSeenAt: "2026-07-29T10:02:00.000Z",
      },
    ],
    createdAt: "2026-07-29T10:00:00.000Z",
    updatedAt: "2026-07-29T10:05:00.000Z",
  };
}

function makeProblem(): Problem {
  return {
    id: "prob-1",
    workspaceId: "ws-1",
    title: "Ship the dashboard",
    description: "single-file live view",
    createdBy: "agent-lead",
    status: "in-progress",
    comments: [],
    createdAt: "2026-07-29T10:00:00.000Z",
    updatedAt: "2026-07-29T10:03:00.000Z",
  };
}

function makeStorage(options: FixtureOptions = {}): HubStorage {
  const workspaces = options.workspaces ?? [];

  return {
    getAgents: async () => options.agents ?? [],
    saveAgent: notUsed("saveAgent"),
    getAgent: notUsed("getAgent"),

    getWorkspace: async (workspaceId) =>
      workspaces.find((workspace) => workspace.id === workspaceId) ?? null,
    saveWorkspace: notUsed("saveWorkspace"),
    listWorkspaces: async () => workspaces,

    getProblem: notUsed("getProblem"),
    saveProblem: notUsed("saveProblem"),
    listProblems: async () => options.problems ?? [],

    getProposal: notUsed("getProposal"),
    saveProposal: notUsed("saveProposal"),
    listProposals: async () => options.proposals ?? [],
    appendReview: notUsed("appendReview"),

    getConsensusMarker: notUsed("getConsensusMarker"),
    saveConsensusMarker: notUsed("saveConsensusMarker"),
    listConsensusMarkers: async () => options.consensus ?? [],
    appendEndorsement: notUsed("appendEndorsement"),

    getChannel: async (_workspaceId, problemId) =>
      (options.channels ?? []).find(
        (channel) => channel.problemId === problemId,
      ) ?? null,
    saveChannel: notUsed("saveChannel"),
    appendMessage: notUsed("appendMessage"),
  };
}

/** Serves the mounted surface on an ephemeral port for the duration of `run`. */
async function withServer(
  storage: HubStorage,
  run: (baseUrl: string) => Promise<void>,
): Promise<void> {
  const app = express();
  app.use(express.json());
  createHubApiSurface(stubHandler, storage).mount(app);

  const server = app.listen(0);
  await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  const { port } = server.address() as AddressInfo;

  try {
    await run(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

describe("hub API surface", () => {
  it("mounts /hub/api and the read-only snapshot routes for local mode", () => {
    const app = express();
    app.use(express.json());

    createHubApiSurface(stubHandler, makeStorage()).mount(app);

    const routes = listRoutes(app);
    expect(routes).toContain("/hub/api");
    expect(routes).toContain("/hub/workspaces");
    expect(routes).toContain("/hub/workspaces/:id/snapshot");
    expect(routes).not.toContain("/hub/events");
  });

  it("leaves hub routes absent when not mounted", () => {
    const app = express();
    app.use(express.json());

    expect(listRoutes(app)).not.toContain("/hub/api");
  });
});

describe("GET /hub/workspaces", () => {
  it("returns every workspace from storage", async () => {
    const workspace = makeWorkspace();

    await withServer(makeStorage({ workspaces: [workspace] }), async (baseUrl) => {
      const response = await fetch(`${baseUrl}/hub/workspaces`);
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ workspaces: [workspace] });
    });
  });

  it("returns an empty list when no workspaces exist", async () => {
    await withServer(makeStorage(), async (baseUrl) => {
      const response = await fetch(`${baseUrl}/hub/workspaces`);
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ workspaces: [] });
    });
  });
});

describe("GET /hub/workspaces/:id/snapshot", () => {
  it("assembles workspace, joined agents, problems, proposals, consensus and channels", async () => {
    const workspace = makeWorkspace();
    const problem = makeProblem();

    const agents: AgentIdentity[] = [
      {
        agentId: "agent-lead",
        name: "Lead",
        role: "coordinator",
        profile: "MANAGER",
        registeredAt: "2026-07-29T09:59:00.000Z",
      },
    ];

    const proposal: Proposal = {
      id: "prop-1",
      workspaceId: "ws-1",
      title: "Add snapshot endpoints",
      description: "read-only",
      createdBy: "agent-lead",
      sourceBranch: "branch-1",
      status: "reviewing",
      reviews: [],
      createdAt: "2026-07-29T10:02:00.000Z",
      updatedAt: "2026-07-29T10:02:00.000Z",
    };

    const consensus: ConsensusMarker[] = [
      {
        id: "cons-1",
        workspaceId: "ws-1",
        name: "dashboard-is-read-only",
        description: "no writes from the browser",
        thoughtRef: 4,
        agreedBy: ["agent-lead"],
        createdAt: "2026-07-29T10:04:00.000Z",
      },
    ];

    const channel: Channel = {
      id: "chan-1",
      workspaceId: "ws-1",
      problemId: "prob-1",
      messages: [
        {
          id: "msg-1",
          agentId: "agent-lead",
          content: "starting",
          timestamp: "2026-07-29T10:03:00.000Z",
        },
      ],
    };

    const storage = makeStorage({
      workspaces: [workspace],
      agents,
      problems: [problem],
      proposals: [proposal],
      consensus,
      channels: [channel],
    });

    await withServer(storage, async (baseUrl) => {
      const response = await fetch(`${baseUrl}/hub/workspaces/ws-1/snapshot`);
      expect(response.status).toBe(200);

      const body = (await response.json()) as Record<string, unknown>;
      expect(body.workspace).toEqual(workspace);
      expect(body.problems).toEqual([problem]);
      expect(body.proposals).toEqual([proposal]);
      expect(body.consensus).toEqual(consensus);
      expect(body.channels).toEqual([channel]);

      // Membership carries live state; the registry carries name and profile.
      expect(body.agents).toEqual([
        {
          agentId: "agent-lead",
          name: "Lead",
          role: "coordinator",
          status: "online",
          joinedAt: "2026-07-29T10:00:00.000Z",
          lastSeenAt: "2026-07-29T10:05:00.000Z",
          currentWork: "prob-1",
          profile: "MANAGER",
          registeredAt: "2026-07-29T09:59:00.000Z",
        },
        {
          // Unregistered member: falls back to the agent id as its name.
          agentId: "agent-ghost",
          name: "agent-ghost",
          role: "contributor",
          status: "offline",
          joinedAt: "2026-07-29T10:01:00.000Z",
          lastSeenAt: "2026-07-29T10:02:00.000Z",
        },
      ]);
    });
  });

  it("omits channels for problems that have none", async () => {
    const storage = makeStorage({
      workspaces: [makeWorkspace()],
      problems: [makeProblem()],
    });

    await withServer(storage, async (baseUrl) => {
      const response = await fetch(`${baseUrl}/hub/workspaces/ws-1/snapshot`);
      const body = (await response.json()) as { channels: unknown[] };
      expect(body.channels).toEqual([]);
    });
  });

  it("returns 404 JSON for an unknown workspace", async () => {
    await withServer(makeStorage(), async (baseUrl) => {
      const response = await fetch(`${baseUrl}/hub/workspaces/nope/snapshot`);
      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({
        error: "Workspace not found: nope",
      });
    });
  });
});

describe("shouldWarnOnExposedLocalMode", () => {
  it("warns for local mode on 0.0.0.0", () => {
    expect(shouldWarnOnExposedLocalMode("0.0.0.0", false)).toBe(true);
    expect(shouldWarnOnExposedLocalMode(undefined, false)).toBe(true);
  });

  it("does not warn for supabase mode or loopback host", () => {
    expect(shouldWarnOnExposedLocalMode("0.0.0.0", true)).toBe(false);
    expect(shouldWarnOnExposedLocalMode("127.0.0.1", false)).toBe(false);
    expect(shouldWarnOnExposedLocalMode("localhost", false)).toBe(false);
  });
});
