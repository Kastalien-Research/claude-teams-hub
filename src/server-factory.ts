import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ListResourcesRequestSchema, ListResourceTemplatesRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { HubStorage } from "./hub/hub-types.js";
import type { HubEvent } from "./hub/hub-handler.js";
import { createHubToolHandler } from "./hub/hub-tool-handler.js";
import {
  createThoughtStoreAdapter,
  type ThoughtStoreAdapter,
} from "./hub/thought-store-adapter.js";
import { FileSystemTaskStore } from "./hub/hub-task-store.js";
import { InMemoryTaskStore, InMemoryTaskMessageQueue } from "@modelcontextprotocol/sdk/experimental/tasks/stores/in-memory.js";
import { PATTERNS_COOKBOOK } from "./resources/patterns-cookbook-content.js";
import { THOUGHTBOX_CIPHER } from "./resources/thoughtbox-cipher-content.js";
import { SESSION_ANALYSIS_GUIDE } from "./resources/session-analysis-guide-content.js";
import { PARALLEL_VERIFICATION_CONTENT } from "./prompts/contents/parallel-verification.js";

import {
  LIST_MCP_ASSETS_PROMPT,
  getListMcpAssetsContent,
  INTERLEAVED_THINKING_PROMPT,
  getInterleavedThinkingContent,
  getInterleavedGuideForUri,
} from "./prompts/index.js";
import {
  STATIC_RESOURCES,
  RESOURCE_TEMPLATES,
  resourceTemplate,
} from "./resources/static-registry.js";
import {
  InMemoryStorage,
  type ThoughtboxStorage,
} from "./persistence/index.js";
import { SessionHandler } from "./sessions/index.js";
import { ThoughtHandler } from "./thought-handler.js";
import { SessionTool } from "./sessions/tool.js";
import { ThoughtTool } from "./thought/tool.js";
import { getOperationsCatalog as getSessionOperationsCatalog, getOperation as getSessOp } from "./sessions/operations.js";
import { getOperationsCatalog as getHubOperationsCatalog, getOperation as getHubOp } from "./hub/operations.js";
import {
  SearchTool, SEARCH_TOOL,
  ExecuteTool, EXECUTE_TOOL,
  buildSearchCatalog,
} from "./code-mode/index.js";

/** Keep in sync with package.json version; avoid importing outside src/ (tsconfig rootDir). */
const SERVER_VERSION = "0.1.0";

// Configuration schema
// Note: Using .default() means the field is always present after parsing.
export const configSchema = z.object({
  disableThoughtLogging: z
    .boolean()
    .default(false)
    .describe(
      "Disable thought output to stderr (useful for production deployments)"
    ),
  // Session management options
  autoCreateSession: z
    .boolean()
    .default(true)
    .describe("Auto-create reasoning session on first thought"),
  reasoningSessionId: z
    .string()
    .optional()
    .describe("Pre-load a specific reasoning session on server start"),
});

// Parsed config type (with defaults applied)
export type ServerConfig = z.infer<typeof configSchema>;

// Input config type (before parsing, allows omitting fields with defaults)
export type ServerConfigInput = z.input<typeof configSchema>;

import type { Logger } from './types.js';
export type { Logger } from './types.js';

export interface CreateMcpServerArgs {
  /** MCP connection session ID (if available) */
  sessionId?: string;
  /** Server configuration */
  config?: ServerConfigInput;
  /** Optional logger (defaults to stderr logger) */
  logger?: Logger;
  /**
   * Storage implementation for persistence.
   * Defaults to InMemoryStorage if not provided.
   * Use FileSystemStorage for durable persistence to disk.
   */
  storage?: ThoughtboxStorage;
  /**
   * Hub storage for multi-agent coordination. Must be the single
   * process-shared instance so workspaces, agents, and proposals are
   * visible across MCP sessions; tb.hub.* is unavailable without it.
   */
  hubStorage?: HubStorage;
  /**
   * Shared thought store for hub session persistence. Must be the single
   * process-shared adapter: per-session FileSystemStorage holds an
   * in-memory session index, so hub main-sessions created by one MCP
   * session would otherwise be invisible to another (merge_proposal would
   * fail with "Session not found"). When omitted, falls back to this
   * session's storage.
   */
  hubThoughtStore?: ThoughtStoreAdapter;
  /** Optional callback for hub events (unified SSE event stream) */
  onHubEvent?: (event: HubEvent) => void;
  /** Data directory for task store (filesystem persistence) */
  dataDir?: string;
  /** Workspace ID this server instance is scoped to */
  workspaceId?: string;
}

