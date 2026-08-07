/**
 * The celld canary gauntlet (RFC 0001 §Verification gates, race + recovery).
 *
 * One ordered scenario against the compose stack the globalSetup brought up.
 * Every step asserts raw facts (codes, counts, sequences) — the pass/fail
 * decision lives in these deterministic assertions, never in an agent's
 * opinion.
 */

import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { McpSession } from './mcp-client.js';
import { compose, httpOk, pollUntil, type StackConfig } from './stack.js';

const RUN = randomUUID().slice(0, 8);
const cmd = (label: string) => ({ id: `it-${RUN}-${label}`, teamRunId: `it-run-${RUN}` });

function config(): StackConfig {
  return {
    projectName: process.env.CELLD_IT_PROJECT as string,
    hubPort: parseInt((process.env.CELLD_IT_HUB_URL as string).split(':').pop() as string, 10),
    celldAPort: parseInt(process.env.CELLD_IT_A_PORT as string, 10),
    celldBPort: parseInt(process.env.CELLD_IT_B_PORT as string, 10),
    repoRoot: process.cwd(),
    evidenceDir: process.env.CELLD_IT_EVIDENCE_DIR as string,
  };
}
const image = () => process.env.CELLD_IT_IMAGE as string;
const hubUrl = () => process.env.CELLD_IT_HUB_URL as string;

interface EventRecord {
  sequence: number;
  aggregateRevision: number;
  type: string;
  eventId: string;
}

// Module-level scenario state, threaded through the ordered steps.
let alpha: McpSession;
let beta: McpSession;
let alphaId: string;
let betaId: string;
let workspaceId: string;
let problemId: string;
let winnerSession: McpSession;
let winnerAgentId: string;
let winnerClaimArgs: Record<string, unknown>;
let eventCountAfterClaim: number;

async function readEvents(session: McpSession, agentId: string): Promise<EventRecord[]> {
  const result = (await session.hub('readWorkspaceEvents', {
    agentId,
    workspaceId,
    after: 0,
    limit: 1000,
  })) as { events: EventRecord[] };
  return result.events;
}

