/**
 * Decisions Module — the hub-global decision ledger
 *
 * Records durable decisions, the assumptions they rest on, and the raw
 * outcomes observed afterwards. Every write is create-only except the additive
 * challenge append: a decision that turns out wrong is retired by recording a
 * NEW decision whose `supersedes` names it, never by editing the original.
 *
 * Referential validation lives here rather than in the handler because it is
 * the layer that can see storage — an assumptionId that names nothing, an
 * outcome for a decision that does not exist, or a second supersession of an
 * already-retired decision are all refused before anything is written.
 */

import { randomUUID } from 'node:crypto';
import type { HubStorage } from './hub-types.js';
import type {
  AssumptionRecord,
  DecisionHealthFlag,
  DecisionRecord,
  ExpectationAssessment,
  OutcomeRecord,
  ThoughtProvenanceRef,
} from './decision-types.js';
import { computeHealthFlags, scopesMatch, successorOf } from './decision-types.js';

/** The context fields every decision-recording op accepts. */
export interface DecisionDraft {
  scope?: string;
  statement: string;
  rationale: string;
  assumptionIds?: string[];
  alternatives?: Array<{ label: string; reason?: string }>;
  expectedOutcome?: string;
  evidenceRefs?: string[];
  thoughtRef?: ThoughtProvenanceRef;
  regimeRef?: string;
  workspaceId?: string;
  taskRef?: string;
  slug?: string;
}

export interface ConsultedDecision {
  decision: DecisionRecord;
  health: DecisionHealthFlag[];
  /** Set when `health` contains 'superseded' — the decision that retired it. */
  supersededBy?: string;
}

export interface DecisionsManager {
  recordDecision(
    agentId: string,
    args: DecisionDraft & { scope: string },
  ): Promise<{ decisionId: string; decision: DecisionRecord }>;

  recordAssumption(
    agentId: string,
    args: { statement: string; scope?: string },
  ): Promise<{ assumptionId: string; assumption: AssumptionRecord }>;

  challengeAssumption(
    agentId: string,
    args: { assumptionId: string; reason: string; evidenceRefs?: string[] },
  ): Promise<{ challengeId: string; assumption: AssumptionRecord }>;

  supersedeDecision(
    agentId: string,
    args: DecisionDraft & { supersedes: string },
  ): Promise<{ decisionId: string; decision: DecisionRecord; supersededId: string }>;

  recordOutcome(
    agentId: string,
    args: {
      decisionId: string;
      kind: string;
      data: Record<string, unknown>;
      expectationAssessment?: ExpectationAssessment;
      note?: string;
    },
  ): Promise<{ outcomeId: string; outcome: OutcomeRecord }>;

  consultDecisions(
    args: {
      scope: string;
      currentRegimes?: Record<string, string>;
      includeSuperseded?: boolean;
    },
  ): Promise<{ scope: string; decisions: ConsultedDecision[] }>;
}

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

function assertOptionalStringArray(value: unknown, field: string): void {
  if (value === undefined) return;
  if (!Array.isArray(value) || value.some(entry => typeof entry !== 'string')) {
    throw new Error(`${field} must be an array of strings.`);
  }
}

function assertOptionalString(value: unknown, field: string): void {
  if (value !== undefined && typeof value !== 'string') {
    throw new Error(`${field} must be a string.`);
  }
}

/**
 * Structural validation of a decision draft, before anything touches storage.
 *
 * The handler checks argument PRESENCE; this checks argument SHAPE, and it
 * lives in the manager so every caller crosses it. Without it an object-valued
 * `assumptionIds` surfaced as the implementation exception "assumptionIds is
 * not iterable", and a malformed `evidenceRefs` was persisted verbatim — into
 * a ledger that is append-only by design, so a bad row is permanent
 * (PR #9 review). Runs on `record_decision` and `supersede_decision` alike via
 * `buildDecision`.
 */
