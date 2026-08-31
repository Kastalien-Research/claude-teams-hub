import { describe, it, expect } from 'vitest';
import { scopesOverlap } from '../domain/reducer.js';
import { impactId, intentKey } from '../domain/state.js';
import type { ImpactV1, WorkIntentV1 } from '../domain/state.js';
import { buildCommand, createTestCell } from './helpers.js';

function setupWorkspace(members: string[] = ['bob', 'carol']) {
  const cell = createTestCell();
  cell.accept(
    buildCommand({ operation: 'create_workspace', actorId: 'alice', payload: { name: 'W', description: 'd' } }),
  );
  for (const agentId of members) {
    cell.accept(buildCommand({ operation: 'join_workspace', actorId: agentId, payload: {} }));
  }
  return cell;
}

function createProblem(cell: ReturnType<typeof createTestCell>, actorId: string, title: string): string {
  const outcome = cell.accept(
    buildCommand({ operation: 'create_problem', actorId, payload: { title, description: 'D' } }),
  );
  return (outcome.result.problem as unknown as { id: string }).id;
}

describe('scopesOverlap', () => {
  it.each([
    ['a/b', 'a/b/c', true], // descendant
    ['a/b', 'a', true], // ancestor
    ['a/b', 'a/b', true], // exact
    ['a/b', 'a/bc', false], // not a segment match
    ['a', 'a/b/c', true],
    ['x', 'y', false],
  ] as const)('scopesOverlap(%s, %s) === %s', (a, b, expected) => {
    expect(scopesOverlap(a, b)).toBe(expected);
  });

  it('normalizes leading and trailing slashes', () => {
    expect(scopesOverlap('/a/b/', 'a/b')).toBe(true);
    expect(scopesOverlap('/a/b/', 'a/b/c/')).toBe(true);
    expect(scopesOverlap('/a/bc/', 'a/b')).toBe(false);
  });

  it('is symmetric', () => {
    expect(scopesOverlap('a/b/c', 'a/b')).toBe(scopesOverlap('a/b', 'a/b/c'));
  });
});

describe('reducer — declare_work_intent', () => {
  it('rejects VALIDATION_FAILED when context.teamRunId is missing', () => {
    const cell = setupWorkspace();
    const problemId = createProblem(cell, 'alice', 'P1');
    const outcome = cell.reject(
      buildCommand({
        operation: 'declare_work_intent',
        actorId: 'bob',
        payload: { problemId, leaseUntil: '2099-01-01T00:00:00.000Z' },
      }),
    );
    expect(outcome.rejection.code).toBe('VALIDATION_FAILED');
  });

  it('rejects NOT_FOUND for an unknown problem', () => {
    const cell = setupWorkspace();
    const outcome = cell.reject(
      buildCommand({
        operation: 'declare_work_intent',
        actorId: 'bob',
        context: { teamRunId: 'run-1' },
        payload: { problemId: 'prob:nonexistent', leaseUntil: '2099-01-01T00:00:00.000Z' },
      }),
    );
    expect(outcome.rejection.code).toBe('NOT_FOUND');
  });

  it('first declare produces generation 1 with intentId `int:<agentId>:<problemId>`', () => {
    const cell = setupWorkspace();
    const problemId = createProblem(cell, 'alice', 'P1');
    const outcome = cell.accept(
      buildCommand({
        operation: 'declare_work_intent',
        actorId: 'bob',
        context: { teamRunId: 'run-1' },
        payload: { problemId, leaseUntil: '2099-01-01T00:00:00.000Z', writeScopes: ['x/y'] },
      }),
    );
    const intent = outcome.result.intent as unknown as WorkIntentV1;
    expect(intent.generation).toBe(1);
    expect(intent.intentId).toBe(`int:bob:${problemId}`);
    expect(intent.intentId).toBe(intentKey('bob', problemId));
    expect(outcome.events[0]?.type).toBe('work_intent_declared');
  });

  it('re-declaring the same (agent, problem) bumps generation, preserves declaredAt, updates updatedAt, and replaces scopes', () => {
    const cell = setupWorkspace();
    const problemId = createProblem(cell, 'alice', 'P1');
    const first = cell.accept(
      buildCommand({
        operation: 'declare_work_intent',
        actorId: 'bob',
        context: { teamRunId: 'run-1' },
        payload: { problemId, leaseUntil: '2099-01-01T00:00:00.000Z', writeScopes: ['x/y'] },
      }),
    );
    const firstIntent = first.result.intent as unknown as WorkIntentV1;

    const second = cell.accept(
      buildCommand({
        operation: 'declare_work_intent',
        actorId: 'bob',
        context: { teamRunId: 'run-1' },
        payload: { problemId, leaseUntil: '2099-01-01T00:00:00.000Z', writeScopes: ['a/different/scope'] },
      }),
    );
    const secondIntent = second.result.intent as unknown as WorkIntentV1;

    expect(secondIntent.generation).toBe(2);
    expect(secondIntent.intentId).toBe(firstIntent.intentId);
    expect(secondIntent.declaredAt).toBe(firstIntent.declaredAt);
    expect(secondIntent.updatedAt).not.toBe(firstIntent.updatedAt);
    expect(secondIntent.writeScopes).toEqual(['a/different/scope']);
  });
});

