/**
 * Decision Ledger Types — Epistemic Engine v0 subset
 *
 * The `decisions` hub category records durable decisions, the assumptions they
 * rest on, and the raw outcomes observed afterwards, hub-globally (like the
 * agent registry) rather than per workspace: a decision about a repo module
 * must be consultable from any session.
 *
 * Two invariants shape every type below.
 *
 * **Append-only via supersession, not mutation.** There is no update path for
 * decisions or outcomes — `HubStorage` deliberately has no `updateDecision`.
 * A decision that turns out wrong is retired by writing a NEW decision whose
 * `supersedes` names it; the original file is never rewritten. The single
 * in-place write anywhere in this module is the additive `challenges` append
 * on an assumption, which follows the `appendReview` / `appendEndorsement`
 * named-append pattern. Assumption status is never stored either: it is
 * derived from the challenges present at read time.
 *
 * **No numeric belief math.** Nothing here carries a posterior, a confidence,
 * or a score. `expectationAssessment` is a categorical adjudication kept
 * separate from the raw `data` it adjudicates, so a reader can check one
 * against the other. Health flags are computed at consult time from records,
 * never stored alongside them.
 *
 * Every record carries `v: 1`. A semantic change mints `v: 2` plus an upcaster
 * — the meaning of `v: 1` is never edited in place.
 *
 * ## Deliberate v0 omissions (forward compatibility)
 *
 * - **No numeric belief math.** Agents never set posteriors or confidence; v0
 *   is categorical only. The `v` envelope is where a governed belief runtime
 *   would attach, as new record versions.
 * - **No verified thought anchoring.** `thoughtRef` is structured but
 *   UNVALIDATED, matching the `ConsensusMarker.thoughtRef` precedent. Wiring
 *   it to the anchor parser/resolver is future work.
 * - **No hosted gating.** Any registered agent may write; the acting agent is
 *   always recorded in `decidedBy` / `proposedBy` / `challengedBy` /
 *   `observedBy`. Hosted mode would gate writes on `ownerPrincipal` exactly as
 *   `transfer_coordinator` does — no schema change needed.
 * - **No `accept_assumption` / `supersede_assumption` operations.** Both
 *   statuses are pre-declared in `ASSUMPTION_STATUSES` and the derived-status
 *   logic already tolerates them, so adding the operations later changes no
 *   stored record.
 * - **No server-side regime registry.** `currentRegimes` is supplied by the
 *   caller of `consult_decisions`; a registry operation can replace that
 *   argument without changing stored records.
 * - **No parent-ledger import.** The mapping onto the parent repo's
 *   `dev-processes/ledger/data/decisions.jsonl` is designed into this schema
 *   (`slug` ← `decision_id`, `evidenceRefs` ← `evidence[]`, reversal
 *   conditions → assumptions), but executing the import is a parent-repo
 *   phase, not part of this surface.
 */

// =============================================================================
// Vocabularies
// =============================================================================

/**
 * Assumption statuses. v0 stores none of them — status is DERIVED (see
 * `deriveAssumptionStatus`), and only 'proposed' and 'challenged' are
 * reachable. 'accepted' and 'superseded' are declared now so the operations
 * that produce them can be added without widening a published vocabulary.
 */
export const ASSUMPTION_STATUSES = ['proposed', 'accepted', 'challenged', 'superseded'] as const;

export type AssumptionStatus = (typeof ASSUMPTION_STATUSES)[number];

/**
 * How an observed outcome relates to the decision's `expectedOutcome`. This is
 * the one enum callers supply, so it is the one with a type guard: the catalog
 * schema documents it, but `record_outcome` validates it, the same pairing
 * `isReviewVerdict` exists for.
 */
export const EXPECTATION_ASSESSMENTS = ['consistent', 'contradicts', 'unclear'] as const;

export type ExpectationAssessment = (typeof EXPECTATION_ASSESSMENTS)[number];

export function isExpectationAssessment(value: unknown): value is ExpectationAssessment {
  return typeof value === 'string' && (EXPECTATION_ASSESSMENTS as readonly string[]).includes(value);
}

/** Health signals computed at consult time. Never stored on a record. */
export const DECISION_HEALTH_FLAGS = [
  'rests-on-challenged-assumption',
  'outcome-contradicts-expectation',
  'superseded',
  'regime-changed-since',
] as const;

export type DecisionHealthFlag = (typeof DECISION_HEALTH_FLAGS)[number];

// =============================================================================
// Records
// =============================================================================

/**
 * A pointer into the thought ledger. Structured but UNVALIDATED in v0 — same
 * standing as `ConsensusMarker.thoughtRef`.
 */
export interface ThoughtProvenanceRef {
  sessionId?: string;
  thoughtNumber: number;
  branchId?: string;
}

export interface DecisionRecord {
  v: 1;
  id: string;
  /** Optional stable handle; unique across the ledger when present. */
  slug?: string;
  /** Module or path string the decision governs, e.g. "src/dispatch/". */
  scope: string;
  statement: string;
  rationale: string;
  /** Assumption ids, each of which must exist when the decision is recorded. */
  assumptionIds: string[];
  /** Options considered and NOT chosen. */
  alternatives: Array<{ label: string; reason?: string }>;
  expectedOutcome?: string;
  /** Commits, files, probe outputs — things a reader can go check. */
  evidenceRefs: string[];
  thoughtRef?: ThoughtProvenanceRef;
  /** "commit-message@2", "rules/<file>@<commit>" — see `parseRegimeRef`. */
  regimeRef?: string;
  /** Id of the decision this one retires. Set only by `supersede_decision`. */
  supersedes?: string;
  /** Context only. Decisions are hub-global; this is NOT an access scope. */
  workspaceId?: string;
  taskRef?: string;
  decidedBy: string;
  decidedAt: string;
}

