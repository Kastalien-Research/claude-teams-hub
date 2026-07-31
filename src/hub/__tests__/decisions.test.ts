import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createDecisionsManager } from '../decisions.js';
import { createFileSystemHubStorage } from '../hub-storage-fs.js';
import { createHubHandler, type HubEvent } from '../hub-handler.js';
import { AGENT_ID_REQUIRED_ERROR } from '../identity-resolver.js';
import {
  EXPECTATION_ASSESSMENTS,
  computeHealthFlags,
  deriveAssumptionStatus,
  scopesMatch,
} from '../decision-types.js';
import type { AssumptionRecord, DecisionRecord } from '../decision-types.js';
import { createInMemoryHubStorage, createInMemoryThoughtStore } from './test-helpers.js';

const AGENT = 'agent-decider';

describe('Decisions manager', () => {
  let storage: ReturnType<typeof createInMemoryHubStorage>;
  let decisions: ReturnType<typeof createDecisionsManager>;

  beforeEach(() => {
    storage = createInMemoryHubStorage();
    decisions = createDecisionsManager(storage);
  });

  describe('record and consult', () => {
    it('records a decision and consults it back by exact scope', async () => {
      const { decisionId } = await decisions.recordDecision(AGENT, {
        scope: 'src/dispatch/',
        statement: 'Rows move to processing only after ack',
        rationale: 'Boot recovery re-drives processing rows',
      });

      const result = await decisions.consultDecisions({ scope: 'src/dispatch/' });
      expect(result.decisions).toHaveLength(1);
      expect(result.decisions[0]!.decision.id).toBe(decisionId);
      expect(result.decisions[0]!.decision.decidedBy).toBe(AGENT);
      expect(result.decisions[0]!.health).toEqual([]);
    });

    it('defaults the collection fields rather than leaving them undefined', async () => {
      const { decision } = await decisions.recordDecision(AGENT, {
        scope: 'src/hub/',
        statement: 's',
        rationale: 'r',
      });
      expect(decision.v).toBe(1);
      expect(decision.assumptionIds).toEqual([]);
      expect(decision.alternatives).toEqual([]);
      expect(decision.evidenceRefs).toEqual([]);
      expect(decision.supersedes).toBeUndefined();
    });

    // Both directions, because a consult is useful from either end: standing
    // at a file you want the directory's decisions, and standing at a
    // directory you want everything decided beneath it.
    it('a file-path consult finds decisions scoped to its directory', async () => {
      await decisions.recordDecision(AGENT, {
        scope: 'src/dispatch/',
        statement: 'directory-scoped',
        rationale: 'r',
      });

      const result = await decisions.consultDecisions({ scope: 'src/dispatch/runners/mcp.ts' });
      expect(result.decisions.map(d => d.decision.statement)).toEqual(['directory-scoped']);
    });

    it('a directory consult finds the finer-scoped decisions beneath it', async () => {
      await decisions.recordDecision(AGENT, {
        scope: 'src/dispatch/runners/mcp.ts',
        statement: 'file-scoped',
        rationale: 'r',
      });

      const result = await decisions.consultDecisions({ scope: 'src/dispatch/' });
      expect(result.decisions.map(d => d.decision.statement)).toEqual(['file-scoped']);
    });

    it('does not match a sibling scope that merely shares a string prefix', async () => {
      await decisions.recordDecision(AGENT, {
        scope: 'src/dispatchers/',
        statement: 'unrelated',
        rationale: 'r',
      });

      const result = await decisions.consultDecisions({ scope: 'src/dispatch/' });
      expect(result.decisions).toEqual([]);
    });
  });

  describe('health flags', () => {
    async function decisionRestingOn(assumptionIds: string[]): Promise<string> {
      const { decisionId } = await decisions.recordDecision(AGENT, {
        scope: 'src/dispatch/',
        statement: 'the decision under test',
        rationale: 'r',
        assumptionIds,
        expectedOutcome: 'no replayed work',
        regimeRef: 'commit-message@2',
      });
      return decisionId;
    }

    it('rests-on-challenged-assumption is off until the assumption is challenged', async () => {
      const { assumptionId } = await decisions.recordAssumption(AGENT, {
        statement: 'the queue has a single writer',
      });
      await decisionRestingOn([assumptionId]);

      const before = await decisions.consultDecisions({ scope: 'src/dispatch/' });
      expect(before.decisions[0]!.health).not.toContain('rests-on-challenged-assumption');

      await decisions.challengeAssumption(AGENT, {
        assumptionId,
        reason: 'the reconcile timer starts a second writer',
      });

      const after = await decisions.consultDecisions({ scope: 'src/dispatch/' });
      expect(after.decisions[0]!.health).toContain('rests-on-challenged-assumption');
    });

    it('outcome-contradicts-expectation is driven only by a contradicting outcome', async () => {
      const decisionId = await decisionRestingOn([]);

      await decisions.recordOutcome(AGENT, {
        decisionId,
        kind: 'verify-exit',
        data: { exitCode: 0 },
        expectationAssessment: 'consistent',
      });
      const consistent = await decisions.consultDecisions({ scope: 'src/dispatch/' });
      expect(consistent.decisions[0]!.health).not.toContain('outcome-contradicts-expectation');

      await decisions.recordOutcome(AGENT, {
        decisionId,
        kind: 'verify-exit',
        data: { exitCode: 1 },
        expectationAssessment: 'contradicts',
      });
      const contradicted = await decisions.consultDecisions({ scope: 'src/dispatch/' });
      expect(contradicted.decisions[0]!.health).toContain('outcome-contradicts-expectation');
    });

    it('regime-changed-since fires only when the caller reports a different version', async () => {
      await decisionRestingOn([]);

      const same = await decisions.consultDecisions({
        scope: 'src/dispatch/',
        currentRegimes: { 'commit-message': '2' },
      });
      expect(same.decisions[0]!.health).not.toContain('regime-changed-since');

      const drifted = await decisions.consultDecisions({
        scope: 'src/dispatch/',
        currentRegimes: { 'commit-message': '3' },
      });
      expect(drifted.decisions[0]!.health).toContain('regime-changed-since');

      const unreported = await decisions.consultDecisions({ scope: 'src/dispatch/' });
      expect(unreported.decisions[0]!.health).not.toContain('regime-changed-since');
    });

    it('supersede hides the old decision unless includeSuperseded is set', async () => {
      const original = await decisionRestingOn([]);
      const { decisionId: successor } = await decisions.supersedeDecision(AGENT, {
        supersedes: original,
        statement: 'the replacement',
        rationale: 'the first one leaked rows',
      });

      const hidden = await decisions.consultDecisions({ scope: 'src/dispatch/' });
      expect(hidden.decisions.map(d => d.decision.id)).toEqual([successor]);

      const shown = await decisions.consultDecisions({
        scope: 'src/dispatch/',
        includeSuperseded: true,
      });
      const retired = shown.decisions.find(d => d.decision.id === original)!;
      expect(retired.health).toContain('superseded');
      expect(retired.supersededBy).toBe(successor);
    });

    it('the successor inherits the superseded decision scope by default', async () => {
      const original = await decisionRestingOn([]);
      const { decision } = await decisions.supersedeDecision(AGENT, {
        supersedes: original,
        statement: 'the replacement',
        rationale: 'r',
      });
      expect(decision.scope).toBe('src/dispatch/');
      expect(decision.supersedes).toBe(original);
    });
  });

  describe('referential validation', () => {
    it('refuses a decision linking an assumption that does not exist', async () => {
      await expect(
        decisions.recordDecision(AGENT, {
          scope: 'src/hub/',
          statement: 's',
          rationale: 'r',
          assumptionIds: ['no-such-assumption'],
        }),
      ).rejects.toThrow(/Unknown assumption id\(s\): no-such-assumption/);
    });

    it('refuses an outcome for a decision that does not exist', async () => {
      await expect(
        decisions.recordOutcome(AGENT, {
          decisionId: 'no-such-decision',
          kind: 'verify-exit',
          data: {},
        }),
      ).rejects.toThrow('Decision not found: no-such-decision');
    });

    it('refuses a challenge against an assumption that does not exist', async () => {
      await expect(
        decisions.challengeAssumption(AGENT, { assumptionId: 'nope', reason: 'r' }),
      ).rejects.toThrow('Assumption not found: nope');
    });

    it('refuses superseding a decision that does not exist', async () => {
      await expect(
        decisions.supersedeDecision(AGENT, {
          supersedes: 'no-such-decision',
          statement: 's',
          rationale: 'r',
        }),
      ).rejects.toThrow('Decision not found: no-such-decision');
    });

    // A fork would leave two records claiming to replace the same decision,
    // and no way to say which one governs the scope now.
    it('refuses a second supersession, naming the successor that already won', async () => {
      const { decisionId: original } = await decisions.recordDecision(AGENT, {
        scope: 'src/hub/',
        statement: 'original',
        rationale: 'r',
      });
      const { decisionId: winner } = await decisions.supersedeDecision(AGENT, {
        supersedes: original,
        statement: 'first replacement',
        rationale: 'r',
        slug: 'first-replacement',
      });

      await expect(
        decisions.supersedeDecision(AGENT, {
          supersedes: original,
          statement: 'second replacement',
          rationale: 'r',
        }),
      ).rejects.toThrow(
        `Decision ${original} is already superseded by ${winner} (first-replacement)`,
      );
    });

    it('refuses a duplicate slug, naming the decision holding it', async () => {
      const { decisionId } = await decisions.recordDecision(AGENT, {
        scope: 'src/hub/',
        statement: 'first',
        rationale: 'r',
        slug: 'queue-ack-semantics',
      });

      await expect(
        decisions.recordDecision(AGENT, {
          scope: 'src/hub/',
          statement: 'second',
          rationale: 'r',
          slug: 'queue-ack-semantics',
        }),
      ).rejects.toThrow(`Slug 'queue-ack-semantics' is already used by decision ${decisionId}`);
    });

    it('writes nothing when validation refuses the decision', async () => {
      await expect(
        decisions.recordDecision(AGENT, {
          scope: 'src/hub/',
          statement: 's',
          rationale: 'r',
          assumptionIds: ['ghost'],
        }),
      ).rejects.toThrow();
      expect(await storage.listDecisions()).toEqual([]);
    });
  });

  describe('append-only', () => {
    // The charter invariant, asserted on bytes rather than on the absence of
    // an update method: everything that happens to a decision afterwards —
    // being superseded, having its assumption challenged, accumulating a
    // contradicting outcome — must leave the original record untouched.
    it('the original decision stored JSON is byte-identical after supersede, challenge, and outcome', async () => {
      const { assumptionId } = await decisions.recordAssumption(AGENT, {
        statement: 'the queue has a single writer',
      });
      const { decisionId } = await decisions.recordDecision(AGENT, {
        scope: 'src/dispatch/',
        statement: 'the original decision',
        rationale: 'r',
        assumptionIds: [assumptionId],
        expectedOutcome: 'no replayed work',
      });

      const atCreation = JSON.stringify(await storage.getDecision(decisionId));

      await decisions.recordOutcome(AGENT, {
        decisionId,
        kind: 'verify-exit',
        data: { exitCode: 1 },
        expectationAssessment: 'contradicts',
      });
      await decisions.challengeAssumption(AGENT, {
        assumptionId,
        reason: 'the reconcile timer starts a second writer',
      });
      await decisions.supersedeDecision(AGENT, {
        supersedes: decisionId,
        statement: 'the replacement',
        rationale: 'r',
      });
      await decisions.consultDecisions({ scope: 'src/dispatch/', includeSuperseded: true });

      expect(JSON.stringify(await storage.getDecision(decisionId))).toBe(atCreation);
    });

    it('challenges accumulate rather than replace', async () => {
      const { assumptionId } = await decisions.recordAssumption(AGENT, { statement: 'a' });
      await decisions.challengeAssumption(AGENT, { assumptionId, reason: 'first' });
      const { assumption } = await decisions.challengeAssumption(AGENT, {
        assumptionId,
        reason: 'second',
      });

      expect(assumption.challenges.map(c => c.reason)).toEqual(['first', 'second']);
      expect(deriveAssumptionStatus(assumption)).toBe('challenged');
    });
  });
});

