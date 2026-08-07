import { describe, it, expect } from 'vitest';
import { apply, reduce, type ReducerCommand } from '../domain/reducer.js';
import type { CellWorkspaceState } from '../domain/state.js';
import { buildCommand, createTestCell } from './helpers.js';

const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

function collectIsoStrings(value: unknown, out: Set<string>): void {
  if (typeof value === 'string') {
    if (ISO_TIMESTAMP.test(value)) out.add(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectIsoStrings(item, out);
    return;
  }
  if (value !== null && typeof value === 'object') {
    for (const v of Object.values(value)) collectIsoStrings(v, out);
  }
}

/**
 * Runs the RFC 0001 replay-invariant scenario:
 * create -> join x2 -> create_problem x3 -> claim -> post_message ->
 * declare intents x2 -> record change w/ impacts -> acknowledge -> update to resolved.
 *
 * Returns, per accepted command, the state immediately before it and the
 * accepted outcome — the exact pairing the replay invariant checks.
 */
function runReplayScenario() {
  const cell = createTestCell();
  const steps: Array<{ before: CellWorkspaceState | null; command: ReducerCommand; outcome: ReturnType<typeof cell.accept> }> = [];

  function step(command: ReducerCommand) {
    const before = cell.state();
    const outcome = cell.accept(command);
    steps.push({ before, command, outcome });
    return outcome;
  }

  step(buildCommand({ operation: 'create_workspace', actorId: 'alice', payload: { name: 'W', description: 'd' } }));
  step(buildCommand({ operation: 'join_workspace', actorId: 'bob', payload: {} }));
  step(buildCommand({ operation: 'join_workspace', actorId: 'carol', payload: {} }));

  const p1 = step(
    buildCommand({ operation: 'create_problem', actorId: 'alice', payload: { title: 'P1', description: 'd1' } }),
  );
  const problem1Id = (p1.result.problem as unknown as { id: string }).id;
  step(buildCommand({ operation: 'create_problem', actorId: 'alice', payload: { title: 'P2', description: 'd2' } }));
  const p3 = step(
    buildCommand({ operation: 'create_problem', actorId: 'alice', payload: { title: 'P3', description: 'd3' } }),
  );
  const problem3Id = (p3.result.problem as unknown as { id: string }).id;

  step(buildCommand({ operation: 'claim_problem', actorId: 'bob', payload: { problemId: problem1Id } }));
  step(buildCommand({ operation: 'post_message', actorId: 'bob', payload: { problemId: problem1Id, content: 'starting' } }));

  step(
    buildCommand({
      operation: 'declare_work_intent',
      actorId: 'bob',
      context: { teamRunId: 'run-1' },
      payload: { problemId: problem1Id, leaseUntil: '2099-01-01T00:00:00.000Z', writeScopes: ['x/y'] },
    }),
  );
  step(
    buildCommand({
      operation: 'declare_work_intent',
      actorId: 'carol',
      context: { teamRunId: 'run-2' },
      payload: { problemId: problem3Id, leaseUntil: '2099-01-01T00:00:00.000Z', writeScopes: ['x/y'] },
    }),
  );

  const change = step(
    buildCommand({
      operation: 'record_work_change',
      actorId: 'alice',
      payload: { kind: 'refactor', summary: 's', severity: 'blocking', scopes: ['x/y'] },
    }),
  );
  expect(change.result.impactCount).toBe(2);
  const bobImpactId = Object.values(change.state.impacts).find(i => i.targetAgentId === 'bob')?.impactId;
  if (bobImpactId === undefined) throw new Error('expected an impact targeting bob');

  step(
    buildCommand({ operation: 'acknowledge_impact', actorId: 'bob', payload: { impactId: bobImpactId, disposition: 'accepted' } }),
  );
  step(
    buildCommand({
      operation: 'update_problem',
      actorId: 'bob',
      payload: { problemId: problem1Id, status: 'resolved', intentGeneration: 1 },
    }),
  );

  return { cell, steps };
}

describe('reducer — replay invariant', () => {
  it('folding apply() over each command’s emitted events from its prior state reproduces its post-state', () => {
    const { steps } = runReplayScenario();
    expect(steps.length).toBeGreaterThanOrEqual(11);

    for (const { before, command, outcome } of steps) {
      let replayed = before;
      for (const event of outcome.events) {
        replayed = apply(replayed, event);
      }
      expect(replayed, `mismatch after replaying events for '${command.operation}' (${command.commandId})`).toEqual(
        outcome.state,
      );
    }
  });

  it('folding apply() over the entire event log from null reproduces the final state', () => {
    const { cell, steps } = runReplayScenario();
    let replayed: CellWorkspaceState | null = null;
    for (const { outcome } of steps) {
      for (const event of outcome.events) {
        replayed = apply(replayed, event);
      }
    }
    expect(replayed).toEqual(cell.state());
  });
});

describe('reducer — determinism', () => {
  it('calling reduce twice with the same (state, command, revision) yields deep-equal outcomes', () => {
    const cell = createTestCell();
    cell.accept(
      buildCommand({ operation: 'create_workspace', actorId: 'alice', payload: { name: 'W', description: 'd' } }),
    );
    const command = buildCommand({
      operation: 'create_problem',
      actorId: 'alice',
      payload: { title: 'T', description: 'D' },
    });
    const outcomeA = reduce(cell.state(), command, cell.revision());
    const outcomeB = reduce(cell.state(), command, cell.revision());
    expect(outcomeA).toEqual(outcomeB);
  });

  it('calling reduce twice for a rejection yields deep-equal outcomes', () => {
    const cell = createTestCell();
    cell.accept(
      buildCommand({ operation: 'create_workspace', actorId: 'alice', payload: { name: 'W', description: 'd' } }),
    );
    const command = buildCommand({ operation: 'create_problem', actorId: 'mallory', payload: {} });
    const outcomeA = reduce(cell.state(), command, cell.revision());
    const outcomeB = reduce(cell.state(), command, cell.revision());
    expect(outcomeA).toEqual(outcomeB);
    expect(outcomeA.ok).toBe(false);
  });

  it('every ISO timestamp anywhere in the final state is traceable to some accepted command', () => {
    const { cell, steps } = runReplayScenario();
    const allowed = new Set<string>();
    for (const { command } of steps) collectIsoStrings(command, allowed);

    const found = new Set<string>();
    collectIsoStrings(cell.state(), found);

    expect(found.size).toBeGreaterThan(0);
    for (const timestamp of found) {
      expect(allowed.has(timestamp), `timestamp ${timestamp} in final state was not derived from any command`).toBe(
        true,
      );
    }
  });
});