export interface AssumptionChallenge {
  id: string;
  challengedBy: string;
  challengedAt: string;
  reason: string;
  evidenceRefs: string[];
}

export interface AssumptionRecord {
  v: 1;
  id: string;
  statement: string;
  scope?: string;
  proposedBy: string;
  proposedAt: string;
  /** ADDITIVE — the only mutable field on any record in this module. */
  challenges: AssumptionChallenge[];
}

export interface OutcomeRecord {
  v: 1;
  id: string;
  /** Must name an existing decision. */
  decisionId: string;
  /** Free-form category, e.g. 'edit-distance', 'false_done', 'verify-exit'. */
  kind: string;
  /** Raw facts only — no verdict. Required, so an outcome is always checkable. */
  data: Record<string, unknown>;
  expectationAssessment?: ExpectationAssessment;
  note?: string;
  observedBy: string;
  observedAt: string;
}

// =============================================================================
// Derived status
// =============================================================================

/**
 * An assumption's status, derived from its challenges rather than stored.
 * v0 knows two: challenged once any challenge exists, proposed otherwise.
 */
export function deriveAssumptionStatus(assumption: AssumptionRecord): AssumptionStatus {
  return assumption.challenges.length > 0 ? 'challenged' : 'proposed';
}

// =============================================================================
// Scope matching
// =============================================================================

/** Drops trailing slashes so "src/dispatch/" and "src/dispatch" are one scope. */
export function normalizeScope(scope: string): string {
  return scope.replace(/\/+$/, '');
}

/**
 * True when one scope contains the other, in either direction: a consult for
 * `src/dispatch/runners/mcp.ts` returns decisions scoped `src/dispatch/`, and a
 * consult for `src/dispatch/` returns the finer-scoped decisions beneath it.
 *
 * Containment is checked at a path boundary, not by bare string prefix, so
 * `src/dispatch` does not match the unrelated `src/dispatchers`.
 */
export function scopesMatch(a: string, b: string): boolean {
  const left = normalizeScope(a);
  const right = normalizeScope(b);
  if (left === right) return true;
  const [shorter, longer] = left.length < right.length ? [left, right] : [right, left];
  if (shorter === '') return true;
  return longer.startsWith(`${shorter}/`);
}

// =============================================================================
// Regime references
// =============================================================================

/**
 * Splits "commit-message@2" into its name and version. The separator is the
 * LAST '@' so a name may contain one; a ref without a usable separator returns
 * null and simply never flags.
 */
export function parseRegimeRef(ref: string): { name: string; version: string } | null {
  const at = ref.lastIndexOf('@');
  if (at <= 0 || at === ref.length - 1) return null;
  return { name: ref.slice(0, at), version: ref.slice(at + 1) };
}

// =============================================================================
// Health (pure — unit-testable without storage)
// =============================================================================

export interface DecisionHealthInput {
  decision: DecisionRecord;
  /** Every decision in the ledger — supersession is a relation, not a field. */
  allDecisions: readonly DecisionRecord[];
  assumptions: readonly AssumptionRecord[];
  outcomes: readonly OutcomeRecord[];
  /** Caller-supplied, e.g. `{ "commit-message": "3" }`. No server registry. */
  currentRegimes?: Record<string, string>;
}

/** The decision that retired this one, if any. */
export function successorOf(
  decisionId: string,
  allDecisions: readonly DecisionRecord[],
): DecisionRecord | undefined {
  return allDecisions.find(d => d.supersedes === decisionId);
}

export function isSuperseded(
  decisionId: string,
  allDecisions: readonly DecisionRecord[],
): boolean {
  return successorOf(decisionId, allDecisions) !== undefined;
}

export function restsOnChallengedAssumption(
  decision: DecisionRecord,
  assumptions: readonly AssumptionRecord[],
): boolean {
  return decision.assumptionIds.some(id => {
    const assumption = assumptions.find(a => a.id === id);
    if (!assumption) return false;
    const status = deriveAssumptionStatus(assumption);
    // 'superseded' is unreachable in v0 but flags the same way once the
    // operation that produces it exists.
    return status === 'challenged' || status === 'superseded';
  });
}

export function outcomeContradictsExpectation(
  decisionId: string,
  outcomes: readonly OutcomeRecord[],
): boolean {
  return outcomes.some(
    o => o.decisionId === decisionId && o.expectationAssessment === 'contradicts',
  );
}

export function regimeChangedSince(
  decision: DecisionRecord,
  currentRegimes?: Record<string, string>,
): boolean {
  if (!decision.regimeRef || !currentRegimes) return false;
  const parsed = parseRegimeRef(decision.regimeRef);
  if (!parsed) return false;
  const current = currentRegimes[parsed.name];
  return current !== undefined && current !== parsed.version;
}

/**
 * The health flags for one decision, in `DECISION_HEALTH_FLAGS` order so the
 * result is deterministic and comparable across calls.
 */
export function computeHealthFlags(input: DecisionHealthInput): DecisionHealthFlag[] {
  const { decision, allDecisions, assumptions, outcomes, currentRegimes } = input;
  const flags: DecisionHealthFlag[] = [];
  if (restsOnChallengedAssumption(decision, assumptions)) {
    flags.push('rests-on-challenged-assumption');
  }
  if (outcomeContradictsExpectation(decision.id, outcomes)) {
    flags.push('outcome-contradicts-expectation');
  }
  if (isSuperseded(decision.id, allDecisions)) {
    flags.push('superseded');
  }
  if (regimeChangedSince(decision, currentRegimes)) {
    flags.push('regime-changed-since');
  }
  return flags;
}
