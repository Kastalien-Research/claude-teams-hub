/**
 * Tests for hub-handler onEvent callback
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createHubHandler } from '../hub-handler.js';
import type { HubEvent } from '../hub-handler.js';
import { createInMemoryHubStorage, createInMemoryThoughtStore } from './test-helpers.js';

describe('Hub Event Callback', () => {
  let storage: ReturnType<typeof createInMemoryHubStorage>;
  let thoughtStore: ReturnType<typeof createInMemoryThoughtStore>;

  beforeEach(() => {
    storage = createInMemoryHubStorage();
    thoughtStore = createInMemoryThoughtStore();
  });

  it('T-HEC-1: createHubHandler accepts onEvent callback', () => {
    const onEvent = vi.fn();
    const handler = createHubHandler(storage, thoughtStore, onEvent);
    expect(handler).toBeDefined();
    expect(handler.handle).toBeDefined();
  });

  it('T-HEC-2: problem_created fires onEvent after successful create_problem', async () => {
    const onEvent = vi.fn();
    const handler = createHubHandler(storage, thoughtStore, onEvent);

    // Register + create workspace + join
    const reg = await handler.handle(null, 'register', { name: 'alice' }) as any;
    const ws = await handler.handle(reg.agentId, 'create_workspace', {
      name: 'ws', description: 'test',
    }) as any;

    // Create problem
    await handler.handle(reg.agentId, 'create_problem', {
      workspaceId: ws.workspaceId,
      title: 'Test problem',
      description: 'A test problem',
    });

    expect(onEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'problem_created',
        workspaceId: ws.workspaceId,
      })
    );
  });

  it('T-HEC-3: message_posted fires onEvent after successful post_message', async () => {
    const onEvent = vi.fn();
    const handler = createHubHandler(storage, thoughtStore, onEvent);

    const reg = await handler.handle(null, 'register', { name: 'alice' }) as any;
    const ws = await handler.handle(reg.agentId, 'create_workspace', {
      name: 'ws', description: 'test',
    }) as any;
    const problem = await handler.handle(reg.agentId, 'create_problem', {
      workspaceId: ws.workspaceId,
      title: 'Test problem',
      description: 'A test problem',
    }) as any;

    // Reset to clear the problem_created event
    onEvent.mockClear();

    await handler.handle(reg.agentId, 'post_message', {
      workspaceId: ws.workspaceId,
      problemId: problem.problemId,
      content: 'Hello!',
    });

    expect(onEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'message_posted',
        workspaceId: ws.workspaceId,
        data: expect.objectContaining({ problemId: problem.problemId }),
      })
    );
  });

  it('T-HEC-4: onEvent not called when operation fails', async () => {
    const onEvent = vi.fn();
    const handler = createHubHandler(storage, thoughtStore, onEvent);

    // Try to create problem without being registered — should fail
    await expect(
      handler.handle('unknown-agent', 'create_problem', {
        workspaceId: 'ws-1',
        title: 'Test',
        description: 'desc',
      })
    ).rejects.toThrow();

    expect(onEvent).not.toHaveBeenCalled();
  });

  it("T-HEC-5: agent_registered fires on register with workspaceId '*'", async () => {
    const onEvent = vi.fn();
    const handler = createHubHandler(storage, thoughtStore, onEvent);

    const reg = await handler.handle(null, 'register', {
      name: 'alice', profile: 'ARCHITECT',
    }) as any;

    expect(onEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'agent_registered',
        // Registration precedes workspace membership — no workspace to scope to.
        workspaceId: '*',
        data: expect.objectContaining({
          agentId: reg.agentId,
          name: 'alice',
          profile: 'ARCHITECT',
        }),
      })
    );
  });

  it('T-HEC-6: workspace_joined fires on join_workspace', async () => {
    const onEvent = vi.fn();
    const handler = createHubHandler(storage, thoughtStore, onEvent);

    const creator = await handler.handle(null, 'register', { name: 'alice' }) as any;
    const ws = await handler.handle(creator.agentId, 'create_workspace', {
      name: 'ws', description: 'test',
    }) as any;
    const joiner = await handler.handle(null, 'register', { name: 'bob' }) as any;

    onEvent.mockClear();

    await handler.handle(joiner.agentId, 'join_workspace', {
      workspaceId: ws.workspaceId,
    });

    expect(onEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'workspace_joined',
        workspaceId: ws.workspaceId,
        data: expect.objectContaining({ agentId: joiner.agentId, name: 'bob' }),
      })
    );
  });

  it('T-HEC-7: quick_join fires agent_registered then workspace_joined', async () => {
    const onEvent = vi.fn();
    const handler = createHubHandler(storage, thoughtStore, onEvent);

    const creator = await handler.handle(null, 'register', { name: 'alice' }) as any;
    const ws = await handler.handle(creator.agentId, 'create_workspace', {
      name: 'ws', description: 'test',
    }) as any;

    onEvent.mockClear();

    await handler.handle(null, 'quick_join', {
      name: 'bob', workspaceId: ws.workspaceId,
    });

    const types = onEvent.mock.calls.map(([event]) => event.type);
    expect(types).toEqual(['agent_registered', 'workspace_joined']);
    expect(onEvent.mock.calls[0]![0].workspaceId).toBe('*');
    expect(onEvent.mock.calls[1]![0].workspaceId).toBe(ws.workspaceId);
  });

  it('T-HEC-8: problem_claimed fires on claim_problem with the branch id', async () => {
    const onEvent = vi.fn();
    const handler = createHubHandler(storage, thoughtStore, onEvent);

    const reg = await handler.handle(null, 'register', { name: 'alice' }) as any;
    const ws = await handler.handle(reg.agentId, 'create_workspace', {
      name: 'ws', description: 'test',
    }) as any;
    const problem = await handler.handle(reg.agentId, 'create_problem', {
      workspaceId: ws.workspaceId,
      title: 'Test problem',
      description: 'A test problem',
    }) as any;

    onEvent.mockClear();

    await handler.handle(reg.agentId, 'claim_problem', {
      workspaceId: ws.workspaceId,
      problemId: problem.problemId,
    });

    expect(onEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'problem_claimed',
        workspaceId: ws.workspaceId,
        data: expect.objectContaining({
          problemId: problem.problemId,
          agentId: reg.agentId,
          // Auto-generated when the caller omits it.
          branchId: `alice/${problem.problemId}`,
        }),
      })
    );
  });

  it('T-HEC-9: proposal_reviewed fires on review_proposal with the verdict', async () => {
    const onEvent = vi.fn();
    const handler = createHubHandler(storage, thoughtStore, onEvent);

    const author = await handler.handle(null, 'register', { name: 'alice' }) as any;
    const ws = await handler.handle(author.agentId, 'create_workspace', {
      name: 'ws', description: 'test',
    }) as any;
    const proposal = await handler.handle(author.agentId, 'create_proposal', {
      workspaceId: ws.workspaceId,
      title: 'A proposal',
      description: 'desc',
      sourceBranch: 'alice/branch',
    }) as any;

    // Proposals cannot be self-reviewed.
    const reviewer = await handler.handle(null, 'quick_join', {
      name: 'bob', workspaceId: ws.workspaceId,
    }) as any;

    onEvent.mockClear();

    await handler.handle(reviewer.agentId, 'review_proposal', {
      workspaceId: ws.workspaceId,
      proposalId: proposal.proposalId,
      verdict: 'approve',
      reasoning: 'looks right',
    });

    expect(onEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'proposal_reviewed',
        workspaceId: ws.workspaceId,
        data: expect.objectContaining({
          proposalId: proposal.proposalId,
          verdict: 'approve',
          agentId: reviewer.agentId,
        }),
      })
    );
  });
});
