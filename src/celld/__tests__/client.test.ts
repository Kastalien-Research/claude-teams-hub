/**
 * celld HTTP client (RFC 0001 §Cell command semantics, §Client retry
 * policy). No network — `fetchImpl` is injected and every response is a
 * scripted `Response` object.
 */

import { describe, it, expect, vi } from 'vitest';
import { createCelldClient } from '../client.js';
import { CelldError } from '../errors.js';
import type { HubCommandV1, HubEventV1 } from '../contracts.js';

const ENDPOINT_A = 'http://celld-a.test';
const ENDPOINT_B = 'http://celld-b.test';

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function textResponse(status: number, text: string): Response {
  return new Response(text, { status });
}

function buildCommand(overrides: Partial<HubCommandV1> = {}): HubCommandV1 {
  return {
    schemaVersion: 'hub-command-v1',
    commandId: 'cmd-1',
    operation: 'create_problem',
    workspaceId: 'ws-1',
    actor: { agentId: 'agent-a' },
    issuedAt: '2026-08-06T00:00:00.000Z',
    context: {},
    payloadHash: 'a'.repeat(64),
    payload: { title: 't' },
    ...overrides,
  };
}

function validEvent(overrides: Partial<HubEventV1> = {}): HubEventV1 {
  return {
    schemaVersion: 'hub-event-v1',
    eventId: 'ws-1:1',
    workspaceId: 'ws-1',
    sequence: 1,
    aggregateRevision: 1,
    type: 'problem_created',
    commandId: 'cmd-1',
    actor: { agentId: 'agent-a' },
    occurredAt: '2026-08-06T00:00:00.000Z',
    data: {},
    ...overrides,
  };
}

