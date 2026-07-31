/**
 * SPEC-HUB-003 c6 — transfer_coordinator.
 *
 * Coordinatorship is durable state on the workspace, so it can be handed
 * over deliberately. Local mode: only the current coordinator may hand it to
 * another registered member. Hosted mode adds the recovery path the spec
 * exists for — the principal that owns the workspace-creating agent can take
 * coordinatorship onto an agent it owns even when the original coordinator
 * agentId is gone. Credential rotation without a prior transfer stays
 * unrecoverable in v1, by design.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { createHubToolHandler, type HubToolHandler } from '../hub-tool-handler.js';
import { createInMemoryHubStorage, createInMemoryThoughtStore } from './test-helpers.js';
import { HUB_OPERATIONS } from '../operations.js';
import { HUB_SDK_METHODS } from '../../code-mode/hub-sdk-methods.js';
import { STAGE_OPERATIONS } from '../hub-types.js';
import type { HubStorage } from '../hub-types.js';

const parse = (result: { content: Array<{ type: string; text?: string }> }): any =>
  JSON.parse((result.content[0] as { text: string }).text);

describe('transfer_coordinator is a published hub operation (c6)', () => {
  // Stage 1, not 2: the operation needs a durable agent record and a
  // workspaceId, but NOT membership — the hosted recovery path is performed
  // by a non-member. Authorization is the workspace manager's job, not the
  // stage gate's.
  it('appears in the catalog, the stage map, and the SDK method map', () => {
    expect(HUB_OPERATIONS.map((op) => op.name)).toContain('transfer_coordinator');
    expect(STAGE_OPERATIONS[1]).toContain('transfer_coordinator');
    expect(HUB_OPERATIONS.find((op) => op.name === 'transfer_coordinator')!.stage).toBe(1);
    expect(HUB_SDK_METHODS['transferCoordinator']).toBe('transfer_coordinator');
  });

  it('declares workspaceId and toAgentId as required inputs', () => {
    const op = HUB_OPERATIONS.find((o) => o.name === 'transfer_coordinator')!;
    expect(op.inputSchema.required).toEqual(['workspaceId', 'toAgentId']);
  });
});

describe('transfer_coordinator — local mode', () => {
  let hubStorage: HubStorage;
  let thoughtStore: ReturnType<typeof createInMemoryThoughtStore>;
  let handler: HubToolHandler;
  let coordId: string;
  let memberId: string;
  let outsiderId: string;
  let workspaceId: string;
  let proposalId: string;

  beforeEach(async () => {
    hubStorage = createInMemoryHubStorage();
    thoughtStore = createInMemoryThoughtStore();
    handler = createHubToolHandler({ hubStorage, thoughtStore });

    coordId = parse(await handler.handle({ operation: 'register', name: 'Coordinator' })).agentId;
    memberId = parse(await handler.handle({ operation: 'register', name: 'Member' })).agentId;
    outsiderId = parse(await handler.handle({ operation: 'register', name: 'Outsider' })).agentId;

    workspaceId = parse(
      await handler.handle({
        operation: 'create_workspace',
        agentId: coordId,
        name: 'WS',
        description: 'transfer tests',
      }),
    ).workspaceId;

    await handler.handle({
      operation: 'join_workspace',
      agentId: memberId,
      workspaceId,
    });

    proposalId = parse(
      await handler.handle({
        operation: 'create_proposal',
        agentId: memberId,
        workspaceId,
        title: 'P',
        description: 'd',
        sourceBranch: 'member/p',
      }),
    ).proposalId;

    await handler.handle({
      operation: 'review_proposal',
      agentId: coordId,
      workspaceId,
      proposalId,
      verdict: 'approve',
      reasoning: 'fine',
    });
  });

  const merge = (agentId: string) =>
    handler.handle({
      operation: 'merge_proposal',
      agentId,
      workspaceId,
      proposalId,
      mergeMessage: 'merge',
    });

  it('the current coordinator transfers to another registered member', async () => {
    const result = await handler.handle({
      operation: 'transfer_coordinator',
      agentId: coordId,
      workspaceId,
      toAgentId: memberId,
    });

    expect(result.isError ?? false).toBe(false);
    const data = parse(result);
    expect(data.workspaceId).toBe(workspaceId);
    expect(data.coordinator).toBe(memberId);
    expect(data.previousCoordinator).toBe(coordId);

    const ws = await hubStorage.getWorkspace(workspaceId);
    expect(ws!.agents.find((a) => a.agentId === memberId)!.role).toBe('coordinator');
    expect(ws!.agents.find((a) => a.agentId === coordId)!.role).toBe('contributor');
  });

  it('the old coordinator loses merge_proposal and the new one gains it', async () => {
    await handler.handle({
      operation: 'transfer_coordinator',
      agentId: coordId,
      workspaceId,
      toAgentId: memberId,
    });

    const byOld = await merge(coordId);
    expect(byOld.isError).toBe(true);
    expect(parse(byOld).error).toMatch(/coordinator/i);

    const byNew = await merge(memberId);
    expect(byNew.isError ?? false).toBe(false);
    expect(parse(byNew).proposal.status).toBe('merged');
  });

  it('a non-coordinator member cannot transfer coordinatorship', async () => {
    const result = await handler.handle({
      operation: 'transfer_coordinator',
      agentId: memberId,
      workspaceId,
      toAgentId: memberId,
    });

    expect(result.isError).toBe(true);
    expect(parse(result).error).toMatch(/only the (current )?coordinator/i);
  });

  it('the target must already be a member of the workspace', async () => {
    const result = await handler.handle({
      operation: 'transfer_coordinator',
      agentId: coordId,
      workspaceId,
      toAgentId: outsiderId,
    });

    expect(result.isError).toBe(true);
    expect(parse(result).error).toMatch(/not a member/i);
  });

  it('the target must be a registered agent', async () => {
    const result = await handler.handle({
      operation: 'transfer_coordinator',
      agentId: coordId,
      workspaceId,
      toAgentId: 'ghost',
    });

    expect(result.isError).toBe(true);
    expect(parse(result).error).toMatch(/unknown agent/i);
  });

  it('transferring to the current coordinator is refused as a no-op', async () => {
    const result = await handler.handle({
      operation: 'transfer_coordinator',
      agentId: coordId,
      workspaceId,
      toAgentId: coordId,
    });

    expect(result.isError).toBe(true);
    expect(parse(result).error).toMatch(/already the coordinator/i);
  });
});

describe('transfer_coordinator — hosted mode owning-principal recovery', () => {
  let hubStorage: HubStorage;
  let handler: HubToolHandler;
  let workspaceId: string;

  const OWNER = 'apikey-owner';
  const OTHER = 'apikey-other';

  beforeEach(async () => {
    hubStorage = createInMemoryHubStorage();
    handler = createHubToolHandler({
      hubStorage,
      thoughtStore: createInMemoryThoughtStore(),
      hostedMode: true,
    });

    const coord = parse(
      await handler.handle({ operation: 'register', name: 'LostCoordinator' }, 'sess-1', {
        principal: OWNER,
      }),
    );
    workspaceId = parse(
      await handler.handle(
        {
          operation: 'create_workspace',
          agentId: coord.agentId,
          name: 'WS',
          description: 'hosted recovery',
        },
        'sess-1',
        { principal: OWNER },
      ),
    ).workspaceId;
  });

  it('a fresh agent under the owning principal takes coordinatorship', async () => {
    const fresh = parse(
      await handler.handle({ operation: 'register', name: 'Recovered' }, 'sess-2', {
        principal: OWNER,
      }),
    );

    const result = await handler.handle(
      {
        operation: 'transfer_coordinator',
        agentId: fresh.agentId,
        workspaceId,
        toAgentId: fresh.agentId,
      },
      'sess-2',
      { principal: OWNER },
    );

    expect(result.isError ?? false).toBe(false);
    expect(parse(result).coordinator).toBe(fresh.agentId);

    const ws = await hubStorage.getWorkspace(workspaceId);
    expect(ws!.agents.find((a) => a.agentId === fresh.agentId)!.role).toBe('coordinator');
  });

  it('a fresh agent under a different principal is rejected', async () => {
    const stranger = parse(
      await handler.handle({ operation: 'register', name: 'Stranger' }, 'sess-3', {
        principal: OTHER,
      }),
    );

    const result = await handler.handle(
      {
        operation: 'transfer_coordinator',
        agentId: stranger.agentId,
        workspaceId,
        toAgentId: stranger.agentId,
      },
      'sess-3',
      { principal: OTHER },
    );

    expect(result.isError).toBe(true);
    expect(parse(result).error).toMatch(/only the (current )?coordinator|owning principal/i);
  });

  it('the owning principal cannot hand coordinatorship to an agent it does not own', async () => {
    const fresh = parse(
      await handler.handle({ operation: 'register', name: 'Recovered' }, 'sess-2', {
        principal: OWNER,
      }),
    );
    const stranger = parse(
      await handler.handle({ operation: 'register', name: 'Stranger' }, 'sess-3', {
        principal: OTHER,
      }),
    );

    const result = await handler.handle(
      {
        operation: 'transfer_coordinator',
        agentId: fresh.agentId,
        workspaceId,
        toAgentId: stranger.agentId,
      },
      'sess-2',
      { principal: OWNER },
    );

    expect(result.isError).toBe(true);
    expect(parse(result).error).toMatch(/owned by another principal|not a member/i);
  });
});