describe('Decision health (pure functions)', () => {
  const decision: DecisionRecord = {
    v: 1,
    id: 'd1',
    scope: 'src/dispatch/',
    statement: 's',
    rationale: 'r',
    assumptionIds: ['a1'],
    alternatives: [],
    evidenceRefs: [],
    regimeRef: 'commit-message@2',
    decidedBy: AGENT,
    decidedAt: '2026-07-31T00:00:00.000Z',
  };
  const assumption: AssumptionRecord = {
    v: 1,
    id: 'a1',
    statement: 'a',
    proposedBy: AGENT,
    proposedAt: '2026-07-31T00:00:00.000Z',
    challenges: [],
  };

  it('reports no flags for a healthy decision', () => {
    expect(
      computeHealthFlags({
        decision,
        allDecisions: [decision],
        assumptions: [assumption],
        outcomes: [],
      }),
    ).toEqual([]);
  });

  // Deterministic order matters: the flags are published to callers, and a
  // set-like ordering would make consult output unstable between runs.
  it('emits flags in DECISION_HEALTH_FLAGS order when all four fire', () => {
    const successor: DecisionRecord = { ...decision, id: 'd2', supersedes: 'd1' };
    expect(
      computeHealthFlags({
        decision,
        allDecisions: [decision, successor],
        assumptions: [
          {
            ...assumption,
            challenges: [
              {
                id: 'c1',
                challengedBy: AGENT,
                challengedAt: '2026-07-31T01:00:00.000Z',
                reason: 'r',
                evidenceRefs: [],
              },
            ],
          },
        ],
        outcomes: [
          {
            v: 1,
            id: 'o1',
            decisionId: 'd1',
            kind: 'k',
            data: {},
            expectationAssessment: 'contradicts',
            observedBy: AGENT,
            observedAt: '2026-07-31T02:00:00.000Z',
          },
        ],
        currentRegimes: { 'commit-message': '3' },
      }),
    ).toEqual([
      'rests-on-challenged-assumption',
      'outcome-contradicts-expectation',
      'superseded',
      'regime-changed-since',
    ]);
  });

  it('normalizes trailing slashes on both sides of a scope match', () => {
    expect(scopesMatch('src/dispatch/', 'src/dispatch')).toBe(true);
    expect(scopesMatch('src/dispatch', 'src/dispatch/runners/')).toBe(true);
    expect(scopesMatch('src/dispatch', 'src/dispatchers')).toBe(false);
  });
});