describe('createCelldClient — endpoint failover', () => {
  it('fails over to the next endpoint on a transport failure, in order', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockRejectedValueOnce(new TypeError('fetch failed: ECONNREFUSED'))
      .mockResolvedValueOnce(
        jsonResponse(200, { outcome: 'accepted', replayed: false, revision: 1, result: {} }),
      );

    const client = createCelldClient({ endpoints: [ENDPOINT_A, ENDPOINT_B], timeoutMs: 1000, fetchImpl });
    const result = await client.command('ws-1', buildCommand());

    expect(result).toEqual({ outcome: 'accepted', replayed: false, revision: 1, result: {} });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(fetchImpl.mock.calls[0]?.[0]).toContain(ENDPOINT_A);
    expect(fetchImpl.mock.calls[1]?.[0]).toContain(ENDPOINT_B);
  });

  it('reuses the byte-identical envelope across a failover retry', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockResolvedValueOnce(
        jsonResponse(200, { outcome: 'accepted', replayed: false, revision: 1, result: {} }),
      );

    const client = createCelldClient({ endpoints: [ENDPOINT_A, ENDPOINT_B], timeoutMs: 1000, fetchImpl });
    await client.command('ws-1', buildCommand());

    const firstInit = fetchImpl.mock.calls[0]?.[1] as RequestInit;
    const secondInit = fetchImpl.mock.calls[1]?.[1] as RequestInit;
    expect(secondInit.body).toBe(firstInit.body);
  });

  it('does NOT fail over after a parsed 200-with-domain-rejection', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        jsonResponse(200, {
          outcome: 'rejected',
          replayed: false,
          revision: 2,
          rejection: { code: 'ALREADY_WORKSPACE_MEMBER', message: 'already a member', retryable: false },
        }),
      );

    const client = createCelldClient({ endpoints: [ENDPOINT_A, ENDPOINT_B], timeoutMs: 1000, fetchImpl });
    const result = await client.command('ws-1', buildCommand());

    expect(result.outcome).toBe('rejected');
    expect(result.rejection?.code).toBe('ALREADY_WORKSPACE_MEMBER');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('does NOT retry or fail over after a parsed 400', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse(400, { outcome: 'rejected', rejection: { code: 'VALIDATION_FAILED' } }));

    const client = createCelldClient({ endpoints: [ENDPOINT_A, ENDPOINT_B], timeoutMs: 1000, fetchImpl });

    await expect(client.command('ws-1', buildCommand())).rejects.toThrow(/responded 400/);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('does NOT retry or fail over after a parsed 500 with a JSON body', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValueOnce(jsonResponse(500, { error: 'internal error' }));

    const client = createCelldClient({ endpoints: [ENDPOINT_A, ENDPOINT_B], timeoutMs: 1000, fetchImpl });

    await expect(client.command('ws-1', buildCommand())).rejects.toThrow(/responded 500/);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('does NOT retry or fail over after a non-JSON body (definitive, not CELLD_UNAVAILABLE)', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValueOnce(textResponse(500, 'internal error'));

    const client = createCelldClient({ endpoints: [ENDPOINT_A, ENDPOINT_B], timeoutMs: 1000, fetchImpl });

    const err = await client.command('ws-1', buildCommand()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(CelldError);
    expect((err as Error).message).toMatch(/non-JSON/);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('throws CELLD_UNAVAILABLE (retryable) after exhausting every endpoint', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockRejectedValueOnce(new TypeError('ECONNREFUSED'))
      .mockRejectedValueOnce(new TypeError('ECONNREFUSED'));

    const client = createCelldClient({ endpoints: [ENDPOINT_A, ENDPOINT_B], timeoutMs: 1000, fetchImpl });

    const err = await client.command('ws-1', buildCommand()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CelldError);
    expect((err as CelldError).code).toBe('CELLD_UNAVAILABLE');
    expect((err as CelldError).retryable).toBe(true);
    expect((err as CelldError).message).toContain('2');
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('a timeout (AbortSignal) on every endpoint fails over then exhausts to CELLD_UNAVAILABLE', async () => {
    const timeoutError = new DOMException('The operation was aborted due to timeout', 'TimeoutError');
    const fetchImpl = vi.fn<typeof fetch>().mockRejectedValue(timeoutError);

    const client = createCelldClient({ endpoints: [ENDPOINT_A, ENDPOINT_B], timeoutMs: 50, fetchImpl });

    const err = await client.command('ws-1', buildCommand()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CelldError);
    expect((err as CelldError).code).toBe('CELLD_UNAVAILABLE');
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    // Each attempt is given an AbortSignal derived from timeoutMs.
    for (const call of fetchImpl.mock.calls) {
      const init = call[1] as RequestInit;
      expect(init.signal).toBeInstanceOf(AbortSignal);
    }
  });

  it('maps a protocol-mismatch rejection to CelldError CELLD_PROTOCOL_MISMATCH without failing over', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValueOnce(
      jsonResponse(409, {
        outcome: 'rejected',
        replayed: false,
        revision: 0,
        rejection: { code: 'CELLD_PROTOCOL_MISMATCH', message: 'schemaVersion mismatch', retryable: false },
      }),
    );

    const client = createCelldClient({ endpoints: [ENDPOINT_A, ENDPOINT_B], timeoutMs: 1000, fetchImpl });

    const err = await client.command('ws-1', buildCommand()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CelldError);
    expect((err as CelldError).code).toBe('CELLD_PROTOCOL_MISMATCH');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});

describe('createCelldClient — query/snapshot/events/health', () => {
  it('query() posts operation/actorId/payload and returns the parsed CellCommandResult', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse(200, { outcome: 'accepted', replayed: true, revision: 3, result: { ok: true } }));

    const client = createCelldClient({ endpoints: [ENDPOINT_A], timeoutMs: 1000, fetchImpl });
    const result = await client.query('ws-1', 'list_problems', 'agent-a', { foo: 'bar' });

    expect(result).toEqual({ outcome: 'accepted', replayed: true, revision: 3, result: { ok: true } });
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(String(url)).toBe(`${ENDPOINT_A}/v1/workspaces/ws-1/queries`);
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({
      operation: 'list_problems',
      actorId: 'agent-a',
      payload: { foo: 'bar' },
    });
  });

  it('snapshot() GETs and returns the parsed CellSnapshot', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse(200, { workspaceId: 'ws-1', revision: 3, maxSequence: 3, state: { a: 1 } }));

    const client = createCelldClient({ endpoints: [ENDPOINT_A], timeoutMs: 1000, fetchImpl });
    const snapshot = await client.snapshot('ws-1');

    expect(snapshot).toEqual({ workspaceId: 'ws-1', revision: 3, maxSequence: 3, state: { a: 1 } });
    expect(fetchImpl.mock.calls[0]?.[0]).toBe(`${ENDPOINT_A}/v1/workspaces/ws-1/snapshot`);
  });

  it('events() validates each event against hubEventV1Schema and returns them', async () => {
    const event = validEvent();
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValueOnce(jsonResponse(200, { events: [event], count: 1 }));

    const client = createCelldClient({ endpoints: [ENDPOINT_A], timeoutMs: 1000, fetchImpl });
    const page = await client.events('ws-1', 0, 10);

    expect(page).toEqual({ events: [event], count: 1 });
    expect(fetchImpl.mock.calls[0]?.[0]).toBe(`${ENDPOINT_A}/v1/workspaces/ws-1/events?after=0&limit=10`);
  });

  it('events() throws CELLD_PROTOCOL_MISMATCH naming the sequence when an event fails schema validation', async () => {
    const badEvent = { ...validEvent(), sequence: 7, type: undefined };
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValueOnce(jsonResponse(200, { events: [badEvent], count: 1 }));

    const client = createCelldClient({ endpoints: [ENDPOINT_A], timeoutMs: 1000, fetchImpl });

    const err = await client.events('ws-1', 0, 10).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CelldError);
    expect((err as CelldError).code).toBe('CELLD_PROTOCOL_MISMATCH');
    expect((err as CelldError).message).toContain('7');
  });

  it('health() returns true on a 200 "ok" body', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValueOnce(textResponse(200, 'ok'));
    const client = createCelldClient({ endpoints: [ENDPOINT_A], timeoutMs: 1000, fetchImpl });
    expect(await client.health()).toBe(true);
  });

  it('health() returns false (never throws) when every endpoint is transport-unreachable', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockRejectedValue(new TypeError('ECONNREFUSED'));
    const client = createCelldClient({ endpoints: [ENDPOINT_A, ENDPOINT_B], timeoutMs: 1000, fetchImpl });
    expect(await client.health()).toBe(false);
  });
});
