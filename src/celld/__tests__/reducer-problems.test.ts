import { describe, it, expect } from 'vitest';
import { buildCommand, createTestCell, type AcceptedOutcome } from './helpers.js';
import type { CellProblem } from '../domain/state.js';

/** alice (coordinator) + bob (contributor), no problems yet. */
function setupWorkspace() {
  const cell = createTestCell();
  cell.accept(
    buildCommand({ operation: 'create_workspace', actorId: 'alice', payload: { name: 'W', description: 'd' } }),
  );
  cell.accept(buildCommand({ operation: 'join_workspace', actorId: 'bob', payload: {} }));
  return cell;
}

function createProblem(cell: ReturnType<typeof createTestCell>, actorId = 'alice'): { outcome: AcceptedOutcome; problemId: string } {
  const outcome = cell.accept(
    buildCommand({ operation: 'create_problem', actorId, payload: { title: 'T', description: 'D' } }),
  );
  const problem = outcome.result.problem as unknown as CellProblem;
  return { outcome, problemId: problem.id };
}

describe('reducer — create_problem', () => {
  it('assigns id `prob:<commandId>`, starts open with branchFromThought 0, emits problem_created', () => {
    const cell = setupWorkspace();
    const command = buildCommand({ operation: 'create_problem', actorId: 'alice', payload: { title: 'T', description: 'D' } });
    const outcome = cell.accept(command);

    const problem = outcome.result.problem as unknown as CellProblem;
    expect(problem.id).toBe(`prob:${command.commandId}`);
    expect(problem.status).toBe('open');
    expect(problem.branchFromThought).toBe(0);
    expect(problem.assignedTo).toBeUndefined();
    expect(outcome.events).toHaveLength(1);
    expect(outcome.events[0]?.type).toBe('problem_created');
    expect(outcome.state.problems[problem.id]).toBeDefined();
    expect(outcome.state.channels[problem.id]).toEqual([]);
  });
});

describe('reducer — claim_problem', () => {
  it('on success, sets assignedTo/in-progress/branchId (default `<actorId>/<problemId>`) and emits problem_claimed', () => {
    const cell = setupWorkspace();
    const { problemId } = createProblem(cell);
    const outcome = cell.accept(
      buildCommand({ operation: 'claim_problem', actorId: 'bob', payload: { problemId } }),
    );

    const problem = outcome.result.problem as unknown as CellProblem;
    expect(problem.assignedTo).toBe('bob');
    expect(problem.status).toBe('in-progress');
    expect(problem.branchId).toBe(`bob/${problemId}`);
    expect(outcome.result.branchId).toBe(`bob/${problemId}`);
    expect(outcome.result.branchFromThought).toBe(0);
    expect(outcome.events).toHaveLength(1);
    expect(outcome.events[0]?.type).toBe('problem_claimed');
  });

  it('honors an explicit branchId payload instead of the default', () => {
    const cell = setupWorkspace();
    const { problemId } = createProblem(cell);
    const outcome = cell.accept(
      buildCommand({ operation: 'claim_problem', actorId: 'bob', payload: { problemId, branchId: 'custom/branch' } }),
    );
    expect(outcome.result.branchId).toBe('custom/branch');
  });

  it('rejects a second claim by another agent with PROBLEM_ALREADY_CLAIMED, details carrying assignedTo', () => {
    const cell = setupWorkspace();
    const { problemId } = createProblem(cell);
    cell.accept(buildCommand({ operation: 'claim_problem', actorId: 'bob', payload: { problemId } }));

    const outcome = cell.reject(
      buildCommand({ operation: 'claim_problem', actorId: 'alice', payload: { problemId } }),
    );
    expect(outcome.rejection.code).toBe('PROBLEM_ALREADY_CLAIMED');
    expect(outcome.rejection.details).toEqual({ problemId, assignedTo: 'bob' });
  });

  it('rejects claiming a resolved problem with VALIDATION_FAILED', () => {
    const cell = setupWorkspace();
    const { problemId } = createProblem(cell);
    cell.accept(buildCommand({ operation: 'claim_problem', actorId: 'bob', payload: { problemId } }));
    cell.accept(
      buildCommand({ operation: 'update_problem', actorId: 'bob', payload: { problemId, status: 'resolved' } }),
    );

    const outcome = cell.reject(
      buildCommand({ operation: 'claim_problem', actorId: 'alice', payload: { problemId } }),
    );
    expect(outcome.rejection.code).toBe('VALIDATION_FAILED');
  });

  it('rejects claiming an unknown problem with NOT_FOUND', () => {
    const cell = setupWorkspace();
    const outcome = cell.reject(
      buildCommand({ operation: 'claim_problem', actorId: 'bob', payload: { problemId: 'prob:nonexistent' } }),
    );
    expect(outcome.rejection.code).toBe('NOT_FOUND');
    expect(outcome.rejection.details).toEqual({ problemId: 'prob:nonexistent' });
  });
});

