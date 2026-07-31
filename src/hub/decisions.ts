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

export function createDecisionsManager(storage: HubStorage): DecisionsManager {
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
    async recordDecision(agentId, args) {
      const decision = await buildDecision(agentId, args);
      await storage.saveDecision(decision);
      return { decisionId: decision.id, decision };
    },

    async recordAssumption(agentId, { statement, scope }) {
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
    },

    async challengeAssumption(agentId, { assumptionId, reason, evidenceRefs }) {
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
      // a challenge is never withdrawn, and concurrent challenges all survive.
      await storage.appendAssumptionChallenge(assumptionId, challenge);

      const updated = await storage.getAssumption(assumptionId);
      return { challengeId: challenge.id, assumption: updated ?? existing };
    },

    async supersedeDecision(agentId, args) {
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
    },

    async recordOutcome(agentId, { decisionId, kind, data, expectationAssessment, note }) {
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
