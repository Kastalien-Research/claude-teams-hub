/**
 * Canonical JSON + SHA-256 for celld command hashing (RFC 0001).
 *
 * Runtime-portable by construction: Web Crypto and TextEncoder only, no
 * node: imports — this module is bundled into the celld Worker AND imported
 * by the Node client, and the payloadHash must be byte-identical in both.
 * Probed 2026-08-06: identical digests from Node and the celld v0.1.0 worker.
 */

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

/** Recursive sorted-object-key serialization. Arrays keep their order. */
export function canonicalJson(value: JsonValue): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const keys = Object.keys(value).sort();
  const parts = keys.map(k => `${JSON.stringify(k)}:${canonicalJson(value[k] as JsonValue)}`);
  return `{${parts.join(',')}}`;
}

export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('');
}

/**
 * The semantic command hash: everything except `issuedAt` and `payloadHash`
 * (RFC 0001 §Wire contracts). Field selection is explicit rather than
 * delete-based so an envelope gaining a field can never silently join the
 * hash on one side of the wire but not the other.
 */
export async function commandPayloadHash(command: {
  schemaVersion: string;
  commandId: string;
  operation: string;
  workspaceId: string;
  actor: { agentId: string; promptVersion?: string };
  expectedRevision?: number;
  context: { teamRunId?: string; nativeTaskId?: string; processRunId?: string };
  correlationId?: string;
  causationId?: string;
  payload: Record<string, JsonValue>;
}): Promise<string> {
  const semantic: Record<string, JsonValue> = {
    schemaVersion: command.schemaVersion,
    commandId: command.commandId,
    operation: command.operation,
    workspaceId: command.workspaceId,
    actor: command.actor as unknown as JsonValue,
    context: command.context as unknown as JsonValue,
    payload: command.payload,
  };
  if (command.expectedRevision !== undefined) semantic.expectedRevision = command.expectedRevision;
  if (command.correlationId !== undefined) semantic.correlationId = command.correlationId;
  if (command.causationId !== undefined) semantic.causationId = command.causationId;
  return sha256Hex(canonicalJson(semantic));
}