describe('Decisions storage — filesystem persistence', () => {
  let dataDir: string;

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'hub-decisions-'));
  });

  afterEach(async () => {
    await rm(dataDir, { recursive: true, force: true });
  });

  it('round-trips decisions, assumptions, and outcomes through flat per-record files', async () => {
    const storage = createFileSystemHubStorage(dataDir);
    const decisions = createDecisionsManager(storage);

    const { assumptionId } = await decisions.recordAssumption(AGENT, { statement: 'a' });
    const { decisionId } = await decisions.recordDecision(AGENT, {
      scope: 'src/dispatch/',
      statement: 'persisted',
      rationale: 'r',
      assumptionIds: [assumptionId],
    });
    const { outcomeId } = await decisions.recordOutcome(AGENT, {
      decisionId,
      kind: 'verify-exit',
      data: { exitCode: 0 },
    });

    // The layout is load-bearing: a consultation hook globs these paths with
    // no server in the path, so the directory names are part of the contract.
    const onDisk = JSON.parse(
      await readFile(join(dataDir, 'hub', 'decisions', 'records', `${decisionId}.json`), 'utf-8'),
    );
    expect(onDisk.statement).toBe('persisted');
    expect(onDisk.v).toBe(1);

    const reread = createFileSystemHubStorage(dataDir);
    expect((await reread.getDecision(decisionId))?.statement).toBe('persisted');
    expect((await reread.getAssumption(assumptionId))?.statement).toBe('a');
    expect((await reread.listOutcomes()).map(o => o.id)).toEqual([outcomeId]);
    expect(await reread.listDecisions()).toHaveLength(1);
  });

  it('retains repeated challenge appends against the same assumption', async () => {
    const storage = createFileSystemHubStorage(dataDir);
    const decisions = createDecisionsManager(storage);
    const { assumptionId } = await decisions.recordAssumption(AGENT, { statement: 'a' });

    for (const reason of ['first', 'second', 'third']) {
      await decisions.challengeAssumption(AGENT, { assumptionId, reason });
    }

    const stored = await storage.getAssumption(assumptionId);
    expect(stored?.challenges.map(c => c.reason)).toEqual(['first', 'second', 'third']);
  });

  it('returns empty collections before anything has been written', async () => {
    const storage = createFileSystemHubStorage(dataDir);
    expect(await storage.listDecisions()).toEqual([]);
    expect(await storage.listAssumptions()).toEqual([]);
    expect(await storage.listOutcomes()).toEqual([]);
    expect(await storage.getDecision('missing')).toBeNull();
  });
});

