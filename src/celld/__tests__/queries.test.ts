import { describe, it, expect } from 'vitest';
import { query } from '../domain/queries.js';
import type { CellProblem, ImpactV1 } from '../domain/state.js';
import { buildCommand, createTestCell } from './helpers.js';

const QUERY_OPS = ['list_problems', 'read_channel', 'list_impacts', 'workspace_status', 'workspace_digest'];

function setupWorkspace(members: string[] = ['bob']) {
  const cell = createTestCell();
  cell.accept(
    buildCommand({ operation: 'create_workspace', actorId: 'alice', payload: { name: 'W', description: 'd' } }),
  );
  for (const agentId of members) {
    cell.accept(buildCommand({ operation: 'join_workspace', actorId: agentId, payload: {} }));
  }
  return cell;
}

describe('query — null state', () => {
  it.each(QUERY_OPS)('rejects %s with WORKSPACE_NOT_INITIALIZED', operation => {
    const outcome = query(null, operation, 'alice', {});
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.rejection.code).toBe('WORKSPACE_NOT_INITIALIZED');
  });
});

describe('query — membership gate', () => {
  it.each(QUERY_OPS)('rejects %s from a non-member with NOT_WORKSPACE_MEMBER', operation => {
    const cell = setupWorkspace();
    const outcome = query(cell.state(), operation, 'mallory', {});
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.rejection.code).toBe('NOT_WORKSPACE_MEMBER');
  });
});

describe('query — list_problems', () => {
  it('returns problems in stable createdAt/id order when unfiltered', () => {
    const cell = setupWorkspace();
    const p1 = cell.accept(buildCommand({ operation: 'create_problem', actorId: 'alice', payload: { title: 'P1', description: 'd' } }));
    const p2 = cell.accept(buildCommand({ operation: 'create_problem', actorId: 'alice', payload: { title: 'P2', description: 'd' } }));
    const p3 = cell.accept(buildCommand({ operation: 'create_problem', actorId: 'alice', payload: { title: 'P3', description: 'd' } }));
    const ids = [p1, p2, p3].map(o => (o.result.problem as unknown as CellProblem).id);

    const outcome = query(cell.state(), 'list_problems', 'alice', {});
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.result.count).toBe(3);
    const problems = outcome.result.problems as unknown as CellProblem[];
    expect(problems.map(p => p.id)).toEqual(ids);
  });

  it('filters by status', () => {
    const cell = setupWorkspace();
    const p1 = cell.accept(buildCommand({ operation: 'create_problem', actorId: 'alice', payload: { title: 'P1', description: 'd' } }));
    const problem1Id = (p1.result.problem as unknown as CellProblem).id;
    cell.accept(buildCommand({ operation: 'create_problem', actorId: 'alice', payload: { title: 'P2', description: 'd' } }));
    cell.accept(buildCommand({ operation: 'claim_problem', actorId: 'bob', payload: { problemId: problem1Id } }));

    const outcome = query(cell.state(), 'list_problems', 'alice', { status: 'in-progress' });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.result.count).toBe(1);
    const problems = outcome.result.problems as unknown as CellProblem[];
    expect(problems[0]?.id).toBe(problem1Id);
  });

  it('returns an empty list for a status with no matching problems', () => {
    const cell = setupWorkspace();
    cell.accept(buildCommand({ operation: 'create_problem', actorId: 'alice', payload: { title: 'P1', description: 'd' } }));
    const outcome = query(cell.state(), 'list_problems', 'alice', { status: 'closed' });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.result.count).toBe(0);
    expect(outcome.result.problems).toEqual([]);
  });
});

describe('query — read_channel', () => {
  it('returns all messages and counts when no limit is given', () => {
    const cell = setupWorkspace();
    const p = cell.accept(buildCommand({ operation: 'create_problem', actorId: 'alice', payload: { title: 'P1', description: 'd' } }));
    const problemId = (p.result.problem as unknown as CellProblem).id;
    for (let i = 0; i < 5; i++) {
      cell.accept(buildCommand({ operation: 'post_message', actorId: 'bob', payload: { problemId, content: `msg-${i}` } }));
    }

    const outcome = query(cell.state(), 'read_channel', 'alice', { problemId });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.result.count).toBe(5);
    expect(outcome.result.total).toBe(5);
  });

  it('applies limit by returning the most recent N messages', () => {
    const cell = setupWorkspace();
    const p = cell.accept(buildCommand({ operation: 'create_problem', actorId: 'alice', payload: { title: 'P1', description: 'd' } }));
    const problemId = (p.result.problem as unknown as CellProblem).id;
    for (let i = 0; i < 5; i++) {
      cell.accept(buildCommand({ operation: 'post_message', actorId: 'bob', payload: { problemId, content: `msg-${i}` } }));
    }

    const outcome = query(cell.state(), 'read_channel', 'alice', { problemId, limit: 2 });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.result.count).toBe(2);
    expect(outcome.result.total).toBe(5);
    const messages = outcome.result.messages as unknown as Array<{ content: string }>;
    expect(messages.map(m => m.content)).toEqual(['msg-3', 'msg-4']);
  });

  it('rejects an unknown problem with NOT_FOUND', () => {
    const cell = setupWorkspace();
    const outcome = query(cell.state(), 'read_channel', 'alice', { problemId: 'prob:nonexistent' });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.rejection.code).toBe('NOT_FOUND');
  });

  it('rejects a missing problemId with VALIDATION_FAILED', () => {
    const cell = setupWorkspace();
    const outcome = query(cell.state(), 'read_channel', 'alice', {});
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.rejection.code).toBe('VALIDATION_FAILED');
  });
});

