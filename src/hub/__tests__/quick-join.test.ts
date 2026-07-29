/**
 * Tests for quick_join hub operation
 *
 * quick_join combines register + join_workspace in a single call
 * to reduce bootstrap friction for Agent Teams teammates.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { createHubHandler } from '../hub-handler.js';
import { createInMemoryHubStorage, createInMemoryThoughtStore } from './test-helpers.js';

describe('quick_join operation', () => {
  let storage: ReturnType<typeof createInMemoryHubStorage>;
  let thoughtStore: ReturnType<typeof createInMemoryThoughtStore>;
  let handler: ReturnType<typeof createHubHandler>;
  let workspaceId: string;

  beforeEach(async () => {
    storage = createInMemoryHubStorage();
    thoughtStore = createInMemoryThoughtStore();
    handler = createHubHandler(storage, thoughtStore);

    // Create a coordinator and workspace
    const coord = await handler.handle(null, 'register', { name: 'Coordinator' });
    const coordId = (coord as any).agentId;
    const ws = await handler.handle(coordId, 'create_workspace', {
      name: 'Test Workspace',
      description: 'For quick_join testing',
    });
    workspaceId = (ws as any).workspaceId;
  });

  it('registers and joins workspace in one call', async () => {
    const result = await handler.handle(null, 'quick_join', {
      name: 'Architect-1',
      workspaceId,
    }) as any;

    expect(result.agentId).toBeDefined();
    expect(result.name).toBe('Architect-1');
    expect(result.workspace).toBeDefined();
    expect(result.workspace.id).toBe(workspaceId);
  });

  it('includes problems and proposals in response', async () => {
    const result = await handler.handle(null, 'quick_join', {
      name: 'Debugger-1',
      workspaceId,
    }) as any;

    expect(result.problems).toBeDefined();
    expect(Array.isArray(result.problems)).toBe(true);
    expect(result.proposals).toBeDefined();
    expect(Array.isArray(result.proposals)).toBe(true);
  });

  it('sets profile when provided', async () => {
    const result = await handler.handle(null, 'quick_join', {
      name: 'Arch',
      workspaceId,
      profile: 'ARCHITECT',
    }) as any;

    expect(result.agentId).toBeDefined();

    // Verify profile was set via whoami
    const whoami = await handler.handle(result.agentId, 'whoami', {}) as any;
    expect(whoami.profile).toBe('ARCHITECT');
  });

  it('rejects invalid profiles', async () => {
    await expect(
      handler.handle(null, 'quick_join', {
        name: 'Bad',
        workspaceId,
        profile: 'INVALID',
      })
    ).rejects.toThrow(/Invalid profile/);
  });

  it('rejects when workspace does not exist', async () => {
    await expect(
      handler.handle(null, 'quick_join', {
        name: 'Lost',
        workspaceId: 'nonexistent-ws',
      })
    ).rejects.toThrow(/Workspace not found/);
  });

  it('agent appears in workspace member list', async () => {
    const result = await handler.handle(null, 'quick_join', {
      name: 'Member',
      workspaceId,
    }) as any;

    const status = await handler.handle(result.agentId, 'workspace_status', {
      workspaceId,
    }) as any;

    const memberIds = status.agents.map((a: any) => a.agentId);
    expect(memberIds).toContain(result.agentId);
  });

  it('requires name argument', async () => {
    await expect(
      handler.handle(null, 'quick_join', { workspaceId })
    ).rejects.toThrow();
  });

  it('requires workspaceId argument', async () => {
    await expect(
      handler.handle(null, 'quick_join', { name: 'NoWS' })
    ).rejects.toThrow();
  });

  // Known-issue #1 (docs/known-issues.md): quick_join in a session that already
  // holds an identity used to mint a NEW agent and join THAT, returning success
  // describing an agent the caller is not — every later call then failed
  // "Not a member of this workspace" while an undriven orphan sat in the
  // member list. A session identity, once established, is reused or the call
  // refuses loudly; it is never silently replaced by a second registration.
  describe('with an existing session identity', () => {
    let firstJoin: any;
    let secondWorkspaceId: string;

    beforeEach(async () => {
      firstJoin = await handler.handle(null, 'quick_join', {
        name: 'Reviewer-1',
        workspaceId,
      });
      const coord = await handler.handle(null, 'register', { name: 'Coordinator-2' });
      const ws2 = await handler.handle((coord as any).agentId, 'create_workspace', {
        name: 'Second Workspace',
        description: 'For re-join testing',
      });
      secondWorkspaceId = (ws2 as any).workspaceId;
    });

    it('reuses the identity when the name matches, joining the new workspace', async () => {
      const before = (await storage.getAgents()).length;

      const rejoin = await handler.handle(firstJoin.agentId, 'quick_join', {
        name: 'Reviewer-1',
        workspaceId: secondWorkspaceId,
      }) as any;

      expect(rejoin.agentId).toBe(firstJoin.agentId);
      expect(rejoin.workspace.id).toBe(secondWorkspaceId);
      expect((await storage.getAgents()).length).toBe(before);

      const status = await handler.handle(firstJoin.agentId, 'workspace_status', {
        workspaceId: secondWorkspaceId,
      }) as any;
      expect(status.agents.map((a: any) => a.agentId)).toContain(firstJoin.agentId);
    });

    // Greptile P1/P2 on this PR: the reuse branch must not become a validation
    // bypass — a supplied profile is validated exactly as register validates
    // it, and supplied profile/clientInfo are persisted onto the existing
    // agent rather than silently dropped.
    it('still rejects an invalid profile on the reuse path', async () => {
      await expect(
        handler.handle(firstJoin.agentId, 'quick_join', {
          name: 'Reviewer-1',
          workspaceId: secondWorkspaceId,
          profile: 'INVALID',
        }),
      ).rejects.toThrow(/Invalid profile 'INVALID'/);
    });

    it('persists a newly supplied profile and clientInfo when reusing', async () => {
      const rejoin = await handler.handle(firstJoin.agentId, 'quick_join', {
        name: 'Reviewer-1',
        workspaceId: secondWorkspaceId,
        profile: 'REVIEWER',
        clientInfo: 'vitest-client',
      }) as any;
      expect(rejoin.agentId).toBe(firstJoin.agentId);

      const stored = await storage.getAgent(firstJoin.agentId);
      expect(stored?.profile).toBe('REVIEWER');
      expect(stored?.clientInfo).toBe('vitest-client');
    });

    it('leaves stored metadata untouched when the re-join supplies none', async () => {
      await handler.handle(firstJoin.agentId, 'quick_join', {
        name: 'Reviewer-1',
        workspaceId: secondWorkspaceId,
        profile: 'ARCHITECT',
      });
      await handler.handle(firstJoin.agentId, 'quick_join', {
        name: 'Reviewer-1',
        workspaceId,
      });
      expect((await storage.getAgent(firstJoin.agentId))?.profile).toBe('ARCHITECT');
    });

    it('is idempotent for the workspace already joined', async () => {
      const rejoin = await handler.handle(firstJoin.agentId, 'quick_join', {
        name: 'Reviewer-1',
        workspaceId,
      }) as any;
      expect(rejoin.agentId).toBe(firstJoin.agentId);
      expect(rejoin.workspace.id).toBe(workspaceId);
    });

    // A DIFFERENT name is the sanctioned multi-agent flow (T-HTW-14): a new
    // agent is minted — but the result must SAY the session default is
    // unchanged, so the caller cannot mistake the new agent for itself.
    it('mints a sub-agent for a different name, and says the default is unchanged', async () => {
      const before = (await storage.getAgents()).length;

      const subJoin = await handler.handle(firstJoin.agentId, 'quick_join', {
        name: 'Sub-Agent-1',
        workspaceId: secondWorkspaceId,
      }) as any;

      expect(subJoin.agentId).not.toBe(firstJoin.agentId);
      expect((await storage.getAgents()).length).toBe(before + 1);
      expect(subJoin.note).toMatch(/default identity remains 'Reviewer-1'/);
      expect(subJoin.note).toContain(subJoin.agentId);
    });
  });
});
