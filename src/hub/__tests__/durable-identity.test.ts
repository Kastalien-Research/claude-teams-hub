/**
 * SPEC-HUB-003 c1/c2/c4/c5 — durable identity through the hub tool handler.
 *
 * Every case here goes through createHubToolHandler, the surface the MCP
 * tools call, because the claims are about what a REQUEST can do: act as an
 * agent it never registered in this connection (c2), keep coordinator power
 * across connections (c4), and resolve an agentId-less call from process
 * configuration alone (c5).
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { createHubToolHandler, type HubToolHandler } from '../hub-tool-handler.js';
import { createInMemoryHubStorage, createInMemoryThoughtStore } from './test-helpers.js';
import type { HubStorage } from '../hub-types.js';

const parse = (result: { content: Array<{ type: string; text?: string }> }): any =>
  JSON.parse((result.content[0] as { text: string }).text);

describe('register/quick_join persist ownerPrincipal (c1)', () => {
  let hubStorage: HubStorage;

  beforeEach(() => {
    hubStorage = createInMemoryHubStorage();
  });

  const handlerFor = (hostedMode: boolean): HubToolHandler =>
    createHubToolHandler({
      hubStorage,
      thoughtStore: createInMemoryThoughtStore(),
      hostedMode,
    });

  it('hosted mode: the persisted record carries the caller principal', async () => {
    const handler = handlerFor(true);

    const reg = parse(
      await handler.handle({ operation: 'register', name: 'Hosted' }, undefined, {
        principal: 'apikey-77',
      }),
    );

    expect((await hubStorage.getAgent(reg.agentId))?.ownerPrincipal).toBe('apikey-77');
  });

  it('hosted mode: quick_join stamps the principal on the agent it mints', async () => {
    const handler = handlerFor(true);
    const coord = parse(
      await handler.handle({ operation: 'register', name: 'Coord' }, undefined, {
        principal: 'apikey-77',
      }),
    );
    const ws = parse(
      await handler.handle(
        { operation: 'create_workspace', agentId: coord.agentId, name: 'WS', description: 'd' },
        undefined,
        { principal: 'apikey-77' },
      ),
    );

    const joined = parse(
      await handler.handle(
        { operation: 'quick_join', name: 'Joiner', workspaceId: ws.workspaceId },
        undefined,
        { principal: 'apikey-99' },
      ),
    );

    expect((await hubStorage.getAgent(joined.agentId))?.ownerPrincipal).toBe('apikey-99');
  });

  it('local mode: the field is absent even when a principal is supplied', async () => {
    const handler = handlerFor(false);

    const reg = parse(
      await handler.handle({ operation: 'register', name: 'Local' }, undefined, {
        principal: 'apikey-77',
      }),
    );

    const stored = await hubStorage.getAgent(reg.agentId);
    expect(stored?.ownerPrincipal).toBeUndefined();
    expect(Object.hasOwn(stored as object, 'ownerPrincipal')).toBe(false);
  });
});

describe('resolution consults storage, never session state (c2)', () => {
  let hubStorage: HubStorage;

  beforeEach(() => {
    hubStorage = createInMemoryHubStorage();
  });

  const newHandler = (): HubToolHandler =>
    createHubToolHandler({ hubStorage, thoughtStore: createInMemoryThoughtStore() });

  it('an agentId registered on one handler is usable on a brand-new handler', async () => {
    const first = newHandler();
    const reg = parse(await first.handle({ operation: 'register', name: 'Alpha' }, 'sess-1'));

    const second = newHandler();
    const who = parse(
      await second.handle({ operation: 'whoami', agentId: reg.agentId }, 'sess-2'),
    );

    expect(who.agentId).toBe(reg.agentId);
    expect(who.name).toBe('Alpha');
  });

  it('an agent that exists only in storage resolves without any register call', async () => {
    await hubStorage.saveAgent({
      agentId: 'seeded-1',
      name: 'Seeded',
      role: 'contributor',
      registeredAt: new Date().toISOString(),
    });

    const result = await newHandler().handle({ operation: 'whoami', agentId: 'seeded-1' });

    expect(result.isError ?? false).toBe(false);
    expect(parse(result).name).toBe('Seeded');
  });

  it('an unknown agentId is rejected as unknown, not as unregistered-in-session', async () => {
    const result = await newHandler().handle({ operation: 'whoami', agentId: 'ghost' });

    expect(result.isError).toBe(true);
    expect(parse(result).error).toMatch(/Unknown agent/i);
    expect(parse(result).error).not.toMatch(/in this session/i);
  });

  it('src/hub/session-identity.ts is deleted and nothing imports it', () => {
    const src = join(import.meta.dirname, '..', '..');
    expect(existsSync(join(src, 'hub', 'session-identity.ts'))).toBe(false);

    const files: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, entry.name);
        if (entry.isDirectory()) walk(p);
        else if (entry.name.endsWith('.ts')) files.push(p);
      }
    };
    walk(src);

    // Imports and type references only — the prose in identity-resolver.ts
    // deliberately names what it replaced, and this file names it too.
    const offenders = files.filter((f) =>
      /from\s+['"][^'"]*session-identity(\.js)?['"]|\bnew\s+SessionIdentityRegistry\b/.test(
        readFileSync(f, 'utf8'),
      ),
    );
    expect(offenders.map((f) => f.slice(src.length + 1))).toEqual([]);
  });
});

describe('coordinator power survives reconnection (c4)', () => {
  let hubStorage: HubStorage;

  const newHandler = (hostedMode = false): HubToolHandler =>
    createHubToolHandler({
      hubStorage,
      thoughtStore,
      hostedMode,
    });

  // One process-shared thought store, as server-factory wires: the merge
  // thought lands on the workspace's main session regardless of which
  // handler instance performs the merge.
  let thoughtStore: ReturnType<typeof createInMemoryThoughtStore>;

  beforeEach(() => {
    hubStorage = createInMemoryHubStorage();
    thoughtStore = createInMemoryThoughtStore();
  });

  async function setUpApprovedProposal(
    handler: HubToolHandler,
    principal?: string,
  ): Promise<{ coordId: string; workspaceId: string; proposalId: string }> {
    const request = principal ? { principal } : undefined;
    const coord = parse(
      await handler.handle({ operation: 'register', name: 'Coordinator' }, 'sess-1', request),
    );
    const ws = parse(
      await handler.handle(
        {
          operation: 'create_workspace',
          agentId: coord.agentId,
          name: 'WS',
          description: 'coordinator continuity',
        },
        'sess-1',
        request,
      ),
    );
    const contributor = parse(
      await handler.handle({ operation: 'register', name: 'Contributor' }, 'sess-2', request),
    );
    await handler.handle(
      {
        operation: 'join_workspace',
        agentId: contributor.agentId,
        workspaceId: ws.workspaceId,
      },
      'sess-2',
      request,
    );
    const proposal = parse(
      await handler.handle(
        {
          operation: 'create_proposal',
          agentId: contributor.agentId,
          workspaceId: ws.workspaceId,
          title: 'P',
          description: 'd',
          sourceBranch: 'contributor/p',
        },
        'sess-2',
        request,
      ),
    );
    await handler.handle(
      {
        operation: 'review_proposal',
        agentId: coord.agentId,
        workspaceId: ws.workspaceId,
        proposalId: proposal.proposalId,
        verdict: 'approve',
        reasoning: 'looks right',
      },
      'sess-1',
      request,
    );

    return {
      coordId: coord.agentId,
      workspaceId: ws.workspaceId,
      proposalId: proposal.proposalId,
    };
  }

  it('local mode: merge_proposal succeeds from a second handler with a different session id', async () => {
    const { coordId, workspaceId, proposalId } = await setUpApprovedProposal(newHandler());

    const reconnected = newHandler();
    const merged = await reconnected.handle(
      {
        operation: 'merge_proposal',
        agentId: coordId,
        workspaceId,
        proposalId,
        mergeMessage: 'merged after reconnect',
      },
      'sess-brand-new',
    );

    expect(merged.isError ?? false).toBe(false);
    expect(parse(merged).proposal.status).toBe('merged');
  });

  it('local mode: merge_proposal succeeds from a handler with NO session id at all', async () => {
    const { coordId, workspaceId, proposalId } = await setUpApprovedProposal(newHandler());

    const merged = await newHandler().handle({
      operation: 'merge_proposal',
      agentId: coordId,
      workspaceId,
      proposalId,
      mergeMessage: 'merged sessionless',
    });

    expect(merged.isError ?? false).toBe(false);
    expect(parse(merged).proposal.status).toBe('merged');
  });

  it('hosted mode: merge_proposal succeeds from a fresh connection under the same principal', async () => {
    const hosted = newHandler(true);
    const { coordId, workspaceId, proposalId } = await setUpApprovedProposal(hosted, 'apikey-77');

    const merged = await newHandler(true).handle(
      {
        operation: 'merge_proposal',
        agentId: coordId,
        workspaceId,
        proposalId,
        mergeMessage: 'merged after reconnect',
      },
      'sess-brand-new',
      { principal: 'apikey-77' },
    );

    expect(merged.isError ?? false).toBe(false);
    expect(parse(merged).proposal.status).toBe('merged');
  });

  it('hosted mode: a different principal cannot act as the coordinator', async () => {
    const hosted = newHandler(true);
    const { coordId, workspaceId, proposalId } = await setUpApprovedProposal(hosted, 'apikey-77');

    const merged = await newHandler(true).handle(
      {
        operation: 'merge_proposal',
        agentId: coordId,
        workspaceId,
        proposalId,
        mergeMessage: 'stolen merge',
      },
      'sess-brand-new',
      { principal: 'apikey-99' },
    );

    expect(merged.isError).toBe(true);
    expect(parse(merged).error).toMatch(/owned by another principal/i);
  });
});

describe('implicit identity comes only from env configuration (c5)', () => {
  let hubStorage: HubStorage;

  beforeEach(() => {
    hubStorage = createInMemoryHubStorage();
  });

  it('env identity applies on a session that never called register', async () => {
    const handler = createHubToolHandler({
      hubStorage,
      thoughtStore: createInMemoryThoughtStore(),
      envAgentId: '11111111-2222-3333-4444-555555555555',
      envAgentName: 'Env Agent',
    });

    const first = await handler.handle(
      { operation: 'create_workspace', name: 'WS-A', description: 'a' },
      'sess-env-a',
    );
    const second = await handler.handle(
      { operation: 'create_workspace', name: 'WS-B', description: 'b' },
      'sess-env-b',
    );
    expect(first.isError ?? false).toBe(false);
    expect(second.isError ?? false).toBe(false);

    const whoB = parse(await handler.handle({ operation: 'whoami' }, 'sess-env-b'));
    expect(whoB.agentId).toBe('11111111-2222-3333-4444-555555555555');
    expect(await hubStorage.getAgents()).toHaveLength(1);
  });

  it('with no env config, an agentId-less mutation returns the instructive error', async () => {
    const handler = createHubToolHandler({
      hubStorage,
      thoughtStore: createInMemoryThoughtStore(),
    });

    const result = await handler.handle({
      operation: 'create_workspace',
      name: 'WS',
      description: 'd',
    });

    expect(result.isError).toBe(true);
    expect(parse(result).error).toMatch(/require an explicit agentId/i);
    expect(parse(result).error).toMatch(/register returns one/i);
  });

  it('register no longer changes resolution of later agentId-less calls in the same session', async () => {
    const handler = createHubToolHandler({
      hubStorage,
      thoughtStore: createInMemoryThoughtStore(),
    });

    const reg = parse(await handler.handle({ operation: 'register', name: 'Alpha' }, 'sess-1'));
    expect(reg.agentId).toBeDefined();

    const implicit = await handler.handle({ operation: 'whoami' }, 'sess-1');
    expect(implicit.isError).toBe(true);
    expect(parse(implicit).error).toMatch(/require an explicit agentId/i);
  });

  it('a second register on one connection does not orphan the first agent', async () => {
    const handler = createHubToolHandler({
      hubStorage,
      thoughtStore: createInMemoryThoughtStore(),
    });

    const a = parse(await handler.handle({ operation: 'register', name: 'A' }, 'sess-1'));
    const b = parse(await handler.handle({ operation: 'register', name: 'B' }, 'sess-1'));

    for (const id of [a.agentId, b.agentId]) {
      const who = await handler.handle({ operation: 'whoami', agentId: id }, 'sess-1');
      expect(who.isError ?? false).toBe(false);
    }
  });

  it('register and quick_join responses tell the caller to record and reuse the agentId', async () => {
    const handler = createHubToolHandler({
      hubStorage,
      thoughtStore: createInMemoryThoughtStore(),
    });

    const reg = parse(await handler.handle({ operation: 'register', name: 'Alpha' }));
    expect(reg.guidance).toMatch(/agentId/);
    expect(reg.guidance).toMatch(/reuse/i);

    const ws = parse(
      await handler.handle({
        operation: 'create_workspace',
        agentId: reg.agentId,
        name: 'WS',
        description: 'd',
      }),
    );
    const joined = parse(
      await handler.handle({
        operation: 'quick_join',
        name: 'Beta',
        workspaceId: ws.workspaceId,
      }),
    );
    expect(joined.guidance).toMatch(/agentId/);
    expect(joined.guidance).toMatch(/reuse/i);
  });
});
