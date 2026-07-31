/**
 * Per-request agent identity resolution (SPEC-HUB-003).
 *
 * The durable agent record is the source of identity truth. A request proves
 * its right to an agentId with what the request itself carries: the explicit
 * `agentId` argument (the server-minted handle) plus, in hosted mode, the
 * authenticated principal. No per-connection state participates — this
 * module has no notion of an MCP session, which is why the identity layer
 * survives MCP 2026-07-28 sessionless operation unchanged (c7).
 *
 * This replaces SessionIdentityRegistry, which bound identity to the MCP
 * session id and therefore died with the connection: coordinator power was
 * lost permanently, a reconnecting agent could only re-register into a new
 * identity with no memberships, and every request under a sessionless
 * transport would have collapsed into one '__default__' identity.
 */

import { resolveAgentId } from './agent-identity.js';
import type { HubStorage } from './hub-types.js';

/**
 * Carried on register/quick_join responses. The handle IS the identity, so
 * the one thing a caller must do with it is keep it (spec: "register returns
 * one — record and reuse it").
 */
export const AGENT_ID_GUIDANCE =
  'Record this agentId and pass it as `agentId` on every later hub call. ' +
  'Hub identity is durable and independent of this connection: reuse the same ' +
  'agentId from a new session or client rather than registering again.';

/**
 * Raised for an agentId-less mutation with no process-level identity
 * configured. Names the requirement and how to obtain a handle (c5).
 */
export const AGENT_ID_REQUIRED_ERROR =
  'Hub mutations require an explicit agentId; register returns one — record and reuse it. ' +
  'Pass agentId on the call, or configure a process-level identity with ' +
  'THOUGHTBOX_AGENT_ID + THOUGHTBOX_AGENT_NAME.';

export interface IdentityResolverOptions {
  storage: HubStorage;
  /**
   * Hosted multi-tenant deployment. Turns on the ownerPrincipal checks of
   * c3. Local fs mode (the only mode this server wires today) leaves it
   * false: any explicit agentId with an existing record resolves, matching
   * the assertion-based THOUGHTBOX_AGENT_NAME behavior — the trust boundary
   * is the machine.
   */
  hostedMode?: boolean;
  envAgentId?: string;
  envAgentName?: string;
}

export interface IdentityResolver {
  /**
   * Materialize the process-level env identity (creating its record when the
   * name is new) without resolving a call. THOUGHTBOX_AGENT_ID/NAME declare
   * "this process is this agent", so the record must exist even for a caller
   * that only ever passes that agentId explicitly. Memoized: one lookup per
   * process, not one per request. Returns null when no env identity is set.
   */
  ensureEnvIdentity(): Promise<string | null>;
  /** Resolve, or throw the instructive error when nothing resolves. */
  resolve(explicitAgentId?: unknown, requestPrincipal?: string): Promise<string>;
  /**
   * Resolve, or return null when nothing resolves. For the identity-minting
   * operations (register, quick_join), which cannot require the handle they
   * exist to hand out.
   */
  resolveOptional(explicitAgentId?: unknown, requestPrincipal?: string): Promise<string | null>;
}

export function createIdentityResolver(options: IdentityResolverOptions): IdentityResolver {
  const { storage, hostedMode = false, envAgentId, envAgentName } = options;

  // Env identity resolution is process-level, so it is memoized here rather
  // than repeated per call: `resolveAgentId` creates the agent when the name
  // is new, and concurrent unmemoized calls would mint one agent per caller.
  // Memoized as a PROMISE, not a boolean, so a concurrent caller cannot slip
  // past a resolution still in flight; a failed attempt clears the memo so it
  // is retried rather than poisoning every later call.
  let envResolution: Promise<string | null> | null = null;

  const resolveEnvIdentity = (): Promise<string | null> => {
    envResolution ??= resolveAgentId(storage, envAgentId, envAgentName).catch(
      (error: unknown) => {
        envResolution = null;
        throw error;
      },
    );
    return envResolution;
  };

  async function resolveExplicit(agentId: string, requestPrincipal?: string): Promise<string> {
    const record = await storage.getAgent(agentId);
    if (!record) {
      throw new Error(
        `Unknown agent '${agentId}': no durable agent record exists. ` +
          'Register to mint one, then record and reuse the returned agentId.',
      );
    }

    if (hostedMode) {
      if (record.ownerPrincipal === undefined || record.ownerPrincipal === null) {
        // Legacy adoption: a record predating principal binding is claimed by
        // the first principal that successfully acts as it, and stamped so
        // the claim is not re-openable.
        if (requestPrincipal !== undefined) {
          await storage.saveAgent({ ...record, ownerPrincipal: requestPrincipal });
        }
      } else if (record.ownerPrincipal !== requestPrincipal) {
        throw new Error(
          `Agent '${agentId}' is owned by another principal.`,
        );
      }
    }

    return record.agentId;
  }

  async function resolveOptional(
    explicitAgentId?: unknown,
    requestPrincipal?: string,
  ): Promise<string | null> {
    if (typeof explicitAgentId === 'string' && explicitAgentId.length > 0) {
      return resolveExplicit(explicitAgentId, requestPrincipal);
    }
    return resolveEnvIdentity();
  }

  return {
    ensureEnvIdentity: resolveEnvIdentity,
    resolveOptional,

    async resolve(explicitAgentId, requestPrincipal) {
      const resolved = await resolveOptional(explicitAgentId, requestPrincipal);
      if (!resolved) throw new Error(AGENT_ID_REQUIRED_ERROR);
      return resolved;
    },
  };
}