describe('query — list_impacts', () => {
  function setupTwoImpacts(cell: ReturnType<typeof createTestCell>) {
    const p = cell.accept(buildCommand({ operation: 'create_problem', actorId: 'alice', payload: { title: 'P1', description: 'd' } }));
    const problemId = (p.result.problem as unknown as CellProblem).id;
    cell.accept(
      buildCommand({
        operation: 'declare_work_intent',
        actorId: 'bob',
        context: { teamRunId: 'run-1' },
        payload: { problemId, leaseUntil: '2099-01-01T00:00:00.000Z', writeScopes: ['x/y'] },
      }),
    );
    cell.accept(
      buildCommand({
        operation: 'declare_work_intent',
        actorId: 'carol',
        context: { teamRunId: 'run-2' },
        payload: { problemId, leaseUntil: '2099-01-01T00:00:00.000Z', writeScopes: ['x/y'] },
      }),
    );
    cell.accept(
      buildCommand({
        operation: 'record_work_change',
        actorId: 'alice',
        payload: { kind: 'refactor', summary: 's', severity: 'blocking', scopes: ['x/y'] },
      }),
    );
  }

  it('filters by targetAgentId', () => {
    const cell = setupWorkspace(['bob', 'carol']);
    setupTwoImpacts(cell);

    const outcome = query(cell.state(), 'list_impacts', 'alice', { targetAgentId: 'bob' });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.result.count).toBe(1);
    const impacts = outcome.result.impacts as unknown as ImpactV1[];
    expect(impacts[0]?.targetAgentId).toBe('bob');
  });

  it('filters by status', () => {
    const cell = setupWorkspace(['bob', 'carol']);
    setupTwoImpacts(cell);
    const bobImpactId = Object.values(cell.state()?.impacts ?? {}).find(i => i.targetAgentId === 'bob')?.impactId;
    expect(bobImpactId).toBeDefined();
    if (bobImpactId === undefined) return;
    cell.accept(
      buildCommand({ operation: 'acknowledge_impact', actorId: 'bob', payload: { impactId: bobImpactId, disposition: 'accepted' } }),
    );

    const pending = query(cell.state(), 'list_impacts', 'alice', { status: 'pending' });
    expect(pending.ok).toBe(true);
    if (pending.ok) {
      expect(pending.result.count).toBe(1);
      const impacts = pending.result.impacts as unknown as ImpactV1[];
      expect(impacts[0]?.targetAgentId).toBe('carol');
    }

    const acknowledged = query(cell.state(), 'list_impacts', 'alice', { status: 'acknowledged' });
    expect(acknowledged.ok).toBe(true);
    if (acknowledged.ok) {
      expect(acknowledged.result.count).toBe(1);
      const impacts = acknowledged.result.impacts as unknown as ImpactV1[];
      expect(impacts[0]?.targetAgentId).toBe('bob');
    }
  });

  it('returns all impacts when unfiltered', () => {
    const cell = setupWorkspace(['bob', 'carol']);
    setupTwoImpacts(cell);
    const outcome = query(cell.state(), 'list_impacts', 'alice', {});
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.result.count).toBe(2);
  });
});

describe('query — workspace_status', () => {
  it('reports problem counts by status, member list, intent count, and pending impact count', () => {
    const cell = setupWorkspace(['bob', 'carol']);
    const p1 = cell.accept(buildCommand({ operation: 'create_problem', actorId: 'alice', payload: { title: 'P1', description: 'd' } }));
    const problem1Id = (p1.result.problem as unknown as CellProblem).id;
    cell.accept(buildCommand({ operation: 'create_problem', actorId: 'alice', payload: { title: 'P2', description: 'd' } }));
    cell.accept(buildCommand({ operation: 'claim_problem', actorId: 'bob', payload: { problemId: problem1Id } }));
    cell.accept(
      buildCommand({
        operation: 'declare_work_intent',
        actorId: 'bob',
        context: { teamRunId: 'run-1' },
        payload: { problemId: problem1Id, leaseUntil: '2099-01-01T00:00:00.000Z', writeScopes: ['x/y'] },
      }),
    );
    cell.accept(
      buildCommand({
        operation: 'record_work_change',
        actorId: 'alice',
        payload: { kind: 'refactor', summary: 's', severity: 'blocking', scopes: ['x/y'] },
      }),
    );

    const outcome = query(cell.state(), 'workspace_status', 'alice', {});
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.result.problemCount).toBe(2);
    expect(outcome.result.problemCounts).toEqual({ open: 1, 'in-progress': 1 });
    expect(outcome.result.intentCount).toBe(1);
    expect(outcome.result.pendingImpactCount).toBe(1);
    const members = outcome.result.members as unknown as Array<{ agentId: string }>;
    expect(members.map(m => m.agentId).sort()).toEqual(['alice', 'bob', 'carol']);
  });
});
