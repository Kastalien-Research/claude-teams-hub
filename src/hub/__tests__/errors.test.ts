import { describe, it, expect, beforeEach } from 'vitest';
import { createHubHandler } from '../hub-handler.js';
import { createInMemoryHubStorage, createInMemoryThoughtStore } from './test-helpers.js';

describe('Hub Handler — Not-Found Errors', () => {
  let handler: ReturnType<typeof createHubHandler>;
  let aliceId: string;
  let workspaceId: string;

  beforeEach(async () => {
    const storage = createInMemoryHubStorage();
    const thoughtStore = createInMemoryThoughtStore();
    handler = createHubHandler(storage, thoughtStore);

    const reg = await handler.handle(null, 'register', { name: 'alice' }) as any;
    aliceId = reg.agentId;
    const ws = await handler.handle(aliceId, 'create_workspace', { name: 'ws', description: '...' }) as any;
    workspaceId = ws.workspaceId;
  });

  // T-ERR-1: Join nonexistent workspace
  it('join nonexistent workspace throws error', async () => {
    await expect(
      handler.handle(aliceId, 'join_workspace', { workspaceId: 'nonexistent' }),
    ).rejects.toThrow('Workspace not found: nonexistent');
  });

  // T-ERR-2: Claim nonexistent problem
  it('claim nonexistent problem throws error', async () => {
    await expect(
      handler.handle(aliceId, 'claim_problem', { workspaceId, problemId: 'nonexistent', branchId: 'x' }),
    ).rejects.toThrow('Problem not found: nonexistent');
  });

  // T-ERR-3: Review nonexistent proposal
  it('review nonexistent proposal throws error', async () => {
    await expect(
      handler.handle(aliceId, 'review_proposal', { workspaceId, proposalId: 'nonexistent', verdict: 'approve', reasoning: '...' }),
    ).rejects.toThrow('Proposal not found: nonexistent');
  });

  // T-ERR-4: Post message to nonexistent problem's channel
  it('post message to nonexistent channel throws error', async () => {
    await expect(
      handler.handle(aliceId, 'post_message', { workspaceId, problemId: 'nonexistent', content: 'hello' }),
    ).rejects.toThrow('Channel not found for problem: nonexistent');
  });

  // T-ERR-5: Endorse nonexistent consensus marker
  it('endorse nonexistent consensus marker throws error', async () => {
    await expect(
      handler.handle(aliceId, 'endorse_consensus', { workspaceId, consensusId: 'nonexistent' }),
    ).rejects.toThrow('Consensus marker not found: nonexistent');
  });

  // T-ERR-6: Merge nonexistent proposal
  it('merge nonexistent proposal throws error', async () => {
    await expect(
      handler.handle(aliceId, 'merge_proposal', { workspaceId, proposalId: 'nonexistent', mergeMessage: '...' }),
    ).rejects.toThrow('Proposal not found: nonexistent');
  });
});

// review_proposal used to take `args as any` straight into the manager, so a
// verdict outside ReviewVerdict was persisted unchallenged and then read as
// "not an approval" — indistinguishable from request-changes. The dispatch
// boundary is where the untyped args arrive, so it is where they get checked.
describe('Hub Handler — Review Verdict Validation', () => {
  let handler: ReturnType<typeof createHubHandler>;
  let storage: ReturnType<typeof createInMemoryHubStorage>;
  let aliceId: string;
  let bobId: string;
  let workspaceId: string;
  let proposalId: string;

  beforeEach(async () => {
    storage = createInMemoryHubStorage();
    handler = createHubHandler(storage, createInMemoryThoughtStore());

    const alice = await handler.handle(null, 'register', { name: 'alice' }) as any;
    aliceId = alice.agentId;
    const bob = await handler.handle(null, 'register', { name: 'bob' }) as any;
    bobId = bob.agentId;

    const ws = await handler.handle(aliceId, 'create_workspace', { name: 'ws', description: '...' }) as any;
    workspaceId = ws.workspaceId;
    await handler.handle(bobId, 'join_workspace', { workspaceId });

    const prop = await handler.handle(bobId, 'create_proposal', {
      workspaceId, title: 'T', description: 'd', sourceBranch: 'b',
    }) as any;
    proposalId = prop.proposalId;
  });

  it('rejects a verdict outside the union and names the valid set', async () => {
    await expect(
      handler.handle(aliceId, 'review_proposal', {
        workspaceId, proposalId, verdict: 'reject', reasoning: 'no',
      }),
    ).rejects.toThrow(/Invalid verdict 'reject'.*approve.*request-changes.*comment/);
  });

  it('persists nothing when the verdict is invalid', async () => {
    await expect(
      handler.handle(aliceId, 'review_proposal', {
        workspaceId, proposalId, verdict: 'reject', reasoning: 'no',
      }),
    ).rejects.toThrow();

    const proposal = await storage.getProposal(workspaceId, proposalId);
    expect(proposal!.reviews).toHaveLength(0);
    expect(proposal!.status).toBe('open');
  });

  it('accepts comment, which the catalog previously hid', async () => {
    const result = await handler.handle(aliceId, 'review_proposal', {
      workspaceId, proposalId, verdict: 'comment', reasoning: 'a note',
    }) as any;

    expect(result.review.verdict).toBe('comment');
    expect(result.proposalStatus).toBe('reviewing');
  });

  it('still accepts approve and request-changes', async () => {
    const approved = await handler.handle(aliceId, 'review_proposal', {
      workspaceId, proposalId, verdict: 'approve', reasoning: 'ok',
    }) as any;
    expect(approved.proposalStatus).toBe('approved');

    const changes = await handler.handle(aliceId, 'review_proposal', {
      workspaceId, proposalId, verdict: 'request-changes', reasoning: 'nit',
    }) as any;
    expect(changes.review.verdict).toBe('request-changes');
  });
});