describe('reducer — post_message', () => {
  it('appends a message with id `msg:<commandId>` and timestamp = command.issuedAt', () => {
    const cell = setupWorkspace();
    const { problemId } = createProblem(cell);
    const command = buildCommand({ operation: 'post_message', actorId: 'bob', payload: { problemId, content: 'hello' } });
    const outcome = cell.accept(command);

    expect(outcome.state.channels[problemId]).toHaveLength(1);
    const message = outcome.state.channels[problemId]?.[0];
    expect(message?.id).toBe(`msg:${command.commandId}`);
    expect(message?.timestamp).toBe(command.issuedAt);
    expect(message?.content).toBe('hello');
    expect(message?.agentId).toBe('bob');
    expect(outcome.events[0]?.type).toBe('message_posted');
  });

  it('rejects posting to an unknown problem with NOT_FOUND', () => {
    const cell = setupWorkspace();
    const outcome = cell.reject(
      buildCommand({ operation: 'post_message', actorId: 'bob', payload: { problemId: 'prob:nonexistent', content: 'hi' } }),
    );
    expect(outcome.rejection.code).toBe('NOT_FOUND');
  });
});

describe('reducer — update_problem completion gates', () => {
  // Bob claims and declares a work intent over a scope + contract that alice's
  // change will overlap; the impact this produces targets bob.
  function setupClaimedProblemWithIntent(cell: ReturnType<typeof createTestCell>) {
    const { problemId } = createProblem(cell, 'alice');
    cell.accept(buildCommand({ operation: 'claim_problem', actorId: 'bob', payload: { problemId } }));
    const declareOutcome = cell.accept(
      buildCommand({
        operation: 'declare_work_intent',
        actorId: 'bob',
        context: { teamRunId: 'run-1' },
        payload: {
          problemId,
          leaseUntil: '2099-01-01T00:00:00.000Z',
          writeScopes: ['payments/checkout'],
          contractRefs: ['contract-a'],
        },
      }),
    );
    return { problemId, generation: (declareOutcome.result.intent as { generation: number }).generation };
  }

  it('rejects completion with a missing intentGeneration as WORK_INTENT_GENERATION_STALE', () => {
    const cell = setupWorkspace();
    const { problemId } = setupClaimedProblemWithIntent(cell);
    const outcome = cell.reject(
      buildCommand({ operation: 'update_problem', actorId: 'bob', payload: { problemId, status: 'resolved' } }),
    );
    expect(outcome.rejection.code).toBe('WORK_INTENT_GENERATION_STALE');
  });

  it('rejects completion with a stale intentGeneration as WORK_INTENT_GENERATION_STALE', () => {
    const cell = setupWorkspace();
    const { problemId } = setupClaimedProblemWithIntent(cell);
    const outcome = cell.reject(
      buildCommand({
        operation: 'update_problem',
        actorId: 'bob',
        payload: { problemId, status: 'resolved', intentGeneration: 999 },
      }),
    );
    expect(outcome.rejection.code).toBe('WORK_INTENT_GENERATION_STALE');
    expect(outcome.rejection.details).toEqual({ citedGeneration: 999, currentGeneration: 1 });
  });

  it('rejects completion with the correct generation but a pending blocking impact as BLOCKING_IMPACT_UNACKNOWLEDGED', () => {
    const cell = setupWorkspace();
    const { problemId, generation } = setupClaimedProblemWithIntent(cell);

    // Alice (a different agent) records a blocking change overlapping bob's
    // declared writeScope, which must generate a blocking impact on bob.
    const changeOutcome = cell.accept(
      buildCommand({
        operation: 'record_work_change',
        actorId: 'alice',
        payload: {
          kind: 'refactor',
          summary: 'moved checkout scope',
          severity: 'blocking',
          scopes: ['payments/checkout'],
        },
      }),
    );
    expect(changeOutcome.result.impactCount).toBe(1);
    const impactIds = changeOutcome.result.impactIds as string[];

    const outcome = cell.reject(
      buildCommand({
        operation: 'update_problem',
        actorId: 'bob',
        payload: { problemId, status: 'resolved', intentGeneration: generation },
      }),
    );
    expect(outcome.rejection.code).toBe('BLOCKING_IMPACT_UNACKNOWLEDGED');
    expect(outcome.rejection.details).toEqual({ impactIds });
  });

  it('succeeds after the blocking impact is acknowledged, storing resolution/output and emitting problem_status_changed', () => {
    const cell = setupWorkspace();
    const { problemId, generation } = setupClaimedProblemWithIntent(cell);
    const changeOutcome = cell.accept(
      buildCommand({
        operation: 'record_work_change',
        actorId: 'alice',
        payload: {
          kind: 'refactor',
          summary: 'moved checkout scope',
          severity: 'blocking',
          scopes: ['payments/checkout'],
        },
      }),
    );
    const impactId = (changeOutcome.result.impactIds as string[])[0];
    expect(impactId).toBeDefined();
    if (impactId === undefined) throw new Error('unreachable');

    cell.accept(
      buildCommand({ operation: 'acknowledge_impact', actorId: 'bob', payload: { impactId, disposition: 'accepted' } }),
    );

    const outcome = cell.accept(
      buildCommand({
        operation: 'update_problem',
        actorId: 'bob',
        payload: { problemId, status: 'resolved', resolution: 'done', output: { paymentMethodIdType: 'card' }, intentGeneration: generation },
      }),
    );
    const problem = outcome.result.problem as unknown as CellProblem;
    expect(problem.status).toBe('resolved');
    expect(problem.resolution).toBe('done');
    expect(problem.output).toEqual({ paymentMethodIdType: 'card' });
    expect(outcome.events[0]?.type).toBe('problem_status_changed');
  });

  it('advisory impacts do not block completion', () => {
    const cell = setupWorkspace();
    const { problemId, generation } = setupClaimedProblemWithIntent(cell);
    const changeOutcome = cell.accept(
      buildCommand({
        operation: 'record_work_change',
        actorId: 'alice',
        payload: {
          kind: 'refactor',
          summary: 'moved checkout scope',
          severity: 'advisory',
          scopes: ['payments/checkout'],
        },
      }),
    );
    expect(changeOutcome.result.impactCount).toBe(1);

    const outcome = cell.accept(
      buildCommand({
        operation: 'update_problem',
        actorId: 'bob',
        payload: { problemId, status: 'resolved', intentGeneration: generation },
      }),
    );
    expect(outcome.ok).toBe(true);
  });

  it('an actor with no intent for the problem completes without any generation gate', () => {
    const cell = setupWorkspace();
    const { problemId } = createProblem(cell, 'alice');
    // alice created the problem but never declared a work intent on it.
    const outcome = cell.accept(
      buildCommand({ operation: 'update_problem', actorId: 'alice', payload: { problemId, status: 'resolved' } }),
    );
    expect(outcome.ok).toBe(true);
  });
});
