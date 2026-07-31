import { describe, it, expect, beforeEach } from 'vitest';
import { createHubHandler } from '../hub-handler.js';
import { createInMemoryHubStorage, createInMemoryThoughtStore } from './test-helpers.js';

describe('Hub Handler — Progressive Disclosure', () => {
  let handler: ReturnType<typeof createHubHandler>;

  beforeEach(() => {
    const storage = createInMemoryHubStorage();
    const thoughtStore = createInMemoryThoughtStore();
    handler = createHubHandler(storage, thoughtStore);
  });

  // T-PD-1: Unregistered agent can only register or list workspaces.
  // The failure names the missing RECORD, not a missing session registration
  // (SPEC-HUB-003): identity is resolved per request from storage.
  it('unregistered agent cannot create workspace', async () => {
    await expect(
      handler.handle('unknown-agent', 'create_workspace', { name: 'ws', description: '...' }),
    ).rejects.toThrow(/Unknown agent 'unknown-agent'/);
  });

  it('a call that names no agent at all reports the explicit-agentId requirement', async () => {
    await expect(
      handler.handle(null, 'create_workspace', { name: 'ws', description: '...' }),
    ).rejects.toThrow(/require an explicit agentId/i);
  });

  // T-PD-2: Registered agent without workspace cannot create problems
  it('registered agent without workspace cannot create problems', async () => {
    const result = await handler.handle(null, 'register', { name: 'alice' }) as any;
    const agentId = result.agentId;

    await expect(
      handler.handle(agentId, 'create_problem', { workspaceId: 'any', title: '...', description: '...' }),
    ).rejects.toThrow(/Join a workspace first/);
  });

  // T-PD-3: Agent in workspace can access all operations
  it('agent in workspace can create problems', async () => {
    const reg = await handler.handle(null, 'register', { name: 'alice' }) as any;
    const agentId = reg.agentId;

    const ws = await handler.handle(agentId, 'create_workspace', { name: 'ws', description: '...' }) as any;

    const result = await handler.handle(agentId, 'create_problem', {
      workspaceId: ws.workspaceId,
      title: 'Test problem',
      description: '...',
    }) as any;

    expect(result.problemId).toBeDefined();
  });
});