describe('reducer — record_work_change impact matching', () => {
  it('never matches the change author’s own intent', () => {
    const cell = setupWorkspace([]);
    const problemId = createProblem(cell, 'alice', 'P1');
    cell.accept(
      buildCommand({
        operation: 'declare_work_intent',
        actorId: 'alice',
        context: { teamRunId: 'run-1' },
        payload: { problemId, leaseUntil: '2099-01-01T00:00:00.000Z', writeScopes: ['x/y'] },
      }),
    );
    const outcome = cell.accept(
      buildCommand({
        operation: 'record_work_change',
        actorId: 'alice',
        payload: { kind: 'refactor', summary: 's', severity: 'blocking', scopes: ['x/y'] },
      }),
    );
    expect(outcome.result.impactCount).toBe(0);
    expect(outcome.result.impactIds).toEqual([]);
    expect(outcome.events).toHaveLength(1);
    expect(outcome.events[0]?.type).toBe('work_change_recorded');
  });

  it('does not match an intent whose lease has already expired at the change’s issuedAt', () => {
    const cell = setupWorkspace();
    const problemId = createProblem(cell, 'alice', 'P1');
    cell.accept(
      buildCommand({
        operation: 'declare_work_intent',
        actorId: 'bob',
        context: { teamRunId: 'run-1' },
        payload: { problemId, leaseUntil: '2000-01-01T00:00:00.000Z', writeScopes: ['x/y'] },
      }),
    );
    const outcome = cell.accept(
      buildCommand({
        operation: 'record_work_change',
        actorId: 'alice',
        payload: { kind: 'refactor', summary: 's', severity: 'blocking', scopes: ['x/y'] },
      }),
    );
    expect(outcome.result.impactCount).toBe(0);
  });

  it('matches on contractRef exact equality, recording the exact matching reason', () => {
    const cell = setupWorkspace();
    const problemId = createProblem(cell, 'alice', 'P1');
    cell.accept(
      buildCommand({
        operation: 'declare_work_intent',
        actorId: 'bob',
        context: { teamRunId: 'run-1' },
        payload: { problemId, leaseUntil: '2099-01-01T00:00:00.000Z', contractRefs: ['contract-x'] },
      }),
    );
    const outcome = cell.accept(
      buildCommand({
        operation: 'record_work_change',
        actorId: 'alice',
        payload: { kind: 'refactor', summary: 's', severity: 'blocking', contractRefs: ['contract-x'] },
      }),
    );
    expect(outcome.result.impactCount).toBe(1);
    const impact = Object.values(outcome.state.impacts)[0];
    expect(impact?.matchingReasons).toEqual([{ kind: 'contractRef', source: 'contract-x', target: 'contract-x' }]);
  });

  it('matches on assumptionId exact equality, recording the exact matching reason', () => {
    const cell = setupWorkspace();
    const problemId = createProblem(cell, 'alice', 'P1');
    cell.accept(
      buildCommand({
        operation: 'declare_work_intent',
        actorId: 'bob',
        context: { teamRunId: 'run-1' },
        payload: { problemId, leaseUntil: '2099-01-01T00:00:00.000Z', assumptionIds: ['assume-1'] },
      }),
    );
    const outcome = cell.accept(
      buildCommand({
        operation: 'record_work_change',
        actorId: 'alice',
        payload: { kind: 'refactor', summary: 's', severity: 'advisory', assumptionIds: ['assume-1'] },
      }),
    );
    expect(outcome.result.impactCount).toBe(1);
    const impact = Object.values(outcome.state.impacts)[0];
    expect(impact?.matchingReasons).toEqual([{ kind: 'assumptionId', source: 'assume-1', target: 'assume-1' }]);
  });

  it('matches on scope overlap (descendant), recording the scope matching reason', () => {
    const cell = setupWorkspace();
    const problemId = createProblem(cell, 'alice', 'P1');
    cell.accept(
      buildCommand({
        operation: 'declare_work_intent',
        actorId: 'bob',
        context: { teamRunId: 'run-1' },
        payload: { problemId, leaseUntil: '2099-01-01T00:00:00.000Z', writeScopes: ['a/b'] },
      }),
    );
    const outcome = cell.accept(
      buildCommand({
        operation: 'record_work_change',
        actorId: 'alice',
        payload: { kind: 'refactor', summary: 's', severity: 'blocking', scopes: ['a/b/c'] },
      }),
    );
    expect(outcome.result.impactCount).toBe(1);
    const impact = Object.values(outcome.state.impacts)[0];
    expect(impact?.matchingReasons).toEqual([{ kind: 'scope', source: 'a/b/c', target: 'a/b' }]);
  });

  it('matches on both read and write scopes of the intent', () => {
    const cell = setupWorkspace();
    const problemId = createProblem(cell, 'alice', 'P1');
    cell.accept(
      buildCommand({
        operation: 'declare_work_intent',
        actorId: 'bob',
        context: { teamRunId: 'run-1' },
        payload: { problemId, leaseUntil: '2099-01-01T00:00:00.000Z', readScopes: ['read/scope'] },
      }),
    );
    const outcome = cell.accept(
      buildCommand({
        operation: 'record_work_change',
        actorId: 'alice',
        payload: { kind: 'refactor', summary: 's', severity: 'advisory', scopes: ['read/scope'] },
      }),
    );
    expect(outcome.result.impactCount).toBe(1);
  });

  it('produces exactly one impact per (changeId, targetAgentId, generation) even with multiple matching reasons', () => {
    const cell = setupWorkspace();
    const problemId = createProblem(cell, 'alice', 'P1');
    cell.accept(
      buildCommand({
        operation: 'declare_work_intent',
        actorId: 'bob',
        context: { teamRunId: 'run-1' },
        payload: {
          problemId,
          leaseUntil: '2099-01-01T00:00:00.000Z',
          writeScopes: ['x/y'],
          contractRefs: ['contract-x'],
        },
      }),
    );
    const outcome = cell.accept(
      buildCommand({
        operation: 'record_work_change',
        actorId: 'alice',
        payload: { kind: 'refactor', summary: 's', severity: 'blocking', scopes: ['x/y'], contractRefs: ['contract-x'] },
      }),
    );
    expect(outcome.result.impactCount).toBe(1);
    const impact = Object.values(outcome.state.impacts)[0];
    expect(impact?.matchingReasons).toHaveLength(2);
    expect(impact?.matchingReasons.map(r => r.kind).sort()).toEqual(['contractRef', 'scope']);
  });

  it('rejects VALIDATION_FAILED when leaseUntil is not a parseable timestamp', () => {
    const cell = setupWorkspace();
    const problemId = createProblem(cell, 'alice', 'P1');
    const outcome = cell.reject(
      buildCommand({
        operation: 'declare_work_intent',
        actorId: 'bob',
        context: { teamRunId: 'run-1' },
        payload: { problemId, leaseUntil: 'tomorrow', writeScopes: ['x/y'] },
      }),
    );
    expect(outcome.rejection.code).toBe('VALIDATION_FAILED');
    expect(outcome.rejection.message).toContain('leaseUntil');
  });

  it('one change hitting one agent’s gen-1 intents on two problems produces two distinct impacts', () => {
    const cell = setupWorkspace();
    const problemA = createProblem(cell, 'alice', 'PA');
    const problemB = createProblem(cell, 'alice', 'PB');
    for (const problemId of [problemA, problemB]) {
      cell.accept(
        buildCommand({
          operation: 'declare_work_intent',
          actorId: 'bob',
          context: { teamRunId: 'run-1' },
          payload: { problemId, leaseUntil: '2099-01-01T00:00:00.000Z', writeScopes: ['x/y'] },
        }),
      );
    }
    const outcome = cell.accept(
      buildCommand({
        operation: 'record_work_change',
        actorId: 'alice',
        payload: { kind: 'refactor', summary: 's', severity: 'blocking', scopes: ['x/y'] },
      }),
    );
    expect(outcome.result.impactCount).toBe(2);
    const impactIds = outcome.result.impactIds as string[];
    expect(new Set(impactIds).size).toBe(2);
    const targets = impactIds
      .map(id => (outcome.state.impacts[id] as ImpactV1).targetProblemId)
      .sort();
    expect(targets).toEqual([problemA, problemB].sort());
    // Each impact carries only its own intent's matching reasons.
    for (const id of impactIds) {
      expect((outcome.state.impacts[id] as ImpactV1).matchingReasons).toHaveLength(1);
    }
  });

  it('every impacted problem blocks completion until its own impact is acknowledged', () => {
    const cell = setupWorkspace();
    const problemA = createProblem(cell, 'alice', 'PA');
    const problemB = createProblem(cell, 'alice', 'PB');
    for (const problemId of [problemA, problemB]) {
      cell.accept(
        buildCommand({
          operation: 'declare_work_intent',
          actorId: 'bob',
          context: { teamRunId: 'run-1' },
          payload: { problemId, leaseUntil: '2099-01-01T00:00:00.000Z', writeScopes: ['x/y'] },
        }),
      );
    }
    cell.accept(
      buildCommand({
        operation: 'record_work_change',
        actorId: 'alice',
        payload: { kind: 'refactor', summary: 's', severity: 'blocking', scopes: ['x/y'] },
      }),
    );
    // Pre-fix, the second problem's impact was merged into the first and PB
    // completed without acknowledgement — the RFC 0001 invariant this pins.
    for (const problemId of [problemA, problemB]) {
      const outcome = cell.reject(
        buildCommand({
          operation: 'update_problem',
          actorId: 'bob',
          payload: { problemId, status: 'resolved', resolution: 'r', intentGeneration: 1 },
        }),
      );
      expect(outcome.rejection.code).toBe('BLOCKING_IMPACT_UNACKNOWLEDGED');
    }
  });

  it('impactId is deterministic: imp:<changeId>:<targetAgentId>:<targetProblemId>:<intentGeneration>', () => {
    const cell = setupWorkspace();
    const problemId = createProblem(cell, 'alice', 'P1');
    cell.accept(
      buildCommand({
        operation: 'declare_work_intent',
        actorId: 'bob',
        context: { teamRunId: 'run-1' },
        payload: { problemId, leaseUntil: '2099-01-01T00:00:00.000Z', writeScopes: ['x/y'] },
      }),
    );
    const changeCommand = buildCommand({
      operation: 'record_work_change',
      actorId: 'alice',
      payload: { kind: 'refactor', summary: 's', severity: 'blocking', scopes: ['x/y'] },
    });
    const outcome = cell.accept(changeCommand);
    const changeId = (outcome.result.change as unknown as { changeId: string }).changeId;
    expect(changeId).toBe(`chg:${changeCommand.commandId}`);
    const expectedImpactId = impactId(changeId, 'bob', problemId, 1);
    expect(outcome.result.impactIds).toEqual([expectedImpactId]);
    expect(outcome.state.impacts[expectedImpactId]).toBeDefined();
  });

  it('copies severity from the change onto every impact it produces', () => {
    for (const severity of ['blocking', 'advisory'] as const) {
      const cell = setupWorkspace();
      const problemId = createProblem(cell, 'alice', 'P1');
      cell.accept(
        buildCommand({
          operation: 'declare_work_intent',
          actorId: 'bob',
          context: { teamRunId: 'run-1' },
          payload: { problemId, leaseUntil: '2099-01-01T00:00:00.000Z', writeScopes: ['x/y'] },
        }),
      );
      const outcome = cell.accept(
        buildCommand({
          operation: 'record_work_change',
          actorId: 'alice',
          payload: { kind: 'refactor', summary: 's', severity, scopes: ['x/y'] },
        }),
      );
      const impact = Object.values(outcome.state.impacts)[0] as ImpactV1;
      expect(impact.severity).toBe(severity);
    }
  });

  it('emits one work_change_recorded event followed by impact_detected events sorted by impactId', () => {
    const cell = setupWorkspace(); // members: bob, carol
    const problemId = createProblem(cell, 'alice', 'P1');
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
        context: { teamRunId: 'run-1' },
        payload: { problemId, leaseUntil: '2099-01-01T00:00:00.000Z', writeScopes: ['x/y'] },
      }),
    );
    const outcome = cell.accept(
      buildCommand({
        operation: 'record_work_change',
        actorId: 'alice',
        payload: { kind: 'refactor', summary: 's', severity: 'blocking', scopes: ['x/y'] },
      }),
    );
    expect(outcome.result.impactCount).toBe(2);
    expect(outcome.events).toHaveLength(3);
    expect(outcome.events[0]?.type).toBe('work_change_recorded');
    expect(outcome.events[1]?.type).toBe('impact_detected');
    expect(outcome.events[2]?.type).toBe('impact_detected');

    const impactIds = outcome.result.impactIds as string[];
    const sorted = [...impactIds].sort((a, b) => a.localeCompare(b));
    expect(impactIds).toEqual(sorted);
    const eventImpactIds = [outcome.events[1], outcome.events[2]].map(
      e => (e?.data.impact as unknown as ImpactV1).impactId,
    );
    expect(eventImpactIds).toEqual(sorted);
  });

  it('a change matching no intents produces only work_change_recorded, with impactCount 0', () => {
    const cell = setupWorkspace();
    const outcome = cell.accept(
      buildCommand({
        operation: 'record_work_change',
        actorId: 'alice',
        payload: { kind: 'refactor', summary: 's', severity: 'blocking', scopes: ['unrelated/scope'] },
      }),
    );
    expect(outcome.result.impactCount).toBe(0);
    expect(outcome.result.impactIds).toEqual([]);
    expect(outcome.events).toHaveLength(1);
    expect(outcome.events[0]?.type).toBe('work_change_recorded');
  });
});

