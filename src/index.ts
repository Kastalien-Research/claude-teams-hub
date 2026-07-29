#!/usr/bin/env node

/**
 * Team Hub MCP Server - Entry Point (Streamable HTTP, local-only)
 */

import crypto from "node:crypto";
import * as path from "node:path";
import * as os from "node:os";
import type { Request, Response } from "express";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createMcpServer } from "./server-factory.js";
import { LOCAL_WORKSPACE_ID } from "./constants.js";
import {
  FileSystemStorage,
  InMemoryStorage,
  type ThoughtboxStorage,
} from "./persistence/index.js";
import { createFileSystemHubStorage } from "./hub/hub-storage-fs.js";
import type { HubStorage } from "./hub/hub-types.js";
import { createHubHandler, type HubEvent } from "./hub/hub-handler.js";
import {
  createThoughtStoreAdapter,
  type ThoughtStoreAdapter,
} from "./hub/thought-store-adapter.js";
import { createHubApiSurface, shouldWarnOnExposedLocalMode } from "./http/hub-http.js";
import { createEventStreamSurface } from "./http/event-stream.js";

const SERVER_VERSION = "0.1.0";

/**
 * Get the storage backend based on environment configuration.
 *
 * THOUGHTBOX_STORAGE=memory -> InMemoryStorage (volatile, for testing)
 * THOUGHTBOX_STORAGE=fs     -> FileSystemStorage (persistent, default)
 *
 * HUB_DATA_DIR -> data directory for sessions, hub state, and tasks
 *                 (default: ~/.team-hub)
 *
 * Project scope is set from LOCAL_WORKSPACE_ID (or THOUGHTBOX_PROJECT).
 */
interface StorageFactory {
  getStorage: () => ThoughtboxStorage;
}

interface StorageBundle {
  factory: StorageFactory;
  hubStorage: HubStorage;
  dataDir: string;
}

async function createStorage(): Promise<StorageBundle> {
  const storageType = (process.env.THOUGHTBOX_STORAGE || "fs").toLowerCase();

  // Base directory for session storage, hub state, and the MCP task store.
  const baseDir =
    process.env.HUB_DATA_DIR || path.join(os.homedir(), ".team-hub");

  if (storageType === "memory") {
    // Session/thought storage is volatile; hub state still goes through the
    // filesystem hub storage under baseDir — there is no in-memory HubStorage
    // implementation, and this is what the upstream local branch did.
    console.error("[Storage] Using in-memory session storage (volatile)");
    return {
      factory: { getStorage: () => new InMemoryStorage() },
      hubStorage: createFileSystemHubStorage(baseDir),
      dataDir: baseDir,
    };
  }

  console.error(`[Storage] Using filesystem storage at ${baseDir}`);

  // Base init for FileSystem: config, legacy migration. Done once globally.
  const fsStorage = new FileSystemStorage({
    basePath: baseDir,
    partitionGranularity: "monthly",
  });
  await fsStorage.initialize();

  return {
    factory: {
      getStorage: () =>
        new FileSystemStorage({
          basePath: baseDir,
          partitionGranularity: "monthly",
        }),
    },
    hubStorage: createFileSystemHubStorage(baseDir),
    dataDir: baseDir,
  };
}

interface SessionEntry {
  transport: StreamableHTTPServerTransport;
  server: Awaited<ReturnType<typeof createMcpServer>>;
  workspaceId: string;
}

