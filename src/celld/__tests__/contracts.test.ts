import { describe, it, expect } from 'vitest';
import {
  hubCommandV1Schema,
  hubEventV1Schema,
  commandMetadataV1Schema,
  CELLD_SUPPORTED_EXISTING_OPERATIONS,
  CELLD_NEW_OPERATIONS,
  isCelldSupportedOperation,
  isCelldMutation,
} from '../contracts.js';

function validCommand() {
  return {
    schemaVersion: 'hub-command-v1' as const,
    commandId: 'cmd-1',
    operation: 'create_problem',
    workspaceId: 'ws-1',
    actor: { agentId: 'alice' },
    issuedAt: '2026-08-06T00:00:00.000Z',
    context: {},
    payloadHash: 'a'.repeat(64),
    payload: { title: 'T', description: 'D' },
  };
}

function validEvent() {
  return {
    schemaVersion: 'hub-event-v1' as const,
    eventId: 'evt-1',
    workspaceId: 'ws-1',
    sequence: 1,
    aggregateRevision: 1,
    type: 'problem_created',
    commandId: 'cmd-1',
    actor: { agentId: 'alice' },
    occurredAt: '2026-08-06T00:00:00.000Z',
    data: {},
  };
}

describe('hubCommandV1Schema', () => {
  it('round-trips a valid command', () => {
    const input = validCommand();
    const parsed = hubCommandV1Schema.parse(input);
    expect(parsed).toEqual(input);
  });

  it('accepts optional fields when present', () => {
    const input = {
      ...validCommand(),
      expectedRevision: 3,
      correlationId: 'corr-1',
      causationId: 'cause-1',
      actor: { agentId: 'alice', promptVersion: 'v2' },
      context: { teamRunId: 'run-1', nativeTaskId: 'task-1', processRunId: 'proc-1' },
    };
    expect(() => hubCommandV1Schema.parse(input)).not.toThrow();
  });

  it('strictly rejects unknown top-level keys', () => {
    const input = { ...validCommand(), extraField: 'not part of the contract' };
    expect(() => hubCommandV1Schema.parse(input)).toThrow();
  });

  it('strictly rejects unknown keys inside actor', () => {
    const input = { ...validCommand(), actor: { agentId: 'alice', unexpected: true } };
    expect(() => hubCommandV1Schema.parse(input)).toThrow();
  });

  it('strictly rejects unknown keys inside context', () => {
    const input = { ...validCommand(), context: { teamRunId: 'run-1', unexpected: true } };
    expect(() => hubCommandV1Schema.parse(input)).toThrow();
  });

  it('rejects a mismatched schemaVersion', () => {
    const input = { ...validCommand(), schemaVersion: 'hub-command-v2' };
    expect(() => hubCommandV1Schema.parse(input)).toThrow();
  });

  it('rejects a payloadHash shorter than 64 characters', () => {
    const input = { ...validCommand(), payloadHash: 'a'.repeat(63) };
    expect(() => hubCommandV1Schema.parse(input)).toThrow();
  });

  it('rejects a payloadHash longer than 64 characters', () => {
    const input = { ...validCommand(), payloadHash: 'a'.repeat(65) };
    expect(() => hubCommandV1Schema.parse(input)).toThrow();
  });

  it('rejects an empty commandId', () => {
    const input = { ...validCommand(), commandId: '' };
    expect(() => hubCommandV1Schema.parse(input)).toThrow();
  });

  it('rejects a negative expectedRevision', () => {
    const input = { ...validCommand(), expectedRevision: -1 };
    expect(() => hubCommandV1Schema.parse(input)).toThrow();
  });

  it('rejects a non-integer expectedRevision', () => {
    const input = { ...validCommand(), expectedRevision: 1.5 };
    expect(() => hubCommandV1Schema.parse(input)).toThrow();
  });
});