describe('Decisions through the hub handler', () => {
  let storage: ReturnType<typeof createInMemoryHubStorage>;
  let handler: ReturnType<typeof createHubHandler>;
  let events: HubEvent[];
  let agentId: string;

  beforeEach(async () => {
    storage = createInMemoryHubStorage();
    events = [];
    handler = createHubHandler(
      storage,
      createInMemoryThoughtStore() as never,
      event => events.push(event),
    );
    const reg = (await handler.handle(null, 'register', { name: 'decider' })) as {
      agentId: string;
    };
    agentId = reg.agentId;
    events.length = 0;
  });

  const DECISION_OPS: Array<[string, Record<string, unknown>]> = [
    ['record_decision', { scope: 'src/hub/', statement: 's', rationale: 'r' }],
    ['record_assumption', { statement: 'a' }],
    ['challenge_assumption', { assumptionId: 'x', reason: 'r' }],
    ['supersede_decision', { supersedes: 'x', statement: 's', rationale: 'r' }],
    ['record_outcome', { decisionId: 'x', kind: 'k', data: {} }],
    ['consult_decisions', { scope: 'src/hub/' }],
  ];

  it.each(DECISION_OPS)('%s fails without an agentId', async (operation, args) => {
    await expect(handler.handle(null, operation, args)).rejects.toThrow(AGENT_ID_REQUIRED_ERROR);
  });

  // Stage 1, not 2: the ledger is hub-global, so a registered agent that has
  // joined nothing must still be able to record and consult.
  it('a registered agent with no workspace can record and consult', async () => {
    const recorded = (await handler.handle(agentId, 'record_decision', {
      scope: 'src/hub/',
      statement: 'hub-global',
      rationale: 'r',
    })) as { decisionId: string };

    const consulted = (await handler.handle(agentId, 'consult_decisions', {
      scope: 'src/hub/',
    })) as { decisions: Array<{ decision: { id: string } }> };

    expect(consulted.decisions.map(d => d.decision.id)).toEqual([recorded.decisionId]);
  });

  it('emits one event per mutation and none for the consult', async () => {
    const { assumptionId } = (await handler.handle(agentId, 'record_assumption', {
      statement: 'a',
    })) as { assumptionId: string };
    const { decisionId } = (await handler.handle(agentId, 'record_decision', {
      scope: 'src/hub/',
      statement: 's',
      rationale: 'r',
      assumptionIds: [assumptionId],
      workspaceId: 'ws-1',
    })) as { decisionId: string };
    await handler.handle(agentId, 'record_outcome', {
      decisionId,
      kind: 'k',
      data: { n: 1 },
    });
    await handler.handle(agentId, 'challenge_assumption', { assumptionId, reason: 'r' });
    await handler.handle(agentId, 'supersede_decision', {
      supersedes: decisionId,
      statement: 's2',
      rationale: 'r2',
    });
    await handler.handle(agentId, 'consult_decisions', { scope: 'src/hub/' });

    expect(events.map(e => e.type)).toEqual([
      'assumption_recorded',
      'decision_recorded',
      'outcome_recorded',
      'assumption_challenged',
      'decision_superseded',
    ]);

    // Hub-global records precede workspace membership, so they ride the '*'
    // convention unless the record itself carries workspace context.
    const byType = Object.fromEntries(events.map(e => [e.type, e]));
    expect(byType['assumption_recorded']!.workspaceId).toBe('*');
    expect(byType['outcome_recorded']!.workspaceId).toBe('*');
    expect(byType['decision_recorded']!.workspaceId).toBe('ws-1');
    expect(byType['decision_superseded']!.data['supersededId']).toBe(decisionId);
  });

  it('rejects an out-of-enum expectationAssessment by name', async () => {
    const { decisionId } = (await handler.handle(agentId, 'record_decision', {
      scope: 'src/hub/',
      statement: 's',
      rationale: 'r',
    })) as { decisionId: string };

    await expect(
      handler.handle(agentId, 'record_outcome', {
        decisionId,
        kind: 'k',
        data: {},
        expectationAssessment: 'refutes',
      }),
    ).rejects.toThrow(
      `Invalid expectationAssessment 'refutes'. Valid assessments: ${EXPECTATION_ASSESSMENTS.join(', ')}`,
    );
    expect(await storage.listOutcomes()).toEqual([]);
  });

  it.each([
    ['record_decision', {}, /requires scope/],
    ['record_decision', { scope: 's' }, /requires statement/],
    ['record_decision', { scope: 's', statement: 's' }, /requires rationale/],
    ['record_assumption', {}, /requires statement/],
    ['challenge_assumption', {}, /requires assumptionId/],
    ['challenge_assumption', { assumptionId: 'x' }, /requires reason/],
    ['supersede_decision', {}, /requires supersedes/],
    ['record_outcome', {}, /requires decisionId/],
    ['record_outcome', { decisionId: 'x' }, /requires kind/],
    ['record_outcome', { decisionId: 'x', kind: 'k' }, /requires data/],
    ['consult_decisions', {}, /requires scope/],
  ] as Array<[string, Record<string, unknown>, RegExp]>)(
    '%s reports the missing argument by name',
    async (operation, args, expected) => {
      await expect(handler.handle(agentId, operation, args)).rejects.toThrow(expected);
    },
  );
});
