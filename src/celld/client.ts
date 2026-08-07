/**
 * Node-side celld HTTP client (RFC 0001 §Cell command semantics, §Client
 * retry policy).
 *
 * Endpoint failover happens only on TRANSPORT failure (fetch rejection —
 * ECONNREFUSED, DNS, or an AbortSignal.timeout abort). Once a response is
 * successfully read from an endpoint, that response is DEFINITIVE: this
 * module never fails over or retries after receiving parsed bytes back,
 * because a response — success, domain rejection, or a 4xx/5xx — means the
 * request was not lost, so re-sending it or trying another node could
 * duplicate or race an already-observed effect. Probed: a non-owner node
 * transparently proxies to the owner with consistent results, so failover
 * across `HUB_CELLD_ENDPOINTS` is itself safe when it does happen.
 */

import { CelldError, rejection } from './errors.js';
import type { CelldRejection } from './errors.js';
import { hubEventV1Schema } from './contracts.js';
import type { CellCommandResult, HubCommandV1, HubEventV1 } from './contracts.js';
import type { JsonValue } from './canonical-json.js';

export interface CellSnapshot {
  workspaceId: string;
  revision: number;
  maxSequence: number;
  state: unknown;
}

export interface CellEventsPage {
  events: HubEventV1[];
  count: number;
}

export interface CellTransport {
  command(
    workspaceId: string,
    command: HubCommandV1,
  ): Promise<CellCommandResult & { events?: unknown[] }>;
  query(
    workspaceId: string,
    operation: string,
    actorId: string,
    payload: Record<string, JsonValue>,
  ): Promise<CellCommandResult>;
  snapshot(workspaceId: string): Promise<CellSnapshot>;
  events(workspaceId: string, after: number, limit: number): Promise<CellEventsPage>;
  health(): Promise<boolean>;
}

export interface CelldClientOptions {
  endpoints: string[];
  timeoutMs: number;
  fetchImpl?: typeof fetch;
}

// =============================================================================
// Transport-level failover
// =============================================================================

interface RawResponse {
  status: number;
  text: string;
  endpoint: string;
}

/**
 * One fetch attempt against one endpoint. Anything thrown here — a rejected
 * fetch() call, or a failure reading the response body — is a transport
 * failure the caller should fail over on; everything after a clean read is
 * handled by the endpoint-loop's `onResponse` callback, which is never
 * caught, so a throw from there propagates straight out (no failover).
 */
