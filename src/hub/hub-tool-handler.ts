/**
 * Hub Tool Handler — testable wrapper connecting hub domain to MCP tool interface
 *
 * This module creates a handler that:
 * 1. Resolves agent identity from env vars on first call
 * 2. Routes operations through the hub-handler
 * 3. Returns MCP-formatted content results
 */

import { createHubHandler, type HubEvent, type HubHandler } from './hub-handler.js';
import { resolveAgentId } from './agent-identity.js';
import type { HubStorage } from './hub-types.js';
import { getOperation as getHubOperation } from './operations.js';
import { SessionIdentityRegistry } from './session-identity.js';

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
   * Shared session identity registry. Pass the same instance to other
   * namespaces that follow the explicit-agentId convention (tb.claims) so
   * one hub registration grants an identity across all of them.
   */
  identityRegistry?: SessionIdentityRegistry;
}

type HubContentBlock =
  | { type: 'text'; text: string }
  | { type: 'resource'; resource: { uri: string; mimeType: string; text: string } };

export interface HubToolResult {
  content: Array<HubContentBlock>;
  isError?: boolean;
}

export interface HubToolHandler {
  handle(input: { operation: string; [key: string]: unknown }, mcpSessionId?: string): Promise<HubToolResult>;
}

export function createHubToolHandler(options: HubToolHandlerOptions): HubToolHandler {
  const { hubStorage, thoughtStore, envAgentId, envAgentName, onEvent } = options;

  const hubHandler = createHubHandler(hubStorage, thoughtStore, onEvent);

  // Connection-scoped identity registry: env-var-resolved or
  // first-registered agentId per session becomes the default; the registry
  // tracks all agentIds registered within a session (for multi-agent).
  // Shared with other namespaces (tb.claims) when passed in via options.
  const identities = options.identityRegistry ?? new SessionIdentityRegistry();

  // Memoized as a PROMISE, not a boolean: a boolean flipped before the await
  // let a concurrent caller skip past an env resolution still in flight and
  // resolve a null default, minting an agent the env identity should have
  // been (docs/known-issues.md #5). A failed attempt clears the memo so it
  // is retried rather than poisoning every later call.
  let envResolution: Promise<void> | null = null;

  function ensureEnvResolved(sessionKey: string): Promise<void> {
    envResolution ??= (async () => {
      const resolved = await resolveAgentId(hubStorage, envAgentId, envAgentName);
      if (resolved) {
        identities.register(sessionKey, resolved);
      }
    })().catch((error: unknown) => {
      envResolution = null;
      throw error;
    });
    return envResolution;
  }

  // Registration establishes the session's implicit identity, and the
  // resolve → register → capture window spans an await. Two concurrent first
  // registrations therefore both observed a null session default and both
  // minted an agent; only the first-completed became the implicit identity,
  // so the other caller's implicit calls silently acted as it and failed
  // `Not a member of this workspace` (docs/known-issues.md #5). Serializing
  // per sessionKey makes that window atomic: the second caller observes the
  // first's identity and quick_join's reuse path (issue #1) can fire.
  const registrationLocks = new Map<string, Promise<void>>();

  async function withRegistrationLock<T>(
    sessionKey: string, run: () => Promise<T>
  ): Promise<T> {
    const prior = registrationLocks.get(sessionKey) ?? Promise.resolve();
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const tail = prior.then(() => held);
    registrationLocks.set(sessionKey, tail);
    await prior;
    try {
      return await run();
    } finally {
      release();
      // Drop the entry when nothing queued behind us, so a long-lived server
      // does not retain one promise per session it ever saw.
      if (registrationLocks.get(sessionKey) === tail) {
        registrationLocks.delete(sessionKey);
      }
    }
  }

  async function dispatch(
    sessionKey: string,
    operation: string,
    callerAgentId: unknown,
    args: Record<string, unknown>,
  ): Promise<unknown> {
    // register always mints; quick_join sees the session default so the
    // hub handler can reuse it instead of registering an orphan
    // (docs/known-issues.md #1). Explicit callerAgentId still applies
    // only to stage-1+ operations.
    const agentId =
      operation === 'register'
        ? null
        : operation === 'quick_join'
          ? identities.resolve(sessionKey, undefined)
          : identities.resolve(sessionKey, callerAgentId);

    const result = await hubHandler.handle(agentId, operation, args);

    // Capture registration results into the session registry
    if (operation === 'register' || operation === 'quick_join') {
      captureRegistration(sessionKey, result);
    }

    return result;
  }

  function captureRegistration(
    sessionKey: string, result: unknown
  ): void {
    if (result && typeof result === 'object' && 'agentId' in result) {
      identities.register(sessionKey, (result as { agentId: string }).agentId);
    }
  }

  return {
    async handle(input, mcpSessionId?) {
      const { operation, agentId: callerAgentId, ...args } = input;
      const sessionKey = mcpSessionId || '__default__';

      await ensureEnvResolved(sessionKey);

      try {
        const isRegistration = operation === 'register' || operation === 'quick_join';
        const result = isRegistration
          ? await withRegistrationLock(sessionKey, () =>
              dispatch(sessionKey, operation as string, callerAgentId, args as Record<string, unknown>))
          : await dispatch(
              sessionKey, operation as string, callerAgentId, args as Record<string, unknown>);

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
          content: [{ type: 'text' as const, text: JSON.stringify({ error: error.message }, null, 2) }],
          isError: true,
        };
      }
    },
  };
}
