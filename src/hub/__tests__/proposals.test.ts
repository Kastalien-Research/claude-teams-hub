import { describe, it, expect, beforeEach } from 'vitest';
import { createProposalsManager } from '../proposals.js';
import { createProblemsManager } from '../problems.js';
import { createWorkspaceManager } from '../workspace.js';
import { createIdentityManager } from '../identity.js';
import { createInMemoryHubStorage, createInMemoryThoughtStore } from './test-helpers.js';
import type { HubStorage } from '../hub-types.js';

describe('Proposals', () => {
  let storage: HubStorage;
  let thoughtStore: ReturnType<typeof createInMemoryThoughtStore>;
  let identity: ReturnType<typeof createIdentityManager>;
  let workspace: ReturnType<typeof createWorkspaceManager>;
  let problems: ReturnType<typeof createProblemsManager>;
  let proposals: ReturnType<typeof createProposalsManager>;
  let aliceId: string;
  let bobId: string;
  let workspaceId: string;
  let mainSessionId: string;
  let problemId: string;

  beforeEach(async () => {
    storage = createInMemoryHubStorage();
    thoughtStore = createInMemoryThoughtStore();
    identity = createIdentityManager(storage);
    workspace = createWorkspaceManager(storage, thoughtStore);
    problems = createProblemsManager(storage, thoughtStore);
    proposals = createProposalsManager(storage, thoughtStore);

    const alice = await identity.register({ name: 'alice' });
    aliceId = alice.agentId;
    const bob = await identity.register({ name: 'bob' });
    bobId = bob.agentId;

    const ws = await workspace.createWorkspace(aliceId, { name: 'test-ws', description: '...' });
    workspaceId = ws.workspaceId;
    mainSessionId = ws.mainSessionId;
    await workspace.joinWorkspace(bobId, { workspaceId });

    // Write 2 thoughts on main chain
    for (let i = 1; i <= 2; i++) {
      await thoughtStore.saveThought(mainSessionId, {
        thought: `thought ${i}`, thoughtNumber: i, totalThoughts: 2,
        nextThoughtNeeded: i < 2, timestamp: new Date().toISOString(),
      });
    }

    // Alice creates a problem, bob claims it
    const p = await problems.createProblem(aliceId, { workspaceId, title: 'Analyze Redis', description: '...' });
    problemId = p.problemId;
    await problems.claimProblem(bobId, { workspaceId, problemId, branchId: 'caching-analysis' });

    // Bob writes 3 thoughts on branch
    for (let i = 1; i <= 3; i++) {
      await thoughtStore.saveBranchThought(mainSessionId, 'caching-analysis', {
        thought: `branch thought ${i}`, thoughtNumber: i, totalThoughts: 3,
        nextThoughtNeeded: i < 3, branchId: 'caching-analysis', branchFromThought: 2,
        timestamp: new Date().toISOString(),
      });
    }
  });

  // T-PP-1: Create proposal
  it('create proposal returns proposalId with open status', async () => {
    const result = await proposals.createProposal(bobId, {
      workspaceId, title: 'Redis caching strategy', description: '...',
      sourceBranch: 'caching-analysis', problemId,
    });

    expect(result.proposalId).toBeDefined();
    const proposal = await storage.getProposal(workspaceId, result.proposalId);
    expect(proposal!.status).toBe('open');
    expect(proposal!.createdBy).toBe(bobId);
    expect(proposal!.sourceBranch).toBe('caching-analysis');
  });

  // T-PP-2: Review proposal — approve
  // Status is derived from the merge gate, so an approve that makes the
  // proposal mergeable must say so rather than reporting 'reviewing'.
  it('review proposal with approve sets approved status', async () => {
    const { proposalId } = await proposals.createProposal(bobId, {
      workspaceId, title: 'Redis', description: '...', sourceBranch: 'caching-analysis', problemId,
    });

    const result = await proposals.reviewProposal(aliceId, {
      workspaceId, proposalId, verdict: 'approve', reasoning: 'Solid analysis',
    });

    expect(result.review.verdict).toBe('approve');
    expect(result.review.reviewerId).toBe(aliceId);
    expect(result.proposalStatus).toBe('approved');

    // The reported status is the persisted status, not a hardcoded string.
    const persisted = await storage.getProposal(workspaceId, proposalId);
    expect(persisted!.status).toBe('approved');
  });

  // T-PP-3: Review proposal — request changes
  it('review proposal with request-changes', async () => {
    const { proposalId } = await proposals.createProposal(bobId, {
      workspaceId, title: 'Redis', description: '...', sourceBranch: 'caching-analysis', problemId,
    });

    const result = await proposals.reviewProposal(aliceId, {
      workspaceId, proposalId, verdict: 'request-changes', reasoning: 'Missing cost analysis',
    });

    expect(result.review.verdict).toBe('request-changes');
    expect(result.proposalStatus).toBe('reviewing');

    const persisted = await storage.getProposal(workspaceId, proposalId);
    expect(persisted!.status).toBe('reviewing');
  });

  // A 'comment' verdict carries no approval, so it cannot make a proposal
  // mergeable and must not advance it past 'reviewing'.
  it('review proposal with comment leaves it in reviewing', async () => {
    const { proposalId } = await proposals.createProposal(bobId, {
      workspaceId, title: 'Redis', description: '...', sourceBranch: 'caching-analysis', problemId,
    });

    const result = await proposals.reviewProposal(aliceId, {
      workspaceId, proposalId, verdict: 'comment', reasoning: 'Just noting a thing',
    });

    expect(result.proposalStatus).toBe('reviewing');
    await expect(
      proposals.mergeProposal(aliceId, { workspaceId, proposalId, mergeMessage: '...' }),
    ).rejects.toThrow('Proposal has no approvals');
  });

  // The gate mergeProposal actually enforces is "at least one approve" — it
  // does not look at later request-changes reviews. Status has to report that
  // same gate, or it goes back to lying about what merge will do.
  it('approved status tracks the merge gate, not review recency', async () => {
    const carol = await identity.register({ name: 'carol' });
    await workspace.joinWorkspace(carol.agentId, { workspaceId });

    const { proposalId } = await proposals.createProposal(bobId, {
      workspaceId, title: 'Redis', description: '...', sourceBranch: 'caching-analysis', problemId,
    });

    await proposals.reviewProposal(aliceId, {
      workspaceId, proposalId, verdict: 'approve', reasoning: 'Good',
    });
    const after = await proposals.reviewProposal(carol.agentId, {
      workspaceId, proposalId, verdict: 'request-changes', reasoning: 'One nit',
    });

    expect(after.proposalStatus).toBe('approved');
    // ...and merge does in fact still succeed, which is what makes that honest.
    const merged = await proposals.mergeProposal(aliceId, {
      workspaceId, proposalId, mergeMessage: 'Accepted',
    });
    expect(merged.proposal.status).toBe('merged');
  });

  it('merge succeeds from approved status', async () => {
    const { proposalId } = await proposals.createProposal(bobId, {
      workspaceId, title: 'Redis', description: '...', sourceBranch: 'caching-analysis', problemId,
    });
    await proposals.reviewProposal(aliceId, {
      workspaceId, proposalId, verdict: 'approve', reasoning: 'Good',
    });
    expect((await storage.getProposal(workspaceId, proposalId))!.status).toBe('approved');

    const result = await proposals.mergeProposal(aliceId, {
      workspaceId, proposalId, mergeMessage: 'Accepted',
    });
    expect(result.proposal.status).toBe('merged');
  });

  // 'approved' is still a live proposal: anything that counts what is
  // outstanding has to include it or the count silently drops approvals.
  it('an approved proposal still counts as open in workspace status', async () => {
    const { proposalId } = await proposals.createProposal(bobId, {
      workspaceId, title: 'Redis', description: '...', sourceBranch: 'caching-analysis', problemId,
    });
    await proposals.reviewProposal(aliceId, {
      workspaceId, proposalId, verdict: 'approve', reasoning: 'Good',
    });

    const status = await workspace.workspaceStatus({ workspaceId });
    expect(status.openProposals).toBe(1);
  });

  // T-PP-4: Self-review is rejected
  it('self-review throws error', async () => {
    const { proposalId } = await proposals.createProposal(bobId, {
      workspaceId, title: 'Redis', description: '...', sourceBranch: 'caching-analysis', problemId,
    });

    await expect(
      proposals.reviewProposal(bobId, {
        workspaceId, proposalId, verdict: 'approve', reasoning: '...',
      }),
    ).rejects.toThrow('Cannot review your own proposal');
  });

  // T-PP-5: Merge proposal creates merge thought on main chain
  it('merge proposal creates merge thought on main chain', async () => {
    const { proposalId } = await proposals.createProposal(bobId, {
      workspaceId, title: 'Redis', description: '...', sourceBranch: 'caching-analysis', problemId,
    });

    await proposals.reviewProposal(aliceId, {
      workspaceId, proposalId, verdict: 'approve', reasoning: 'Good',
    });

    const result = await proposals.mergeProposal(aliceId, {
      workspaceId, proposalId, mergeMessage: 'Accepted: Redis is the right caching layer',
    });

    expect(result.mergeThoughtNumber).toBe(3); // Main chain had 2, merge is 3
    expect(result.proposal.status).toBe('merged');

    // Check merge thought exists on main chain
    const mergeThought = await thoughtStore.getThought(mainSessionId, 3);
    expect(mergeThought).not.toBeNull();
    expect(mergeThought!.thought).toBe('Accepted: Redis is the right caching layer');

    // Linked problem should be resolved
    const problem = await storage.getProblem(workspaceId, problemId);
    expect(problem!.status).toBe('resolved');
  });

  // claimProblem sets currentWork; nothing used to unset it. After a merge
  // auto-resolves the linked problem the assignee reads as still working on
  // it, so every roster view points teammates at finished work.
  it('merge clears currentWork for the agent assigned to the resolved problem', async () => {
    const before = await storage.getWorkspace(workspaceId);
    expect(before!.agents.find(a => a.agentId === bobId)!.currentWork).toBe(problemId);

    const { proposalId } = await proposals.createProposal(bobId, {
      workspaceId, title: 'Redis', description: '...', sourceBranch: 'caching-analysis', problemId,
    });
    await proposals.reviewProposal(aliceId, {
      workspaceId, proposalId, verdict: 'approve', reasoning: 'Good',
    });
    await proposals.mergeProposal(aliceId, {
      workspaceId, proposalId, mergeMessage: 'Accepted',
    });

    const after = await storage.getWorkspace(workspaceId);
    expect(after!.agents.find(a => a.agentId === bobId)!.currentWork).toBeUndefined();
    // Alice was never on this problem, so her slot is untouched.
    expect(after!.agents.find(a => a.agentId === aliceId)!.currentWork).toBeUndefined();
  });

  it('merge leaves currentWork alone for agents on other problems', async () => {
    const other = await problems.createProblem(aliceId, {
      workspaceId, title: 'Unrelated', description: '...',
    });
    await problems.claimProblem(aliceId, {
      workspaceId, problemId: other.problemId, branchId: 'unrelated',
    });

    const { proposalId } = await proposals.createProposal(bobId, {
      workspaceId, title: 'Redis', description: '...', sourceBranch: 'caching-analysis', problemId,
    });
    await proposals.reviewProposal(aliceId, {
      workspaceId, proposalId, verdict: 'approve', reasoning: 'Good',
    });
    await proposals.mergeProposal(aliceId, {
      workspaceId, proposalId, mergeMessage: 'Accepted',
    });

    const after = await storage.getWorkspace(workspaceId);
    expect(after!.agents.find(a => a.agentId === bobId)!.currentWork).toBeUndefined();
    expect(after!.agents.find(a => a.agentId === aliceId)!.currentWork).toBe(other.problemId);
  });

  // T-PP-6: Merge without approval fails
  it('merge without approval throws error', async () => {
    const { proposalId } = await proposals.createProposal(bobId, {
      workspaceId, title: 'Redis', description: '...', sourceBranch: 'caching-analysis', problemId,
    });

    await expect(
      proposals.mergeProposal(aliceId, { workspaceId, proposalId, mergeMessage: '...' }),
    ).rejects.toThrow('Proposal has no approvals');
  });

  // T-PP-7: Merge by non-coordinator fails
  it('merge by non-coordinator throws error', async () => {
    const { proposalId } = await proposals.createProposal(bobId, {
      workspaceId, title: 'Redis', description: '...', sourceBranch: 'caching-analysis', problemId,
    });

    await proposals.reviewProposal(aliceId, {
      workspaceId, proposalId, verdict: 'approve', reasoning: 'Good',
    });

    await expect(
      proposals.mergeProposal(bobId, { workspaceId, proposalId, mergeMessage: '...' }),
    ).rejects.toThrow('Only coordinator can merge proposals');
  });

  // T-PP-8: Branch thoughts preserved after merge
  it('branch thoughts preserved after merge', async () => {
    const { proposalId } = await proposals.createProposal(bobId, {
      workspaceId, title: 'Redis', description: '...', sourceBranch: 'caching-analysis', problemId,
    });

    await proposals.reviewProposal(aliceId, {
      workspaceId, proposalId, verdict: 'approve', reasoning: 'Good',
    });

    await proposals.mergeProposal(aliceId, {
      workspaceId, proposalId, mergeMessage: 'Accepted',
    });

    const branchThoughts = await thoughtStore.getBranch(mainSessionId, 'caching-analysis');
    expect(branchThoughts).toHaveLength(3);
  });

  // T-PP-9: List proposals with status filter
  it('list proposals with status filter', async () => {
    await proposals.createProposal(bobId, {
      workspaceId, title: 'P1', description: '...', sourceBranch: 'caching-analysis',
    });

    // Create a second proposal and merge it
    const { proposalId: p2 } = await proposals.createProposal(bobId, {
      workspaceId, title: 'P2', description: '...', sourceBranch: 'caching-analysis',
    });
    await proposals.reviewProposal(aliceId, {
      workspaceId, proposalId: p2, verdict: 'approve', reasoning: 'ok',
    });
    await proposals.mergeProposal(aliceId, {
      workspaceId, proposalId: p2, mergeMessage: 'merged',
    });

    // Create a third proposal in reviewing
    const { proposalId: p3 } = await proposals.createProposal(bobId, {
      workspaceId, title: 'P3', description: '...', sourceBranch: 'caching-analysis',
    });
    await proposals.reviewProposal(aliceId, {
      workspaceId, proposalId: p3, verdict: 'comment', reasoning: 'hmm',
    });

    const result = await proposals.listProposals({ workspaceId, status: 'open' });
    expect(result.proposals).toHaveLength(1);
    expect(result.proposals[0].status).toBe('open');
  });

  // T-PP-10: List proposals without filter returns all
  it('list proposals without filter returns all', async () => {
    await proposals.createProposal(bobId, {
      workspaceId, title: 'P1', description: '...', sourceBranch: 'caching-analysis',
    });
    await proposals.createProposal(bobId, {
      workspaceId, title: 'P2', description: '...', sourceBranch: 'caching-analysis',
    });
    await proposals.createProposal(bobId, {
      workspaceId, title: 'P3', description: '...', sourceBranch: 'caching-analysis',
    });

    const result = await proposals.listProposals({ workspaceId });
    expect(result.proposals).toHaveLength(3);
  });
});