async function fetchOnce(
  fetchImpl: typeof fetch,
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<{ status: number; text: string }> {
  const response = await fetchImpl(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  const text = await response.text();
  return { status: response.status, text };
}

/**
 * Tries `endpoints` in order. A transport failure moves to the next
 * endpoint; a parsed response is handed to `onResponse` and whatever it
 * returns or throws is definitive — the loop does not catch it. Exhausting
 * every endpoint on transport failures throws CELLD_UNAVAILABLE (retryable).
 */
async function attemptOverEndpoints<T>(
  endpoints: string[],
  timeoutMs: number,
  fetchImpl: typeof fetch,
  buildUrl: (endpoint: string) => string,
  init: RequestInit,
  onResponse: (raw: RawResponse) => T,
): Promise<T> {
  if (endpoints.length === 0) {
    throw new CelldError(
      rejection('CELLD_UNAVAILABLE', 'no celld endpoints configured', { endpointCount: 0 }),
    );
  }

  let lastError = 'unknown error';
  for (const endpoint of endpoints) {
    let raw: { status: number; text: string };
    try {
      raw = await fetchOnce(fetchImpl, buildUrl(endpoint), init, timeoutMs);
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
      continue;
    }
    return onResponse({ ...raw, endpoint });
  }

  throw new CelldError(
    rejection('CELLD_UNAVAILABLE', `All ${endpoints.length} celld endpoint(s) unreachable`, {
      endpointCount: endpoints.length,
      lastError,
    }),
  );
}

// =============================================================================
// Response parsing shared by command()/query()/snapshot()
// =============================================================================

function parseJsonOrThrow(raw: RawResponse): unknown {
  try {
    return JSON.parse(raw.text);
  } catch {
    throw new Error(
      `celld ${raw.endpoint} returned non-JSON response (status ${raw.status}): ${raw.text.slice(0, 200)}`,
    );
  }
}

/**
 * A protocol-mismatch rejection can arrive on any status the RFC's wire
 * contract puts it on (probed: 409), so this checks the parsed body's shape
 * directly rather than trusting a specific status code.
 */
function throwIfProtocolMismatch(parsed: unknown): void {
  if (parsed === null || typeof parsed !== 'object') return;
  const rej = (parsed as { rejection?: unknown }).rejection;
  if (rej !== null && typeof rej === 'object' && (rej as { code?: unknown }).code === 'CELLD_PROTOCOL_MISMATCH') {
    throw new CelldError(rej as CelldRejection);
  }
}

/**
 * Only a 200 is a "here is the command/query result" response — that result
 * is data even when it carries a domain rejection (RFC 0001: rejections
 * persist as receipts without throwing). Any other status that isn't a
 * protocol mismatch means the node responded but didn't process the
 * request, which is a plain (non-CelldError) failure — the node is there,
 * it just refused this envelope.
 */
function parseCellCommandResponse(raw: RawResponse): CellCommandResult & { events?: unknown[] } {
  const parsed = parseJsonOrThrow(raw);
  throwIfProtocolMismatch(parsed);
  if (raw.status === 200) {
    return parsed as CellCommandResult & { events?: unknown[] };
  }
  throw new Error(`celld ${raw.endpoint} responded ${raw.status}: ${raw.text.slice(0, 200)}`);
}

// =============================================================================
// Client
// =============================================================================

export function createCelldClient(options: CelldClientOptions): CellTransport {
  const endpoints = options.endpoints;
  const timeoutMs = options.timeoutMs;
  const fetchImpl = options.fetchImpl ?? fetch;

  async function command(
    workspaceId: string,
    cmd: HubCommandV1,
  ): Promise<CellCommandResult & { events?: unknown[] }> {
    // Serialized once, outside the endpoint loop, so a retry after a
    // transport failure reuses the byte-identical envelope — never a
    // re-serialization that could reorder object keys differently.
    const body = JSON.stringify(cmd);
    return attemptOverEndpoints(
      endpoints,
      timeoutMs,
      fetchImpl,
      endpoint => `${endpoint}/v1/workspaces/${encodeURIComponent(workspaceId)}/commands`,
      { method: 'POST', headers: { 'content-type': 'application/json' }, body },
      parseCellCommandResponse,
    );
  }

  async function query(
    workspaceId: string,
    operation: string,
    actorId: string,
    payload: Record<string, JsonValue>,
  ): Promise<CellCommandResult> {
    const body = JSON.stringify({ operation, actorId, payload });
    return attemptOverEndpoints(
      endpoints,
      timeoutMs,
      fetchImpl,
      endpoint => `${endpoint}/v1/workspaces/${encodeURIComponent(workspaceId)}/queries`,
      { method: 'POST', headers: { 'content-type': 'application/json' }, body },
      parseCellCommandResponse,
    );
  }

  async function snapshot(workspaceId: string): Promise<CellSnapshot> {
    return attemptOverEndpoints(
      endpoints,
      timeoutMs,
      fetchImpl,
      endpoint => `${endpoint}/v1/workspaces/${encodeURIComponent(workspaceId)}/snapshot`,
      { method: 'GET' },
      raw => {
        const parsed = parseJsonOrThrow(raw);
        throwIfProtocolMismatch(parsed);
        if (raw.status === 200) return parsed as CellSnapshot;
        throw new Error(`celld ${raw.endpoint} responded ${raw.status}: ${raw.text.slice(0, 200)}`);
      },
    );
  }

  async function events(workspaceId: string, after: number, limit: number): Promise<CellEventsPage> {
    return attemptOverEndpoints(
      endpoints,
      timeoutMs,
      fetchImpl,
      endpoint =>
        `${endpoint}/v1/workspaces/${encodeURIComponent(workspaceId)}/events?after=${after}&limit=${limit}`,
      { method: 'GET' },
      raw => {
        const parsed = parseJsonOrThrow(raw);
        throwIfProtocolMismatch(parsed);
        if (raw.status !== 200) {
          throw new Error(`celld ${raw.endpoint} responded ${raw.status}: ${raw.text.slice(0, 200)}`);
        }
        const body = parsed as { events?: unknown[]; count?: number };
        const rawEvents = Array.isArray(body.events) ? body.events : [];
        const validated = rawEvents.map((ev, index) => {
          const result = hubEventV1Schema.safeParse(ev);
          if (!result.success) {
            const sequence =
              ev !== null && typeof ev === 'object' && 'sequence' in ev
                ? String((ev as { sequence: unknown }).sequence)
                : `index ${index}`;
            throw new CelldError(
              rejection(
                'CELLD_PROTOCOL_MISMATCH',
                `celld event at sequence ${sequence} failed schema validation: ${result.error.message}`,
                { sequence },
              ),
            );
          }
          return result.data;
        });
        return { events: validated, count: typeof body.count === 'number' ? body.count : validated.length };
      },
    );
  }

  /**
   * Boolean health probe, never throws: transport exhaustion across every
   * endpoint and a non-200/non-"ok" response both read as unhealthy rather
   * than propagating CELLD_UNAVAILABLE, matching the boolean-only signature
   * callers poll against.
   */
  async function health(): Promise<boolean> {
    try {
      return await attemptOverEndpoints(
        endpoints,
        timeoutMs,
        fetchImpl,
        endpoint => `${endpoint}/health`,
        { method: 'GET' },
        raw => raw.status === 200 && raw.text.trim().toLowerCase() === 'ok',
      );
    } catch {
      return false;
    }
  }

  return { command, query, snapshot, events, health };
}