describe('hubEventV1Schema', () => {
  it('round-trips a valid event', () => {
    const input = validEvent();
    const parsed = hubEventV1Schema.parse(input);
    expect(parsed).toEqual(input);
  });

  it('accepts actor extended with context fields', () => {
    const input = {
      ...validEvent(),
      actor: { agentId: 'alice', promptVersion: 'v2', teamRunId: 'run-1', nativeTaskId: 'task-1', processRunId: 'proc-1' },
    };
    expect(() => hubEventV1Schema.parse(input)).not.toThrow();
  });

  it('strictly rejects unknown top-level keys', () => {
    const input = { ...validEvent(), extraField: 'nope' };
    expect(() => hubEventV1Schema.parse(input)).toThrow();
  });

  it('rejects a mismatched schemaVersion', () => {
    const input = { ...validEvent(), schemaVersion: 'hub-event-v2' };
    expect(() => hubEventV1Schema.parse(input)).toThrow();
  });

  it('rejects a zero or negative sequence', () => {
    expect(() => hubEventV1Schema.parse({ ...validEvent(), sequence: 0 })).toThrow();
    expect(() => hubEventV1Schema.parse({ ...validEvent(), sequence: -1 })).toThrow();
  });

  it('rejects a zero or negative aggregateRevision', () => {
    expect(() => hubEventV1Schema.parse({ ...validEvent(), aggregateRevision: 0 })).toThrow();
  });
});

describe('commandMetadataV1Schema', () => {
  it('round-trips minimal metadata', () => {
    const input = { id: 'cmd-1' };
    expect(commandMetadataV1Schema.parse(input)).toEqual(input);
  });

  it('round-trips full metadata', () => {
    const input = {
      id: 'cmd-1',
      expectedRevision: 2,
      teamRunId: 'run-1',
      nativeTaskId: 'task-1',
      processRunId: 'proc-1',
      promptVersion: 'v2',
      correlationId: 'corr-1',
      causationId: 'cause-1',
    };
    expect(commandMetadataV1Schema.parse(input)).toEqual(input);
  });

  it('strictly rejects unknown keys', () => {
    expect(() => commandMetadataV1Schema.parse({ id: 'cmd-1', unexpected: true })).toThrow();
  });

  it('rejects an empty id', () => {
    expect(() => commandMetadataV1Schema.parse({ id: '' })).toThrow();
  });
});

describe('operation surface', () => {
  it('lists exactly 10 existing operations routed to celld', () => {
    expect(CELLD_SUPPORTED_EXISTING_OPERATIONS).toHaveLength(10);
    expect(new Set(CELLD_SUPPORTED_EXISTING_OPERATIONS).size).toBe(10);
  });

  it('lists exactly 5 new celld operations', () => {
    expect(CELLD_NEW_OPERATIONS).toHaveLength(5);
    expect(new Set(CELLD_NEW_OPERATIONS).size).toBe(5);
  });

  it('the existing and new operation sets are disjoint', () => {
    const overlap = CELLD_SUPPORTED_EXISTING_OPERATIONS.filter(op =>
      (CELLD_NEW_OPERATIONS as readonly string[]).includes(op),
    );
    expect(overlap).toEqual([]);
  });

  describe('isCelldSupportedOperation', () => {
    it.each(CELLD_SUPPORTED_EXISTING_OPERATIONS)('accepts existing operation %s', op => {
      expect(isCelldSupportedOperation(op)).toBe(true);
    });

    it.each(CELLD_NEW_OPERATIONS)('accepts new operation %s', op => {
      expect(isCelldSupportedOperation(op)).toBe(true);
    });

    // RFC 0001 §Operation surface: rejected on celld workspaces with
    // CELLD_CANARY_OPERATION_UNSUPPORTED.
    it.each([
      'quick_join',
      'transfer_coordinator',
      'add_dependency',
      'remove_dependency',
      'ready_problems',
      'blocked_problems',
      'create_sub_problem',
      'post_system_message',
      'create_proposal',
      'review_proposal',
      'merge_proposal',
      'endorse_consensus',
    ])('rejects unsupported operation %s', op => {
      expect(isCelldSupportedOperation(op)).toBe(false);
    });
  });

  describe('isCelldMutation', () => {
    it.each([
      'create_workspace',
      'join_workspace',
      'create_problem',
      'claim_problem',
      'update_problem',
      'post_message',
      'declare_work_intent',
      'record_work_change',
      'acknowledge_impact',
    ])('treats %s as a mutation', op => {
      expect(isCelldMutation(op)).toBe(true);
    });

    it.each([
      'list_problems',
      'read_channel',
      'workspace_status',
      'workspace_digest',
      'list_impacts',
      'read_workspace_events',
    ])('treats %s as a non-mutating operation', op => {
      expect(isCelldMutation(op)).toBe(false);
    });

    it('treats an unsupported operation as a non-mutation', () => {
      expect(isCelldMutation('quick_join')).toBe(false);
    });
  });
});
