/**
 * celld wire contracts (RFC 0001 §Wire contracts).
 *
 * Zod-backed envelopes shared by the Node client and the Worker HTTP layer.
 * The domain reducer (src/celld/domain/) deliberately does NOT import zod —
 * it receives already-validated commands; validation lives at the two edges.
 */

import { z } from 'zod';
import type { JsonValue } from './canonical-json.js';
import type { CelldRejection } from './errors.js';

export const COMMAND_SCHEMA_VERSION = 'hub-command-v1' as const;
export const EVENT_SCHEMA_VERSION = 'hub-event-v1' as const;

export {
  CELLD_ERROR_CODES,
  RETRYABLE_CODES,
  CelldError,
  rejection,
  type CelldErrorCode,
  type CelldRejection,
} from './errors.js';

// =============================================================================
// Envelopes
// =============================================================================

const jsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(jsonValueSchema),
    z.record(jsonValueSchema),
  ]),
);

export const actorSchema = z
  .object({
    agentId: z.string().min(1),
    promptVersion: z.string().optional(),
  })
  .strict();

export const commandContextSchema = z
  .object({
    teamRunId: z.string().optional(),
    nativeTaskId: z.string().optional(),
    processRunId: z.string().optional(),
  })
  .strict();

export const hubCommandV1Schema = z
  .object({
    schemaVersion: z.literal(COMMAND_SCHEMA_VERSION),
    commandId: z.string().min(1),
    operation: z.string().min(1),
    workspaceId: z.string().min(1),
    actor: actorSchema,
    issuedAt: z.string().min(1),
    expectedRevision: z.number().int().nonnegative().optional(),
    context: commandContextSchema,
    correlationId: z.string().optional(),
    causationId: z.string().optional(),
    payloadHash: z.string().length(64),
    payload: z.record(jsonValueSchema),
  })
  .strict();

export type HubCommandV1 = z.infer<typeof hubCommandV1Schema>;

export const hubEventV1Schema = z
  .object({
    schemaVersion: z.literal(EVENT_SCHEMA_VERSION),
    eventId: z.string().min(1),
    workspaceId: z.string().min(1),
    sequence: z.number().int().positive(),
    aggregateRevision: z.number().int().positive(),
    type: z.string().min(1),
    commandId: z.string().min(1),
    actor: actorSchema.extend(commandContextSchema.shape),
    occurredAt: z.string().min(1),
    data: z.record(jsonValueSchema),
  })
  .strict();

export type HubEventV1 = z.infer<typeof hubEventV1Schema>;

/**
 * Caller-facing command metadata, passed as `command` on celld mutations
 * (CommandMetadataV1 in RFC 0001).
 */
export const commandMetadataV1Schema = z
  .object({
    id: z.string().min(1),
    expectedRevision: z.number().int().nonnegative().optional(),
    teamRunId: z.string().optional(),
    nativeTaskId: z.string().optional(),
    processRunId: z.string().optional(),
    promptVersion: z.string().optional(),
    correlationId: z.string().optional(),
    causationId: z.string().optional(),
  })
  .strict();

export type CommandMetadataV1 = z.infer<typeof commandMetadataV1Schema>;

// =============================================================================
// Cell HTTP responses
// =============================================================================

/** Successful (or replayed) command execution, as returned by the cell. */
export interface CellCommandResult {
  outcome: 'accepted' | 'rejected';
  replayed: boolean;
  revision: number;
  result?: Record<string, JsonValue>;
  rejection?: CelldRejection;
  firstEventSequence?: number;
  lastEventSequence?: number;
}

// =============================================================================
// Operation surface (RFC 0001 §Operation surface)
// =============================================================================

/** Existing hub operations the canary routes to a celld workspace. */
export const CELLD_SUPPORTED_EXISTING_OPERATIONS = [
  'create_workspace',
  'join_workspace',
  'create_problem',
  'claim_problem',
  'update_problem',
  'list_problems',
  'post_message',
  'read_channel',
  'workspace_status',
  'workspace_digest',
] as const;

/** The five canary operations (catalog 35 → 40). */
export const CELLD_NEW_OPERATIONS = [
  'declare_work_intent',
  'record_work_change',
  'list_impacts',
  'acknowledge_impact',
  'read_workspace_events',
] as const;

/** Celld operations that mutate the cell (require CommandMetadataV1). */
export const CELLD_MUTATION_OPERATIONS = [
  'create_workspace',
  'join_workspace',
  'create_problem',
  'claim_problem',
  'update_problem',
  'post_message',
  'declare_work_intent',
  'record_work_change',
  'acknowledge_impact',
] as const;

export type CelldMutationOperation = (typeof CELLD_MUTATION_OPERATIONS)[number];
export type CelldOperation =
  | (typeof CELLD_SUPPORTED_EXISTING_OPERATIONS)[number]
  | (typeof CELLD_NEW_OPERATIONS)[number];

export function isCelldSupportedOperation(op: string): op is CelldOperation {
  return (
    (CELLD_SUPPORTED_EXISTING_OPERATIONS as readonly string[]).includes(op) ||
    (CELLD_NEW_OPERATIONS as readonly string[]).includes(op)
  );
}

export function isCelldMutation(op: string): op is CelldMutationOperation {
  return (CELLD_MUTATION_OPERATIONS as readonly string[]).includes(op);
}