function validateDraftShapes(draft: DecisionDraft): void {
  if (typeof draft.statement !== 'string') throw new Error('statement must be a string.');
  if (typeof draft.rationale !== 'string') throw new Error('rationale must be a string.');
  assertOptionalString(draft.scope, 'scope');
  assertOptionalString(draft.slug, 'slug');
  assertOptionalString(draft.expectedOutcome, 'expectedOutcome');
  assertOptionalString(draft.regimeRef, 'regimeRef');
  assertOptionalString(draft.workspaceId, 'workspaceId');
  assertOptionalString(draft.taskRef, 'taskRef');
  assertOptionalStringArray(draft.assumptionIds, 'assumptionIds');
  assertOptionalStringArray(draft.evidenceRefs, 'evidenceRefs');
  if (draft.alternatives !== undefined) {
    const ok =
      Array.isArray(draft.alternatives) &&
      draft.alternatives.every(
        alt =>
          isPlainObject(alt) &&
          typeof alt.label === 'string' &&
          (alt.reason === undefined || typeof alt.reason === 'string'),
      );
    if (!ok) {
      throw new Error('alternatives must be an array of { label, reason? } objects with string fields.');
    }
  }
  if (draft.thoughtRef !== undefined) {
    const ref = draft.thoughtRef;
    const ok =
      isPlainObject(ref) &&
      typeof ref.thoughtNumber === 'number' &&
      (ref.sessionId === undefined || typeof ref.sessionId === 'string') &&
      (ref.branchId === undefined || typeof ref.branchId === 'string');
    if (!ok) {
      throw new Error(
        'thoughtRef must be { thoughtNumber: number, sessionId?: string, branchId?: string }.',
      );
    }
  }
}

