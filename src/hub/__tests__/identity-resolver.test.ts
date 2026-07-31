/**
 * SPEC-HUB-003 c2/c3/c5 — per-request identity resolution.
 *
 * The resolver is the whole of identity resolution: it consults the durable
 * agent record and, in hosted mode, the request's authenticated principal.
 * Nothing about the connection participates, so these tests never construct
 * a session at all.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  createIdentityResolver,
  AGENT_ID_REQUIRED_ERROR,
} from '../identity-resolver.js';
import { createInMemoryHubStorage } from './test-helpers.js';
import type { HubStorage } from '../hub-types.js';

const ISO = '2026-07-30T00:00:00.000Z';

async function seedAgent(
  storage: HubStorage,
  agentId: string,
  name: string,
  ownerPrincipal?: string,
): Promise<void> {
  await storage.saveAgent({
    agentId,
    name,
    role: 'contributor',
    registeredAt: ISO,
    ...(ownerPrincipal ? { ownerPrincipal } : {}),
  });
}

describe('identity resolver — explicit agentId (c2)', () => {
  let storage: HubStorage;

  beforeEach(() => {
    storage = createInMemoryHubStorage();
  });

  it('resolves an agentId that exists in storage, with no register call anywhere', async () => {
    await seedAgent(storage, 'agent-1', 'Durable');
    const resolver = createIdentityResolver({ storage });

    expect(await resolver.resolve('agent-1')).toBe('agent-1');
  });

  it('rejects an agentId with no durable record', async () => {
    const resolver = createIdentityResolver({ storage });

    await expect(resolver.resolve('nope')).rejects.toThrow(/Unknown agent/i);
  });

  it('resolves the same agentId identically on a second, independent resolver', async () => {
    await seedAgent(storage, 'agent-1', 'Durable');

    expect(await createIdentityResolver({ storage }).resolve('agent-1')).toBe('agent-1');
    expect(await createIdentityResolver({ storage }).resolve('agent-1')).toBe('agent-1');
  });
});

describe('identity resolver — ownership by mode (c3)', () => {
  let storage: HubStorage;

  beforeEach(() => {
    storage = createInMemoryHubStorage();
  });

  it('local mode: an explicit agentId resolves with no ownership check', async () => {
    await seedAgent(storage, 'agent-1', 'Owned Elsewhere', 'principal-A');
    const resolver = createIdentityResolver({ storage });

    expect(await resolver.resolve('agent-1', 'principal-B')).toBe('agent-1');
    expect(await resolver.resolve('agent-1')).toBe('agent-1');
  });

  it('hosted mode: same-principal act-as succeeds', async () => {
    await seedAgent(storage, 'agent-1', 'Mine', 'principal-A');
    const resolver = createIdentityResolver({ storage, hostedMode: true });

    expect(await resolver.resolve('agent-1', 'principal-A')).toBe('agent-1');
  });

  it('hosted mode: wrong-principal act-as is rejected', async () => {
    await seedAgent(storage, 'agent-1', 'Mine', 'principal-A');
    const resolver = createIdentityResolver({ storage, hostedMode: true });

    await expect(resolver.resolve('agent-1', 'principal-B')).rejects.toThrow(
      /owned by another principal/i,
    );
  });

  it('hosted mode: an unauthenticated request cannot act as an owned agent', async () => {
    await seedAgent(storage, 'agent-1', 'Mine', 'principal-A');
    const resolver = createIdentityResolver({ storage, hostedMode: true });

    await expect(resolver.resolve('agent-1')).rejects.toThrow(/owned by another principal/i);
  });

  it('hosted mode: a legacy record with no ownerPrincipal is adopted and stamped on first use', async () => {
    await seedAgent(storage, 'legacy-1', 'Legacy');
    const resolver = createIdentityResolver({ storage, hostedMode: true });

    expect(await resolver.resolve('legacy-1', 'principal-A')).toBe('legacy-1');
    expect((await storage.getAgent('legacy-1'))?.ownerPrincipal).toBe('principal-A');

    // Adoption is once: the second principal now fails the ownership check.
    await expect(resolver.resolve('legacy-1', 'principal-B')).rejects.toThrow(
      /owned by another principal/i,
    );
  });

  it('local mode never stamps a principal onto a record', async () => {
    await seedAgent(storage, 'agent-1', 'Local');
    const resolver = createIdentityResolver({ storage });

    await resolver.resolve('agent-1', 'principal-A');
    expect((await storage.getAgent('agent-1'))?.ownerPrincipal).toBeUndefined();
  });
});

describe('identity resolver — implicit identity from env only (c5)', () => {
  let storage: HubStorage;

  beforeEach(() => {
    storage = createInMemoryHubStorage();
  });

  it('with no explicit agentId and no env configuration, resolve fails with the instructive error', async () => {
    const resolver = createIdentityResolver({ storage });

    await expect(resolver.resolve()).rejects.toThrow(AGENT_ID_REQUIRED_ERROR);
    await expect(resolver.resolve()).rejects.toThrow(/register returns one/i);
  });

  it('resolveOptional returns null rather than throwing when nothing resolves', async () => {
    const resolver = createIdentityResolver({ storage });

    expect(await resolver.resolveOptional()).toBeNull();
  });

  it('THOUGHTBOX_AGENT_ID/NAME identity applies to every call uniformly', async () => {
    const resolver = createIdentityResolver({
      storage,
      envAgentId: '11111111-2222-3333-4444-555555555555',
      envAgentName: 'Env Agent',
    });

    const first = await resolver.resolve();
    const second = await resolver.resolve();
    expect(first).toBe('11111111-2222-3333-4444-555555555555');
    expect(second).toBe(first);
    expect(await storage.getAgents()).toHaveLength(1);
  });

  it('env resolution is memoized across concurrent calls — one agent, not one per call', async () => {
    const resolver = createIdentityResolver({ storage, envAgentName: 'Env By Name' });

    const ids = await Promise.all([
      resolver.resolve(),
      resolver.resolve(),
      resolver.resolve(),
    ]);

    expect(new Set(ids).size).toBe(1);
    expect(await storage.getAgents()).toHaveLength(1);
  });

  it('an explicit agentId always wins over env configuration', async () => {
    await seedAgent(storage, 'agent-explicit', 'Explicit');
    const resolver = createIdentityResolver({
      storage,
      envAgentId: '11111111-2222-3333-4444-555555555555',
      envAgentName: 'Env Agent',
    });

    expect(await resolver.resolve('agent-explicit')).toBe('agent-explicit');
  });
});