const defaultLogger: Logger = {
  debug(message: string, ...args: unknown[]) { console.error(`[DEBUG] ${message}`, ...args); },
  info(message: string, ...args: unknown[]) { console.error(`[INFO] ${message}`, ...args); },
  warn(message: string, ...args: unknown[]) { console.error(`[WARN] ${message}`, ...args); },
  error(message: string, ...args: unknown[]) { console.error(`[ERROR] ${message}`, ...args); },
};

function serializeToolError(err: unknown): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    error: err instanceof Error ? err.message : String(err),
  };

  if (err && typeof err === "object") {
    if ("code" in err && typeof err.code === "string") {
      payload.code = err.code;
    }
    if ("details" in err && err.details !== undefined) {
      payload.details = err.details;
    }
    if ("data" in err && err.data !== undefined) {
      payload.data = err.data;
    }
  }

  return payload;
}

/**
 * Side-effect-free server factory.
 * - No transport binding
 * - No HTTP listen
 * - No process signal handlers
 */
export async function createMcpServer(args: CreateMcpServerArgs = {}): Promise<McpServer> {
  const sessionId = args.sessionId;
  const config = configSchema.parse(args.config ?? {});
  const logger = args.logger ?? defaultLogger;

  const TEAM_HUB_INSTRUCTIONS = `Claude Teams Hub is a multi-agent coordination server using Code Mode.

Two tools:
- \`thoughtbox_search\`: write JavaScript to query the operation/prompt/resource catalog
- \`thoughtbox_execute\`: write JavaScript using the \`tb\` SDK to chain operations

Workflow: search to discover available operations, then execute code against them.

\`tb\` namespaces:
- \`tb.hub\`: workspaces, agent identity, problems, proposals, consensus, channels
- \`tb.thought\` / \`tb.session\`: transitional thought + reasoning-session ledger
- \`tb.vars\`: values carried across execute calls

Hub identity is durable, not per-connection: \`tb.hub.register()\` /
\`tb.hub.quickJoin()\` return an \`agentId\` — record it and pass it as
\`agentId\` on every later hub call, including after reconnecting. Registering
again mints a NEW agent rather than recovering the previous one.

Use \`console.log()\` for debugging — output captured in response logs.`;

  // MCP tasks capability (SDK 1.29.0): durable task store when a data
  // directory is configured, volatile otherwise.
  const taskStore = args.dataDir
    ? new FileSystemTaskStore(args.dataDir)
    : new InMemoryTaskStore();
  const taskMessageQueue = new InMemoryTaskMessageQueue();

  const server = new McpServer({
    name: "team-hub-server",
    version: SERVER_VERSION,
  }, {
    instructions: TEAM_HUB_INSTRUCTIONS,
    taskStore,
    taskMessageQueue,
  });

  // Shared storage instance for this MCP server instance (used by thought + session tooling)
  // Use provided storage or default to InMemoryStorage
  const storage: ThoughtboxStorage = args.storage ?? new InMemoryStorage();

  // Create server instances with MCP session ID for client isolation
  const thoughtHandler = new ThoughtHandler(
    config.disableThoughtLogging,
    storage,
    sessionId // MCP session ID for isolation
  );

  const sessionHandler = new SessionHandler({
    storage,
    thoughtHandler,
  });

  // Log server creation when sessionId is available
  if (sessionId) {
    logger.info(`Creating server for MCP session: ${sessionId}`);
  }

  // Initialize persistence layer — must complete before tools are registered
  try {
    await thoughtHandler.initialize();
    logger.info("Persistence layer initialized");

    if (config.reasoningSessionId) {
      try {
        await thoughtHandler.loadSession(config.reasoningSessionId);
        logger.info(`Pre-loaded reasoning session: ${config.reasoningSessionId}`);
      } catch (loadErr) {
        logger.warn(
          `Failed to pre-load reasoning session ${config.reasoningSessionId}:`,
          loadErr
        );
      }
    }

    try {
      await sessionHandler.init();
    } catch (err) {
      logger.warn("Session handler init failed:", err);
    }
  } catch (err) {
    logger.error("Failed to initialize persistence layer:", err);
  }

  // Resolve project scope.
  //
  // This server is local-only, so a workspace id is always available:
  // args.workspaceId (index.ts passes LOCAL_WORKSPACE_ID), the
  // THOUGHTBOX_PROJECT env var, or "default". The upstream Thoughtbox
  // factory had a third branch that asked the client for its roots
  // (server.server.listRoots) when neither was set; that branch — and the
  // 3s Promise.race seatbelt that capped the "first tool call on every
  // session hangs for 300s" bug (typescript-sdk#1167) — was deleted with
  // it, because no configuration here can reach it.
  let projectResolved = false;
  const resolveProject = async () => {
    if (projectResolved) return;
    projectResolved = true;

    const project = args.workspaceId || process.env.THOUGHTBOX_PROJECT || "default";
    try {
      await storage.setProject(project);
      logger.info(`Project scoped to: ${project}`);
    } catch (err) {
      logger.warn('Failed to scope project:', err);
    }
  };

  // Helper to register tools with standardized error handling
  // Calls resolveProject() on first invocation (transport must be connected)
  const registerTool = <T>(
    toolDef: { name: string; description: string; inputSchema: any; annotations?: any },
    toolInstance: { handle: (args: T) => Promise<any> },
  ) => {
    server.registerTool(
      toolDef.name,
      {
        description: toolDef.description,
        inputSchema: toolDef.inputSchema as any,
        annotations: toolDef.annotations,
      },
      async (args: any) => {
        await resolveProject();
        try {
          const result = await toolInstance.handle(args as any);
          if (result && Array.isArray(result.content)) {
            return result;
          }
          return {
            content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
          };
        } catch (err: any) {
          return {
            content: [{ type: "text" as const, text: JSON.stringify(serializeToolError(err), null, 2) }],
            isError: true,
          };
        }
      }
    );
  };

  // =============================================================================
  // Code Mode Tools
  // =============================================================================

  const sessionTool = new SessionTool(sessionHandler);
  const thoughtTool = new ThoughtTool(thoughtHandler);

  // Hub dispatcher — tb.hub.* over the process-shared hub storage.
  // Hub state (workspaces, agents, proposals) is shared across MCP sessions
  // via args.hubStorage; the thought store delegates to THIS session's
  // storage so merge_proposal synthesis thoughts persist with the session's
  // real backend.
  // Identity is resolved per request from durable hub storage (SPEC-HUB-003):
  // a call acts as the agentId it carries, or as the process-level env
  // identity, and the MCP session takes no part. Nothing session-scoped is
  // passed in, which is why this wiring needs no change when the transport
  // drops sessions.
  const hubToolHandler = args.hubStorage
    ? createHubToolHandler({
        hubStorage: args.hubStorage,
        thoughtStore: args.hubThoughtStore ?? createThoughtStoreAdapter(storage),
        envAgentId: process.env.THOUGHTBOX_AGENT_ID,
        envAgentName: process.env.THOUGHTBOX_AGENT_NAME,
        onEvent: args.onHubEvent,
      })
    : undefined;
  const hubDispatcher = hubToolHandler
    ? {
        handle: (input: { operation: string; [key: string]: unknown }) =>
          hubToolHandler.handle(input),
      }
    : undefined;

  const searchCatalog = buildSearchCatalog();
  const searchTool = new SearchTool(searchCatalog);
  const executeTool = new ExecuteTool({
    thoughtTool,
    sessionTool,
    hubDispatcher,
  });

  registerTool(SEARCH_TOOL, searchTool);
  registerTool(EXECUTE_TOOL, executeTool);

  logger.info('Code Mode tools registered (search + execute)');

  // Register prompts using McpServer's registerPrompt API
  server.registerPrompt(
    "list_mcp_assets",
    {
      description: LIST_MCP_ASSETS_PROMPT.description,
    },
    async () => ({
      messages: [
        {
          role: "assistant" as const,
          content: { type: "text" as const, text: getListMcpAssetsContent() },
        },
      ],
    })
  );

  server.registerPrompt(
    "interleaved-thinking",
    {
      description: INTERLEAVED_THINKING_PROMPT.description,
      argsSchema: {
        task: z.string().describe("The task to reason about"),
        thoughts_limit: z.string().optional().describe("Maximum number of thoughts"),
        clear_folder: z.string().optional().describe("Whether to clear folder (true/false)"),
      },
    },
    async (toolArgs) => {
      if (!toolArgs.task) {
        throw new Error("Missing required argument: task");
      }
      const content = getInterleavedThinkingContent({
        task: toolArgs.task,
        thoughts_limit: toolArgs.thoughts_limit
          ? parseInt(toolArgs.thoughts_limit, 10)
          : undefined,
        clear_folder: toolArgs.clear_folder === "true",
      });
      return {
        messages: [
          {
            role: "user" as const,
            content: { type: "text" as const, text: content },
          },
        ],
      };
    }
  );

  // ===========================================================================
  // Static resources + resource templates (metadata from the single registry)
  // ===========================================================================
  // STATIC_RESOURCES / RESOURCE_TEMPLATES in src/resources/static-registry.ts
  // are the single source of truth for names, URIs, descriptions, and MIME
  // types. Content resolvers live here because they close over runtime
  // handlers. Resolvers are keyed by registry KEY rather than URI, so
  // re-namespacing a URI in the registry cannot silently orphan a resolver.
  // Registration throws at startup if a registry entry has no resolver, so
  // the registry and this map cannot drift silently.

  const staticResourceResolvers: Record<string, () => Promise<string> | string> = {
    status: () =>
      JSON.stringify(
        {
          name: "team-hub",
          version: SERVER_VERSION,
          tools: 2,
          namespaces: ["hub", "thought", "session", "vars"],
          dataDir: args.dataDir ?? null,
        },
        null,
        2
      ),
    "session-operations": () => getSessionOperationsCatalog(),
    "hub-operations": () => getHubOperationsCatalog(),
    "gateway-operations": () =>
      JSON.stringify(
        {
          version: "1.0.0",
          publicTools: searchCatalog.publicTools,
          operations: searchCatalog.operations,
        },
        null,
        2
      ),
    "patterns-cookbook": () => PATTERNS_COOKBOOK,
    cipher: () => THOUGHTBOX_CIPHER,
    "session-analysis-guide": () => SESSION_ANALYSIS_GUIDE,
    "parallel-verification-guide": () => PARALLEL_VERIFICATION_CONTENT,
  };

  for (const def of STATIC_RESOURCES) {
    const resolve = staticResourceResolvers[def.key];
    if (!resolve) {
      throw new Error(
        `Static resource ${def.key} (${def.uri}) is in the registry but has no content resolver`
      );
    }
    server.registerResource(
      def.key,
      def.uri,
      { description: def.description, mimeType: def.mimeType },
      async (uri) => ({
        contents: [
          {
            uri: uri.toString(),
            mimeType: def.mimeType,
            text: await resolve(),
          },
        ],
      })
    );
  }

  // Resource templates: handlers are bespoke, metadata comes from the registry.
  const registerTemplate = (
    key: string,
    handler: (uri: URL, params: Record<string, string | string[] | undefined>) => Promise<{
      contents: Array<{ uri: string; mimeType: string; text: string }>;
    }>,
  ) => {
    const def = resourceTemplate(key);
    server.registerResource(
      def.key,
      new ResourceTemplate(def.uriTemplate, { list: undefined }),
      { description: def.description, mimeType: def.mimeType },
      handler as any
    );
  };

  registerTemplate("session-operation", async (uri, { op }) => {
    const opDef = getSessOp(op as string);
    if (!opDef) throw new Error(`Unknown session operation: ${op}`);
    return { contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify(opDef, null, 2) }] };
  });

  registerTemplate("hub-operation", async (uri, { op }) => {
    const opDef = getHubOp(op as string);
    if (!opDef) throw new Error(`Unknown hub operation: ${op}`);
    return { contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify(opDef, null, 2) }] };
  });

  registerTemplate("gateway-operation", async (uri, { op }) => {
    const opName = op as string;
    for (const [module, ops] of Object.entries(searchCatalog.operations)) {
      const opDef = (ops as Record<string, object>)[opName];
      if (opDef) {
        return { contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify({ module, name: opName, ...opDef }, null, 2) }] };
      }
    }
    throw new Error(`Unknown gateway operation: ${opName}`);
  });

  registerTemplate("interleaved-guide", async (_uri, { guide }) => ({
    contents: [getInterleavedGuideForUri(`thoughtbox://interleaved/${guide as string}`)],
  }));

  // Escape hatches: both list handlers are generated from the same registry
  // the registrations above use, so the three views cannot drift.
  server.server.setRequestHandler(ListResourcesRequestSchema, async () => ({
    resources: STATIC_RESOURCES.map((def) => ({
      uri: def.uri,
      name: def.name,
      description: def.description,
      mimeType: def.mimeType,
    })),
  }));

  server.server.setRequestHandler(
    ListResourceTemplatesRequestSchema,
    async () => ({
      resourceTemplates: RESOURCE_TEMPLATES.map((def) => ({
        uriTemplate: def.uriTemplate,
        name: def.name,
        description: def.description,
        mimeType: def.mimeType,
      })),
    })
  );

  return server;
}

export default createMcpServer;