async function startHttpServer() {
  const { factory, hubStorage, dataDir } = await createStorage();

  // Hub thought store: ONE storage instance shared by /hub/api and every MCP
  // session's tb.hub dispatcher. Per-session FileSystemStorage instances each
  // hold an in-memory session index, so a hub main-session created through one
  // instance is invisible to the others — merge_proposal from a second MCP
  // session would fail with "Session not found".
  const hubSessionStorage = factory.getStorage();
  await hubSessionStorage.initialize();
  await hubSessionStorage.setProject(LOCAL_WORKSPACE_ID);
  const localHubThoughtStore: ThoughtStoreAdapter =
    createThoughtStoreAdapter(hubSessionStorage);

  const host = process.env.HOST || "0.0.0.0";
  const app = createMcpExpressApp({ host });

  const port = parseInt(process.env.PORT || "1731", 10);
  const sessions = new Map<string, SessionEntry>();

  if (shouldWarnOnExposedLocalMode(host, false)) {
    console.warn(
      "[Security] Local mode is bound to 0.0.0.0. Hub HTTP endpoints and local storage are not workspace-isolated; do not expose this server to untrusted users.",
    );
  }

  // Unified event stream — currently carries Hub events via SSE.
  const eventStream = createEventStreamSurface();
  const broadcastHubEvent = (event: HubEvent) => {
    eventStream.broadcast({
      source: 'hub',
      type: event.type,
      workspaceId: event.workspaceId,
      timestamp: new Date().toISOString(),
      data: event.data,
    });
  };

  // PHASE-4: thoughtEmitter (thought:added / thought:revised / thought:branched)
  // is NOT bridged to the event stream yet. ThoughtboxEvent's `source` union is
  // 'hub' | 'protocol', and labelling thought events as 'hub' would corrupt the
  // SSE source filter. The event vocabulary gets a 'thought' source in phase 4;
  // wire the bridge then.

  app.all("/mcp", async (req: Request, res: Response) => {
    const mcpSessionId = req.headers["mcp-session-id"] as string | undefined;

    console.error(`[MCP] ${req.method} request, session: ${mcpSessionId || 'new'}`);

    try {
      if (mcpSessionId && sessions.has(mcpSessionId)) {
        const entry = sessions.get(mcpSessionId)!;
        await entry.transport.handleRequest(req, res, req.body);
        if (req.method === "DELETE") {
          sessions.delete(mcpSessionId);
          entry.transport.close();
        }
        return;
      }

      const sessionId = mcpSessionId || crypto.randomUUID();

      const server = await createMcpServer({
        sessionId,
        storage: factory.getStorage(),
        hubStorage,
        hubThoughtStore: localHubThoughtStore,
        dataDir,
        workspaceId: LOCAL_WORKSPACE_ID,
        onHubEvent: broadcastHubEvent,
        config: {
          disableThoughtLogging:
            (process.env.DISABLE_THOUGHT_LOGGING || "").toLowerCase() === "true",
        },
      });

      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => sessionId,
        enableJsonResponse: true,
      });

      sessions.set(sessionId, {
        transport,
        server,
        workspaceId: LOCAL_WORKSPACE_ID,
      });
      transport.onclose = () => sessions.delete(transport.sessionId || sessionId);

      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);

      if (req.method === "DELETE") {
        sessions.delete(sessionId);
        transport.close();
      }
    } catch (error) {
      console.error("MCP ERROR:", error);
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: "2.0",
          error: { code: -32603, message: "Internal server error" },
          id: null,
        });
      }
    }
  });

  app.get("/health", (_: Request, res: Response) =>
    res.json({
      status: "ok",
      transport: "streamable-http",
      server: "team-hub",
      version: SERVER_VERSION,
    })
  );

  app.get("/info", (_: Request, res: Response) =>
    res.json({
      status: "ok",
      server: { name: "team-hub-server", version: SERVER_VERSION },
      workspaceId: LOCAL_WORKSPACE_ID,
      dataDir,
      tools: ["thoughtbox_search", "thoughtbox_execute"],
      endpoints: ["/mcp", "/hub/api", "/events", "/health", "/info"],
    })
  );

  // Hub HTTP surface (`POST /hub/api`) for non-MCP clients, plus the SSE
  // event stream (`GET /events`). The hub handler's thought store is the same
  // shared adapter the MCP sessions use, so hub-created sessions and
  // merge_proposal synthesis thoughts genuinely persist.
  const hubHandler = createHubHandler(
    hubStorage,
    localHubThoughtStore,
    broadcastHubEvent,
  );
  createHubApiSurface(hubHandler).mount(app);
  eventStream.mount(app);

  const httpServer = app.listen(port, () => {
    console.log(`Team Hub MCP Server listening on port ${port}`);
  });

  const shutdown = async () => {
    for (const entry of sessions.values()) {
      try {
        entry.transport.close();
      } catch {
        // ignore
      }
    }
    httpServer.close(() => process.exit(0));
  };

  process.on("SIGTERM", () => void shutdown());
  process.on("SIGINT", () => void shutdown());
}

startHttpServer().catch((error) => {
  console.error("Fatal error starting HTTP server:", error);
  process.exit(1);
});
