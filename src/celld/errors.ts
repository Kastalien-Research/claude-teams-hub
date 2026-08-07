/**
 * celld error codes and rejection shapes (RFC 0001 §Error codes).
 *
 * Pure leaf module — no zod, no node: imports — so the domain reducer and the
 * Worker bundle can import it without dragging validation machinery along.
 */

import type { JsonValue } from './canonical-json.js';

export const CELLD_ERROR_CODES = [
  'CELLD_UNAVAILABLE',
  'CELLD_PROTOCOL_MISMATCH',
  'CELLD_CANARY_OPERATION_UNSUPPORTED',
  'OPERATION_REQUIRES_CELLD_BACKEND',
  'IDEMPOTENCY_KEY_REUSED',
  'REVISION_CONFLICT',
  'PROBLEM_ALREADY_CLAIMED',
  'NOT_WORKSPACE_MEMBER',
  'BLOCKING_IMPACT_UNACKNOWLEDGED',
  'WORK_INTENT_GENERATION_STALE',
  // Canary additions beyond the required set (RFC 0001 documents both):
  'ALREADY_WORKSPACE_MEMBER',
  'WORKSPACE_NOT_INITIALIZED',
  'VALIDATION_FAILED',
  'NOT_FOUND',
] as const;

export type CelldErrorCode = (typeof CELLD_ERROR_CODES)[number];

/** Codes a caller may retry after the condition clears; everything else is terminal for that command. */
export const RETRYABLE_CODES: ReadonlySet<CelldErrorCode> = new Set(['CELLD_UNAVAILABLE']);

export interface CelldRejection {
  code: CelldErrorCode;
  message: string;
  retryable: boolean;
  details?: Record<string, JsonValue>;
}

/**
 * Error carrying a stable celld code across the hub transport. hub-tool-handler
 * serializes `code`/`retryable`/`details` when present; the Code Mode sandbox
 * additionally sees the code inside the message text (RFC 0001 §Error codes).
 */
export class CelldError extends Error {
  readonly code: CelldErrorCode;
  readonly retryable: boolean;
  readonly details?: Record<string, JsonValue>;

  constructor(r: CelldRejection) {
    super(`[${r.code}] ${r.message}`);
    this.name = 'CelldError';
    this.code = r.code;
    this.retryable = r.retryable;
    if (r.details !== undefined) this.details = r.details;
  }
}

export function rejection(
  code: CelldErrorCode,
  message: string,
  details?: Record<string, JsonValue>,
): CelldRejection {
  const r: CelldRejection = { code, message, retryable: RETRYABLE_CODES.has(code) };
  if (details !== undefined) r.details = details;
  return r;
}