describe('reducer — acknowledge_impact', () => {
  function setupPendingImpact(cell: ReturnType<typeof createTestCell>) {
    const problemId = createProblem(cell, 'alice', 'P1');
    cell.accept(
      buildCommand({
        operation: 'declare_work_intent',
        actorId: 'bob',
        context: { teamRunId: 'run-1' },
        payload: { problemId, leaseUntil: '2099-01-01T00:00:00.000Z', writeScopes: ['x/y'] },
      }),
    );
    const changeOutcome = cell.accept(
      buildCommand({
        operation: 'record_work_change',
        actorId: 'alice',
        payload: { kind: 'refactor', summary: 's', severity: 'blocking', scopes: ['x/y'] },
      }),
    );
    const id = (changeOutcome.result.impactIds as string[])[0];
    if (id === undefined) throw new Error('expected an impact to have been produced');
    return id;
  }

  it('rejects VALIDATION_FAILED when a non-target agent attempts to acknowledge', () => {
    const cell = setupWorkspace();
    const impactIdValue = setupPendingImpact(cell);
    const outcome = cell.reject(
      buildCommand({ operation: 'acknowledge_impact', actorId: 'alice', payload: { impactId: impactIdValue, disposition: 'accepted' } }),
    );
    expect(outcome.rejection.code).toBe('VALIDATION_FAILED');
  });

  it('succeeds for the target agent, setting disposition/acknowledgedAt and emitting impact_acknowledged', () => {
    const cell = setupWorkspace();
    const impactIdValue = setupPendingImpact(cell);
    const command = buildCommand({
      operation: 'acknowledge_impact',
      actorId: 'bob',
      payload: { impactId: impactIdValue, disposition: 'accepted', note: 'fine' },
    });
    const outcome = cell.accept(command);
    const impact = outcome.state.impacts[impactIdValue] as ImpactV1;
    expect(impact.status).toBe('acknowledged');
    expect(impact.disposition).toBe('accepted');
    expect(impact.acknowledgedAt).toBe(command.issuedAt);
    expect(impact.note).toBe('fine');
    expect(outcome.events[0]?.type).toBe('impact_acknowledged');
  });

  it('rejects a second acknowledgement of the same impact with VALIDATION_FAILED', () => {
    const cell = setupWorkspace();
    const impactIdValue = setupPendingImpact(cell);
    cell.accept(
      buildCommand({ operation: 'acknowledge_impact', actorId: 'bob', payload: { impactId: impactIdValue, disposition: 'accepted' } }),
    );
    const outcome = cell.reject(
      buildCommand({ operation: 'acknowledge_impact', actorId: 'bob', payload: { impactId: impactIdValue, disposition: 'not_applicable' } }),
    );
    expect(outcome.rejection.code).toBe('VALIDATION_FAILED');
  });

  it('rejects NOT_FOUND for an unknown impactId', () => {
    const cell = setupWorkspace();
    const outcome = cell.reject(
      buildCommand({ operation: 'acknowledge_impact', actorId: 'bob', payload: { impactId: 'imp:nonexistent', disposition: 'accepted' } }),
    );
    expect(outcome.rejection.code).toBe('NOT_FOUND');
  });
});
