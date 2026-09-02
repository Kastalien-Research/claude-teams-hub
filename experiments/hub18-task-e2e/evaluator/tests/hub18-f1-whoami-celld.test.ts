/** hub18 F1 — whoami for an agent who created a celld workspace returns that workspace id in `workspaces`. */
import { describe, expect, it } from 'vitest';
import { createHarness, createCelldWorkspace, registerAgent, whoami } from './hub18-harness.js';

describe('hub18 F1 — whoami includes celld workspaces', () => {
  it('returns the celld workspace its creator belongs to', async () => {
    const h = createHarness();
    const alice = await registerAgent(h, 'alice');
    const cellId = await createCelldWorkspace(h, alice, 'cell-ws');

    // The cell itself reports the membership (this is what workspace_status shows today).
    const status = (await h.routed.handle(alice, 'workspace_status', { workspaceId: cellId })) as {
      members: Array<{ agentId: string }>;
    };
    expect(status.members.map(m => m.agentId)).toEqual([alice]);

    const me = await whoami(h, alice);
    expect(me.agentId).toBe(alice);
    expect(me.workspaces).toContain(cellId);
  });

  it('does not report a celld workspace the agent has not joined', async () => {
    const h = createHarness();
    const alice = await registerAgent(h, 'alice');
    const bob = await registerAgent(h, 'bob');
    const cellId = await createCelldWorkspace(h, alice, 'cell-ws');

    const me = await whoami(h, bob);
    expect(me.workspaces).not.toContain(cellId);
  });
});