export function createDecisionsManager(storage: HubStorage): DecisionsManager {
  /**
   * Every mutation runs to completion before the next one starts.
   *
   * The ledger's invariants — slug uniqueness, one successor per decision,
   * all accepted challenges surviving — are enforced by read-then-write
   * sequences over filesystem storage that has no transactions, so two
   * interleaved writers can both pass the same check and both persist
   * (PR #9 review: a challenge append was lost, and two supersessions of one
   * decision both fulfilled). The hub is a single Node process, so a
   * manager-level chain is sufficient — and it is deliberately TOTAL over
   * mutations rather than keyed per record, because slug and successor checks
   * span records, and "which writes serialize" should never require reasoning
   * about which invariant each op touches. Reads stay concurrent.
   */
  let lastWrite: Promise<unknown> = Promise.resolve();
  function serialized<T>(op: () => Promise<T>): Promise<T> {
    const run = lastWrite.then(op, op);
    lastWrite = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  /**
   * Every assumption a decision claims to rest on must exist when it is
   * recorded. A decision pointing at a missing assumption would consult
   * clean forever — `restsOnChallengedAssumption` skips ids it cannot
   * resolve, so the dangling link reads as "nothing to worry about".
   */
  async function assertAssumptionsExist(assumptionIds: string[]): Promise<void> {
    const missing: string[] = [];
    for (const id of assumptionIds) {
      const assumption = await storage.getAssumption(id);
      if (!assumption) missing.push(id);
    }
    if (missing.length > 0) {
      throw new Error(
        `Unknown assumption id(s): ${missing.join(', ')}. ` +
          'Record each assumption first with record_assumption and link the returned assumptionId.',
      );
    }
  }

  /** Slugs are the import handle for the parent ledger, so they must be unique. */
  async function assertSlugAvailable(slug: string): Promise<void> {
    const existing = (await storage.listDecisions()).find(d => d.slug === slug);
    if (existing) {
      throw new Error(
        `Slug '${slug}' is already used by decision ${existing.id}. ` +
          'Slugs are unique handles; choose another or supersede that decision.',
      );
    }
  }

  /** Builds the shared decision body; `supersedes` is the only caller-varying field. */
  async function buildDecision(
    agentId: string,
    draft: DecisionDraft & { scope: string },
    supersedes?: string,
  ): Promise<DecisionRecord> {
    validateDraftShapes(draft);
    const assumptionIds = draft.assumptionIds ?? [];
    await assertAssumptionsExist(assumptionIds);
    if (draft.slug !== undefined) await assertSlugAvailable(draft.slug);

    return {
      v: 1,
      id: randomUUID(),
      ...(draft.slug !== undefined ? { slug: draft.slug } : {}),
      scope: draft.scope,
      statement: draft.statement,
      rationale: draft.rationale,
      assumptionIds,
      alternatives: draft.alternatives ?? [],
      ...(draft.expectedOutcome !== undefined ? { expectedOutcome: draft.expectedOutcome } : {}),
      evidenceRefs: draft.evidenceRefs ?? [],
      ...(draft.thoughtRef !== undefined ? { thoughtRef: draft.thoughtRef } : {}),
      ...(draft.regimeRef !== undefined ? { regimeRef: draft.regimeRef } : {}),
      ...(supersedes !== undefined ? { supersedes } : {}),
      ...(draft.workspaceId !== undefined ? { workspaceId: draft.workspaceId } : {}),
      ...(draft.taskRef !== undefined ? { taskRef: draft.taskRef } : {}),
      decidedBy: agentId,
      decidedAt: new Date().toISOString(),
    };
  }

  return {
    recordDecision(agentId, args) {
      return serialized(async () => {
        const decision = await buildDecision(agentId, args);
        await storage.saveDecision(decision);
        return { decisionId: decision.id, decision };
      });
    },

    recordAssumption(agentId, { statement, scope }) {
      return serialized(async () => {
        if (typeof statement !== 'string') throw new Error('statement must be a string.');
        assertOptionalString(scope, 'scope');
        const assumption: AssumptionRecord = {
          v: 1,
          id: randomUUID(),
          statement,
          ...(scope !== undefined ? { scope } : {}),
          proposedBy: agentId,
          proposedAt: new Date().toISOString(),
          challenges: [],
        };
        await storage.saveAssumption(assumption);
        return { assumptionId: assumption.id, assumption };
      });
    },

    challengeAssumption(agentId, { assumptionId, reason, evidenceRefs }) {
      return serialized(async () => {
        if (typeof reason !== 'string') throw new Error('reason must be a string.');
        assertOptionalStringArray(evidenceRefs, 'evidenceRefs');
        const existing = await storage.getAssumption(assumptionId);
        if (!existing) throw new Error(`Assumption not found: ${assumptionId}`);

        const challenge = {
          id: randomUUID(),
          challengedBy: agentId,
          challengedAt: new Date().toISOString(),
          reason,
          evidenceRefs: evidenceRefs ?? [],
        };
        // Additive append, the same contract as appendReview/appendEndorsement:
        // a challenge is never withdrawn, and concurrent challenges all survive
        // — which the serialized chain is what actually guarantees: the
        // storage-level append is a read-modify-write, and unserialized it
        // lost whichever of two interleaved appends wrote first.
        await storage.appendAssumptionChallenge(assumptionId, challenge);

        const updated = await storage.getAssumption(assumptionId);
        return { challengeId: challenge.id, assumption: updated ?? existing };
      });
    },

    supersedeDecision(agentId, args) {
      return serialized(async () => {
        const target = await storage.getDecision(args.supersedes);
        if (!target) throw new Error(`Decision not found: ${args.supersedes}`);

        // Two successors would make "the current decision" ambiguous — the
        // consult would report the scope as governed by both. The refusal names
        // the winner so the caller can chain onto it instead of guessing.
        const allDecisions = await storage.listDecisions();
        const winner = successorOf(args.supersedes, allDecisions);
        if (winner) {
          throw new Error(
            `Decision ${args.supersedes} is already superseded by ${winner.id}` +
              `${winner.slug ? ` (${winner.slug})` : ''}. ` +
              'Supersede that decision instead — supersession is a chain, not a fork.',
          );
        }

        const decision = await buildDecision(
          agentId,
          { ...args, scope: args.scope ?? target.scope },
          args.supersedes,
        );
        await storage.saveDecision(decision);
        return { decisionId: decision.id, decision, supersededId: args.supersedes };
      });
    },

    recordOutcome(agentId, { decisionId, kind, data, expectationAssessment, note }) {
      return serialized(async () => {
        const decision = await storage.getDecision(decisionId);
        if (!decision) throw new Error(`Decision not found: ${decisionId}`);

        const outcome: OutcomeRecord = {
          v: 1,
          id: randomUUID(),
          decisionId,
          kind,
          data,
          ...(expectationAssessment !== undefined ? { expectationAssessment } : {}),
          ...(note !== undefined ? { note } : {}),
          observedBy: agentId,
          observedAt: new Date().toISOString(),
        };
        await storage.saveOutcome(outcome);
        return { outcomeId: outcome.id, outcome };
      });
    },

    async consultDecisions({ scope, currentRegimes, includeSuperseded }) {
      const allDecisions = await storage.listDecisions();
      const assumptions = await storage.listAssumptions();
      const outcomes = await storage.listOutcomes();

      const consulted: ConsultedDecision[] = [];
      for (const decision of allDecisions) {
        if (!scopesMatch(decision.scope, scope)) continue;

        const health = computeHealthFlags({
          decision,
          allDecisions,
          assumptions,
          outcomes,
          ...(currentRegimes !== undefined ? { currentRegimes } : {}),
        });
        const successor = successorOf(decision.id, allDecisions);
        if (successor && !includeSuperseded) continue;

        consulted.push({
          decision,
          health,
          ...(successor ? { supersededBy: successor.id } : {}),
        });
      }

      // Newest first, id as the tiebreaker: two decisions recorded in the same
      // millisecond must still consult in a stable order.
      consulted.sort((a, b) => {
        const byTime = b.decision.decidedAt.localeCompare(a.decision.decidedAt);
        return byTime !== 0 ? byTime : a.decision.id.localeCompare(b.decision.id);
      });

      return { scope, decisions: consulted };
    },
  };
}
