/**
 * SPEC-HUB-003 c7 — identity behavior is independent of the protocol session.
 *
 * The same register / act-as / coordinator sequence runs twice: once with a
 * DISTINCT mcpSessionId on every single call (the worst case for anything
 * that remembers a connection), once with none at all (what MCP 2026-07-28
 * sessionless operation looks like). The transcripts must be identical, so
 * the identity layer needs no change when the transport drops sessions.
 */

import { describe, it, expect } from 'vitest';
import { createHubToolHandler } from '../hub-tool-handler.js';
import { createInMemoryHubStorage, createInMemoryThoughtStore } from './test-helpers.js';

type Step = { step: string; isError: boolean; detail: unknown };

const parse = (result: { content: Array<{ type: string; text?: string }> }): any =>
  JSON.parse((result.content[0] as { text: string }).text);

/**
 * Runs the scenario and returns a transcript in which agent/workspace ids are
 * replaced by stable labels — the ids themselves are random per run, so only
 * their RELATIONSHIPS are comparable across the two modes.
 */
async function runScenario(sessionIdFor: (step: number) => string | undefined): Promise<Step[]> {
  const hubStorage = createInMemoryHubStorage();
  const handler = createHubToolHandler({
    hubStorage,
    thoughtStore: createInMemoryThoughtStore(),
  });

  const labels = new Map<string, string>();
  const label = (value: unknown): unknown =>
    typeof value === 'string' && labels.has(value) ? labels.get(value) : value;

  const transcript: Step[] = [];
  let step = 0;
  const call = async (
    name: string,
    input: Record<string, unknown>,
    detail: (data: any) => unknown,
  ): Promise<any> => {
    const result = await handler.handle(
      input as { operation: string },
      sessionIdFor(step++),
    );
    const data = parse(result);
    transcript.push({
      step: name,
      isError: result.isError ?? false,
      detail: result.isError ? String(data.error) : detail(data),
    });
    return data;
  };

  const coord = await call('register-coordinator', { operation: 'register', name: 'Coordinator' }, (d) => d.name);
  labels.set(coord.agentId, 'COORD');

  const contributor = await call('register-contributor', { operation: 'register', name: 'Contributor' }, (d) => d.name);
  labels.set(contributor.agentId, 'CONTRIB');

  // Acting as an agent registered on an earlier (possibly different) session.
  await call('act-as-coordinator', { operation: 'whoami', agentId: coord.agentId }, (d) => ({
    agentId: label(d.agentId),
    name: d.name,
  }));

  const ws = await call(
    'create-workspace',
    { operation: 'create_workspace', agentId: coord.agentId, name: 'WS', description: 'c7' },
    () => 'created',
  );
  labels.set(ws.workspaceId, 'WS');

  await call(
    'join-workspace',
    { operation: 'join_workspace', agentId: contributor.agentId, workspaceId: ws.workspaceId },
    (d) => d.workspace.agents.map((a: any) => label(a.agentId)),
  );

  const proposal = await call(
    'create-proposal',
    {
      operation: 'create_proposal',
      agentId: contributor.agentId,
      workspaceId: ws.workspaceId,
      title: 'P',
      description: 'd',
      sourceBranch: 'contrib/p',
    },
    () => 'created',
  );

  await call(
    'review-proposal',
    {
      operation: 'review_proposal',
      agentId: coord.agentId,
      workspaceId: ws.workspaceId,
      proposalId: proposal.proposalId,
      verdict: 'approve',
      reasoning: 'ok',
    },
    (d) => ({ verdict: d.review.verdict, reviewer: label(d.review.reviewerId) }),
  );

  // Coordinator-only, from whatever session the transport happened to give us.
  await call(
    'merge-proposal-as-coordinator',
    {
      operation: 'merge_proposal',
      agentId: coord.agentId,
      workspaceId: ws.workspaceId,
      proposalId: proposal.proposalId,
      mergeMessage: 'merged',
    },
    (d) => ({ status: d.proposal.status }),
  );

  // Coordinator-only, attempted by the contributor: must fail identically.
  await call(
    'merge-proposal-as-contributor',
    {
      operation: 'merge_proposal',
      agentId: contributor.agentId,
      workspaceId: ws.workspaceId,
      proposalId: proposal.proposalId,
      mergeMessage: 'nope',
    },
    () => 'unreachable',
  );

  await call(
    'transfer-coordinator',
    {
      operation: 'transfer_coordinator',
      agentId: coord.agentId,
      workspaceId: ws.workspaceId,
      toAgentId: contributor.agentId,
    },
    (d) => ({ coordinator: label(d.coordinator), previous: label(d.previousCoordinator) }),
  );

  // An agentId-less mutation: instructive failure, in both modes.
  await call(
    'implicit-mutation',
    { operation: 'create_workspace', name: 'WS2', description: 'implicit' },
    () => 'unreachable',
  );

  return transcript;
}

describe('identity resolution is independent of mcpSessionId (c7)', () => {
  it('produces an identical transcript with distinct session ids and with none', async () => {
    const withSessions = await runScenario((step) => `sess-${step}`);
    const withoutSessions = await runScenario(() => undefined);

    expect(withoutSessions).toEqual(withSessions);
  });

  it('the transcript is the expected outcome sequence, not two identical failures', async () => {
    const transcript = await runScenario(() => undefined);

    expect(transcript.map((s) => [s.step, s.isError])).toEqual([
      ['register-coordinator', false],
      ['register-contributor', false],
      ['act-as-coordinator', false],
      ['create-workspace', false],
      ['join-workspace', false],
      ['create-proposal', false],
      ['review-proposal', false],
      ['merge-proposal-as-coordinator', false],
      ['merge-proposal-as-contributor', true],
      ['transfer-coordinator', false],
      ['implicit-mutation', true],
    ]);
  });
});
