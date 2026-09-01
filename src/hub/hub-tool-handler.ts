/**
 * Hub Tool Handler — testable wrapper connecting hub domain to MCP tool interface
 *
 * This module creates a handler that:
 * 1. Resolves agent identity PER REQUEST from durable storage (SPEC-HUB-003)
 * 2. Routes operations through the hub-handler
 * 3. Returns MCP-formatted content results
 *
 * Identity resolution consults no connection state. The MCP session id is
 * still accepted so existing transports can pass it, but nothing reads it:
 * the same call sequence resolves identically with distinct session ids, with
 * one, or with none (c7), which is what makes the identity layer ready for
 * MCP 2026-07-28 sessionless operation.
 */

import { createHubHandler, type HubEvent, type HubHandler } from './hub-handler.js';
import { createIdentityResolver } from './identity-resolver.js';
import type { HubStorage } from './hub-types.js';
import { getOperation as getHubOperation } from './operations.js';

interface ThoughtStore {
  createSession(sessionId: string): Promise<void>;
  saveThought(sessionId: string, thought: any): Promise<void>;
  getThought(sessionId: string, thoughtNumber: number): Promise<any>;
  getThoughts(sessionId: string): Promise<any[]>;
  getThoughtCount(sessionId: string): Promise<number>;
  saveBranchThought(sessionId: string, branchId: string, thought: any): Promise<void>;
  getBranch(sessionId: string, branchId: string): Promise<any[]>;
}

export interface HubToolHandlerOptions {
  hubStorage: HubStorage;
  thoughtStore: ThoughtStore;
  envAgentId?: string;
  envAgentName?: string;
  onEvent?: (event: HubEvent) => void;
  /**
   * Hosted multi-tenant deployment: agents are bound to the authenticated
   * principal of the request that created them, and acting as an agent
   * requires that principal (c3). Local fs mode — the only mode this server
   * wires today — leaves this false and resolves any existing agentId by
   * assertion, the trust boundary being the machine.
   */
  hostedMode?: boolean;
  /**
   * Injection seam (RFC 0001): supply a pre-built HubHandler — e.g. a
   * celld-routing wrapper — instead of letting createHubToolHandler
   * construct one from hubStorage. When absent, construction from
   * hubStorage/thoughtStore is unchanged.
   */
  hubHandler?: HubHandler;
}

type HubContentBlock =
  | { type: 'text'; text: string }
  | { type: 'resource'; resource: { uri: string; mimeType: string; text: string } };

export interface HubToolResult {
  content: Array<HubContentBlock>;
  isError?: boolean;
}

/** Per-request context the transport supplies. */
export interface HubRequestContext {
  /**
   * The authenticated principal (API key id / OAuth subject) of this
   * request, in hosted mode. Nothing supplies it in local fs mode.
   */
  principal?: string;
}

export interface HubToolHandler {
  handle(
    input: { operation: string; [key: string]: unknown },
    /** Accepted for transport compatibility; identity resolution ignores it. */
    mcpSessionId?: string,
    request?: HubRequestContext,
  ): Promise<HubToolResult>;
}

/** Operations that mint identity: they cannot require the handle they hand out. */
const IDENTITY_MINTING_OPERATIONS = new Set(['register', 'quick_join']);

/**
 * Serialize a caught error to the MCP text-content body (RFC 0001 §Error
 * codes). Additive: an error with no string `code` property serializes to
 * the exact pre-existing shape `{ error }` — byte-identical, pinned by
 * `error-propagation.test.ts` — so every filesystem-workspace error is
 * unaffected. An error carrying `code` (e.g. CelldError) additionally
 * serializes `retryable`/`details` when present, in a fixed key order.
 */
function serializeHubError(error: any): Record<string, unknown> {
  const code = typeof error?.code === 'string' ? error.code : undefined;
  if (code === undefined) {
    return { error: error.message };
  }
  const body: Record<string, unknown> = { error: error.message, code };
  if (typeof error.retryable === 'boolean') body.retryable = error.retryable;
  if (error.details !== undefined && typeof error.details === 'object') {
    body.details = error.details;
  }
  return body;
}

export function createHubToolHandler(options: HubToolHandlerOptions): HubToolHandler {
  const { hubStorage, thoughtStore, envAgentId, envAgentName, onEvent, hostedMode } = options;

  const hubHandler =
    options.hubHandler ?? createHubHandler(hubStorage, thoughtStore, onEvent, { hostedMode });

  const identities = createIdentityResolver({
    storage: hubStorage,
    hostedMode,
    envAgentId,
    envAgentName,
  });

  async function resolveActingAgent(
    operation: string,
    callerAgentId: unknown,
    principal: string | undefined,
  ): Promise<string | null> {
    // register always mints a fresh agent, so it never resolves an identity.
    if (operation === 'register') return null;
    // quick_join resolves one when the caller carries a handle (so a repeat
    // join reuses the agent instead of minting an orphan) but must not
    // require one — minting is half of what it does.
    if (IDENTITY_MINTING_OPERATIONS.has(operation)) {
      return identities.resolveOptional(callerAgentId, principal);
    }
    // list_workspaces is unauthenticated; asking it for an identity would
    // make discovery impossible before registration.
    if (operation === 'list_workspaces') return null;
    return identities.resolve(callerAgentId, principal);
  }

  return {
    async handle(input, _mcpSessionId?, request?) {
      const { operation, agentId: callerAgentId, ...args } = input;
      const principal = request?.principal;

      try {
        // A configured env identity exists as a record from the first call
        // onward, so a caller may address it explicitly without having made
        // an agentId-less call first. Memoized in the resolver.
        await identities.ensureEnvIdentity();

        const agentId = await resolveActingAgent(
          operation as string,
          callerAgentId,
          principal,
        );

        const result = await hubHandler.handle(
          agentId,
          operation as string,
          args as Record<string, unknown>,
          principal,
        );

        const content: HubContentBlock[] = [
          { type: 'text' as const, text: JSON.stringify(result, null, 2) },
        ];

        // Embed per-operation resource block for agent discoverability
        const opDef = getHubOperation(operation);
        if (opDef) {
          content.push({
            type: 'resource',
            resource: {
              uri: `thoughtbox://hub/operations/${operation}`,
              mimeType: 'application/json',
              text: JSON.stringify(opDef, null, 2),
            },
          });
        }

        return { content };
      } catch (error: any) {
        return {
          content: [
            { type: 'text' as const, text: JSON.stringify(serializeHubError(error), null, 2) },
          ],
          isError: true,
        };
      }
    },
  };
}