describe('celld canary gauntlet', () => {
  it('1. creates a fresh celld workspace entirely through MCP', async () => {
    alpha = new McpSession(hubUrl());
    beta = new McpSession(hubUrl());
    await alpha.initialize('gauntlet-alpha');
    await beta.initialize('gauntlet-beta');

    alphaId = ((await alpha.hub('register', { name: `it-alpha-${RUN}` })) as { agentId: string }).agentId;
    betaId = ((await beta.hub('register', { name: `it-beta-${RUN}` })) as { agentId: string }).agentId;

    const created = (await alpha.hub('createWorkspace', {
      agentId: alphaId,
      name: `celld-it-${RUN}`,
      description: 'celld canary gauntlet workspace',
      backend: 'celld',
      command: cmd('create-ws'),
    })) as { workspaceId: string; mainSessionId: string; coordination: { backend: string; revision: number } };

    workspaceId = created.workspaceId;
    expect(created.mainSessionId).toBe(`celld:${workspaceId}`);
    expect(created.coordination.backend).toBe('celld');
    expect(created.coordination.revision).toBe(1);

    await beta.hub('joinWorkspace', { agentId: betaId, workspaceId, command: cmd('beta-join') });

    const problem = (await alpha.hub('createProblem', {
      agentId: alphaId,
      workspaceId,
      title: 'contention problem',
      description: 'both agents race to claim this',
      command: cmd('create-prob'),
    })) as { problem: { id: string } };
    problemId = problem.problem.id;
  });

  it('2+3. two independent sessions race one claim: exactly one success, one PROBLEM_ALREADY_CLAIMED', async () => {
    const alphaArgs = { agentId: alphaId, workspaceId, problemId, command: cmd('claim-alpha') };
    const betaArgs = { agentId: betaId, workspaceId, problemId, command: cmd('claim-beta') };
    const [alphaOutcome, betaOutcome] = await Promise.allSettled([
      alpha.hub('claimProblem', alphaArgs),
      beta.hub('claimProblem', betaArgs),
    ]);

    const outcomes = [
      { outcome: alphaOutcome, session: alpha, agentId: alphaId, args: alphaArgs },
      { outcome: betaOutcome, session: beta, agentId: betaId, args: betaArgs },
    ];
    const winners = outcomes.filter(o => o.outcome.status === 'fulfilled');
    const losers = outcomes.filter(o => o.outcome.status === 'rejected');
    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(1);
    const loserReason = (losers[0]?.outcome as PromiseRejectedResult).reason as Error & { code?: string };
    expect(loserReason.code).toBe('PROBLEM_ALREADY_CLAIMED');

    const winner = winners[0]!;
    winnerSession = winner.session;
    winnerAgentId = winner.agentId;
    winnerClaimArgs = winner.args;
    const claimResult = (winner.outcome as PromiseFulfilledResult<unknown>).value as {
      problem: { assignedTo: string };
      branchFromThought: number;
      coordination: { revision: number };
    };
    expect(claimResult.problem.assignedTo).toBe(winner.agentId);
    expect(claimResult.branchFromThought).toBe(0);

    eventCountAfterClaim = (await readEvents(alpha, alphaId)).length;
  });

  it('4. replaying the winner command canonically returns replayed:true and no new events', async () => {
    const replay = (await winnerSession.hub('claimProblem', winnerClaimArgs)) as {
      coordination: { replayed?: boolean; revision: number };
    };
    expect(replay.coordination.replayed).toBe(true);
    const events = await readEvents(alpha, alphaId);
    expect(events).toHaveLength(eventCountAfterClaim);
  });

  it('5. reusing the winner commandId with an altered payload yields IDEMPOTENCY_KEY_REUSED', async () => {
    await expect(
      winnerSession.hub('claimProblem', { ...winnerClaimArgs, branchId: 'altered/branch' }),
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_KEY_REUSED' });
    const events = await readEvents(alpha, alphaId);
    expect(events).toHaveLength(eventCountAfterClaim);
  });

  it('6. event sequences are unique, increasing, gap-free', async () => {
    const events = await readEvents(alpha, alphaId);
    expect(events.length).toBeGreaterThanOrEqual(4);
    events.forEach((event, index) => {
      expect(event.sequence).toBe(index + 1);
      expect(event.eventId).toBe(`${workspaceId}:${event.sequence}`);
    });
    const revisions = events.map(event => event.aggregateRevision);
    for (let i = 1; i < revisions.length; i++) {
      expect(revisions[i]! >= revisions[i - 1]!).toBe(true);
    }
  });

  it('7. channel post/read round-trips', async () => {
    await alpha.hub('postMessage', {
      agentId: alphaId,
      workspaceId,
      problemId,
      content: `gauntlet message ${RUN}`,
      command: cmd('post-1'),
    });
    const channel = (await beta.hub('readChannel', { agentId: betaId, workspaceId, problemId })) as {
      messages: Array<{ content: string; agentId: string }>;
    };
    expect(channel.messages.some(m => m.content === `gauntlet message ${RUN}` && m.agentId === alphaId)).toBe(true);
  });

  it('8+9. SIGKILL of celld-a: state survives via the empty second node and new mutations succeed', async () => {
    const cfg = config();
    const eventsBefore = await readEvents(alpha, alphaId);
    await compose(cfg, image(), ['kill', '-s', 'SIGKILL', 'celld-a']);

    // Recovery deadline: measured ~4s with CELLD_TTL_MS=5000 (probe 0.4); 30s is margin.
    await pollUntil('recovery via celld-b', 30_000, 1_000, async () => {
      const events = await readEvents(alpha, alphaId);
      return events.length === eventsBefore.length;
    });

    const events = await readEvents(alpha, alphaId);
    expect(events.map(e => e.eventId)).toEqual(eventsBefore.map(e => e.eventId));

    const afterRecovery = (await alpha.hub('postMessage', {
      agentId: alphaId,
      workspaceId,
      problemId,
      content: `post-recovery message ${RUN}`,
      command: cmd('post-recovery'),
    })) as { coordination: { revision: number } };
    expect(afterRecovery.coordination.revision).toBeGreaterThan(0);
  });

  it('10. both nodes down: unique mutation fails CELLD_UNAVAILABLE and the marker is never written anywhere', async () => {
    const cfg = config();
    await compose(cfg, image(), ['stop', 'celld-b']);
    // celld-a is already SIGKILLed; both nodes are now down.

    const markerTitle = `marker-problem-${RUN}`;
    await expect(
      alpha.hub('createProblem', {
        agentId: alphaId,
        workspaceId,
        title: markerTitle,
        description: 'must never exist',
        command: cmd('marker'),
      }),
    ).rejects.toMatchObject({ code: 'CELLD_UNAVAILABLE' });

    await compose(cfg, image(), ['start', 'celld-a']);
    await pollUntil('celld-a back', 60_000, 1_000, () => httpOk(`http://localhost:${cfg.celldAPort}/health`));
    await pollUntil('workspace served again', 30_000, 1_000, async () => (await readEvents(alpha, alphaId)).length > 0);

    // Marker absent from cell state...
    const problems = (await alpha.hub('listProblems', { agentId: alphaId, workspaceId })) as {
      problems: Array<{ title: string }>;
    };
    expect(problems.problems.some(p => p.title === markerTitle)).toBe(false);
    // ...absent from the event journal...
    const events = await readEvents(alpha, alphaId);
    expect(events.some(e => e.eventId.includes('marker'))).toBe(false);
    // ...and the hub NEVER wrote this workspace to filesystem storage. A
    // missing workspaces dir is the strongest form of absence — no fs
    // workspace was ever created in this stack.
    const { stdout } = await compose(cfg, image(), [
      'exec',
      '-T',
      'team-hub',
      'sh',
      '-c',
      'ls /data/hub/workspaces 2>/dev/null || true',
    ]);
    expect(stdout.includes(workspaceId)).toBe(false);

    await compose(cfg, image(), ['start', 'celld-b']);
  });
});
