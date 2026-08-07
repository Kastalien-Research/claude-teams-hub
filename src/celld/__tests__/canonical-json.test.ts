import { describe, it, expect } from 'vitest';
import { canonicalJson, sha256Hex, commandPayloadHash, type JsonValue } from '../canonical-json.js';

describe('canonicalJson', () => {
  it('is stable under different literal key orders on the same object', () => {
    const a: JsonValue = { b: 1, a: 2, c: { z: 1, y: 2 } };
    const b: JsonValue = { c: { y: 2, z: 1 }, a: 2, b: 1 };
    expect(canonicalJson(a)).toBe(canonicalJson(b));
  });

  it('sorts nested object keys recursively', () => {
    const value: JsonValue = { outer: { z: 1, a: { y: 2, x: 1 } } };
    expect(canonicalJson(value)).toBe('{"outer":{"a":{"x":1,"y":2},"z":1}}');
  });

  it('does NOT sort array elements', () => {
    const value: JsonValue = { list: [3, 1, 2] };
    expect(canonicalJson(value)).toBe('{"list":[3,1,2]}');
  });

  it('preserves array element order even for arrays of objects', () => {
    const value: JsonValue = { list: [{ b: 1, a: 2 }, { a: 1, b: 2 }] };
    expect(canonicalJson(value)).toBe('{"list":[{"a":2,"b":1},{"a":1,"b":2}]}');
  });

  it('round-trips unicode characters', () => {
    const value: JsonValue = { name: 'Café' };
    expect(canonicalJson(value)).toBe(JSON.stringify({ name: 'Café' }));
    expect(canonicalJson(value)).toContain('é');
  });

  it('distinguishes integers from floats', () => {
    expect(canonicalJson(1)).toBe('1');
    expect(canonicalJson(1.5)).toBe('1.5');
    expect(canonicalJson(1)).not.toBe(canonicalJson(1.5));
  });

  it('serializes null, booleans, and empty containers like JSON.stringify', () => {
    expect(canonicalJson(null)).toBe('null');
    expect(canonicalJson(true)).toBe('true');
    expect(canonicalJson(false)).toBe('false');
    expect(canonicalJson({})).toBe('{}');
    expect(canonicalJson([])).toBe('[]');
  });
});

describe('sha256Hex', () => {
  it('matches the known SHA-256 test vector for the empty string', async () => {
    expect(await sha256Hex('')).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    );
  });

  it('matches the known SHA-256 test vector for "abc"', async () => {
    expect(await sha256Hex('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });

  it('produces a 64-character lowercase hex string', async () => {
    const digest = await sha256Hex('anything');
    expect(digest).toHaveLength(64);
    expect(digest).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('commandPayloadHash', () => {
  // The parameter type structurally omits issuedAt/payloadHash, so extra
  // fields are carried on a typed variable (not an object literal) to prove
  // the function ignores them even when present on the wire envelope shape.
  interface WireLikeCommand {
    schemaVersion: string;
    commandId: string;
    operation: string;
    workspaceId: string;
    actor: { agentId: string; promptVersion?: string };
    issuedAt: string;
    expectedRevision?: number;
    context: { teamRunId?: string; nativeTaskId?: string; processRunId?: string };
    correlationId?: string;
    causationId?: string;
    payloadHash: string;
    payload: Record<string, JsonValue>;
  }

  function base(): WireLikeCommand {
    return {
      schemaVersion: 'hub-command-v1',
      commandId: 'cmd-1',
      operation: 'create_problem',
      workspaceId: 'ws-1',
      actor: { agentId: 'alice' },
      issuedAt: '2026-08-06T00:00:00.000Z',
      context: {},
      payloadHash: 'placeholder-not-used-by-the-function',
      payload: { title: 'T', description: 'D' },
    };
  }

  it('ignores issuedAt: two commands differing only in issuedAt hash identically', async () => {
    const a = base();
    const b = { ...base(), issuedAt: '2099-01-01T00:00:00.000Z' };
    expect(await commandPayloadHash(a)).toBe(await commandPayloadHash(b));
  });

  it('ignores payloadHash: two commands differing only in payloadHash hash identically', async () => {
    const a = base();
    const b = { ...base(), payloadHash: 'totally-different-value' };
    expect(await commandPayloadHash(a)).toBe(await commandPayloadHash(b));
  });

  it('ignores issuedAt and payloadHash together', async () => {
    const a = base();
    const b = { ...base(), issuedAt: '2099-01-01T00:00:00.000Z', payloadHash: 'x'.repeat(64) };
    expect(await commandPayloadHash(a)).toBe(await commandPayloadHash(b));
  });

  it('is sensitive to payload changes', async () => {
    const a = base();
    const b = { ...base(), payload: { ...a.payload, title: 'Different' } };
    expect(await commandPayloadHash(a)).not.toBe(await commandPayloadHash(b));
  });

  it('is sensitive to operation changes', async () => {
    const a = base();
    const b = { ...base(), operation: 'claim_problem' };
    expect(await commandPayloadHash(a)).not.toBe(await commandPayloadHash(b));
  });

  it('is sensitive to actor changes', async () => {
    const a = base();
    const b = { ...base(), actor: { agentId: 'bob' } };
    expect(await commandPayloadHash(a)).not.toBe(await commandPayloadHash(b));
  });

  it('is sensitive to expectedRevision changes', async () => {
    const a = { ...base(), expectedRevision: 1 };
    const b = { ...base(), expectedRevision: 2 };
    expect(await commandPayloadHash(a)).not.toBe(await commandPayloadHash(b));
  });

  it('joins expectedRevision into the hash only when present', async () => {
    const withoutField = base();
    const withField = { ...base(), expectedRevision: 0 };
    expect(await commandPayloadHash(withoutField)).not.toBe(await commandPayloadHash(withField));
  });

  it('joins correlationId into the hash only when present', async () => {
    const withoutField = base();
    const withField = { ...base(), correlationId: 'corr-1' };
    expect(await commandPayloadHash(withoutField)).not.toBe(await commandPayloadHash(withField));
  });

  it('joins causationId into the hash only when present', async () => {
    const withoutField = base();
    const withField = { ...base(), causationId: 'cause-1' };
    expect(await commandPayloadHash(withoutField)).not.toBe(await commandPayloadHash(withField));
  });

  it('is deterministic: identical semantic input hashes identically across calls', async () => {
    const a = base();
    const b = base();
    expect(await commandPayloadHash(a)).toBe(await commandPayloadHash(b));
  });
});
