import { describe, it, expect } from 'vitest';
import { reduce } from '../domain/reducer.js';
import { buildCommand, createTestCell } from './helpers.js';

describe('reducer — create_workspace', () => {
  it('initializes state on null state, making the creator a coordinator member', () => {
    const command = buildCommand({
      operation: 'create_workspace',
      actorId: 'alice',
      payload: { name: 'W', description: 'A workspace' },
    });
    const outcome = reduce(null, command, 0);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;

    expect(outcome.state.workspace.id).toBe(command.workspaceId);
    expect(outcome.state.workspace.name).toBe('W');
    expect(outcome.state.workspace.description).toBe('A workspace');
    const alice = outcome.state.members['alice'];
    expect(alice).toBeDefined();
    expect(alice?.role).toBe('coordinator');
    expect(alice?.joinedAt).toBe(command.issuedAt);
    expect(Object.keys(outcome.state.members)).toEqual(['alice']);

    expect(outcome.events).toHaveLength(1);
    expect(outcome.events[0]?.type).toBe('workspace_created');
    expect(outcome.result.workspaceId).toBe(command.workspaceId);
  });

  it('rejects VALIDATION_FAILED when the workspace is already initialized', () => {
    const cell = createTestCell();
    cell.accept(
      buildCommand({ operation: 'create_workspace', actorId: 'alice', payload: { name: 'W', description: 'd' } }),
    );

    const second = cell.reject(
      buildCommand({ operation: 'create_workspace', actorId: 'bob', payload: { name: 'W2', description: 'd2' } }),
    );
    expect(second.rejection.code).toBe('VALIDATION_FAILED');
  });
});

describe('reducer — membership gating', () => {
  it('rejects any non-create op on null state as WORKSPACE_NOT_INITIALIZED', () => {
    const ops = [
      'join_workspace',
      'create_problem',
      'claim_problem',
      'update_problem',
      'post_message',
      'declare_work_intent',
      'record_work_change',
      'acknowledge_impact',
    ];
    for (const operation of ops) {
      const outcome = reduce(null, buildCommand({ operation, actorId: 'alice', payload: {} }), 0);
      expect(outcome.ok, `operation ${operation} should be rejected on null state`).toBe(false);
      if (outcome.ok) continue;
      expect(outcome.rejection.code, `operation ${operation}`).toBe('WORKSPACE_NOT_INITIALIZED');
    }
  });

  it('rejects any non-create/join mutation from a non-member as NOT_WORKSPACE_MEMBER', () => {
    const cell = createTestCell();
    cell.accept(
      buildCommand({ operation: 'create_workspace', actorId: 'alice', payload: { name: 'W', description: 'd' } }),
    );

    const ops = [
      'create_problem',
      'claim_problem',
      'update_problem',
      'post_message',
      'declare_work_intent',
      'record_work_change',
      'acknowledge_impact',
    ];
    for (const operation of ops) {
      const outcome = cell.probe(buildCommand({ operation, actorId: 'mallory', payload: {} }));
      expect(outcome.ok, `operation ${operation} should be rejected`).toBe(false);
      if (outcome.ok) continue;
      expect(outcome.rejection.code, `operation ${operation}`).toBe('NOT_WORKSPACE_MEMBER');
      expect(outcome.rejection.details).toEqual({ agentId: 'mallory' });
    }
  });

  it('accepts join_workspace from a non-member, making them a contributor', () => {
    const cell = createTestCell();
    cell.accept(
      buildCommand({ operation: 'create_workspace', actorId: 'alice', payload: { name: 'W', description: 'd' } }),
    );
    const outcome = cell.accept(buildCommand({ operation: 'join_workspace', actorId: 'bob', payload: {} }));
    const bob = outcome.state.members['bob'];
    expect(bob).toBeDefined();
    expect(bob?.role).toBe('contributor');
    expect(outcome.events[0]?.type).toBe('workspace_joined');
  });

  it('rejects join_workspace from an existing member as ALREADY_WORKSPACE_MEMBER', () => {
    const cell = createTestCell();
    cell.accept(
      buildCommand({ operation: 'create_workspace', actorId: 'alice', payload: { name: 'W', description: 'd' } }),
    );
    const outcome = cell.reject(buildCommand({ operation: 'join_workspace', actorId: 'alice', payload: {} }));
    expect(outcome.rejection.code).toBe('ALREADY_WORKSPACE_MEMBER');
  });
});

describe('reducer — expectedRevision (optimistic concurrency)', () => {
  it('rejects a member mutation with a mismatched expectedRevision as REVISION_CONFLICT, carrying both revisions', () => {
    const cell = createTestCell();
    cell.accept(
      buildCommand({ operation: 'create_workspace', actorId: 'alice', payload: { name: 'W', description: 'd' } }),
    );
    // cell.revision() is now 1 (one accepted command).
    const outcome = cell.reject(
      buildCommand({
        operation: 'create_problem',
        actorId: 'alice',
        expectedRevision: 999,
        payload: { title: 'T', description: 'D' },
      }),
    );
    expect(outcome.rejection.code).toBe('REVISION_CONFLICT');
    expect(outcome.rejection.details).toEqual({ expectedRevision: 999, aggregateRevision: cell.revision() });
  });

  it('accepts a member mutation whose expectedRevision matches the current aggregate revision', () => {
    const cell = createTestCell();
    cell.accept(
      buildCommand({ operation: 'create_workspace', actorId: 'alice', payload: { name: 'W', description: 'd' } }),
    );
    const outcome = cell.accept(
      buildCommand({
        operation: 'create_problem',
        actorId: 'alice',
        expectedRevision: 1,
        payload: { title: 'T', description: 'D' },
      }),
    );
    expect(outcome.ok).toBe(true);
  });

  it('omitting expectedRevision never triggers REVISION_CONFLICT regardless of the current revision', () => {
    const cell = createTestCell();
    cell.accept(
      buildCommand({ operation: 'create_workspace', actorId: 'alice', payload: { name: 'W', description: 'd' } }),
    );
    cell.accept(
      buildCommand({ operation: 'create_problem', actorId: 'alice', payload: { title: 'T1', description: 'D1' } }),
    );
    const outcome = cell.accept(
      buildCommand({ operation: 'create_problem', actorId: 'alice', payload: { title: 'T2', description: 'D2' } }),
    );
    expect(outcome.ok).toBe(true);
  });
});
