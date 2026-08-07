/**
 * WorkspaceCell aggregate state (RFC 0001).
 *
 * Runtime-portable pure types: no zod, no node: imports. Everything here is
 * reconstructible by folding `apply` over the event journal — that replay
 * invariant is what the deterministic verifier leans on, so no reducer may
 * mutate state without emitting an event that carries the mutation.
 *
 * Determinism rules (RFC 0001 §Cell command semantics):
 * - every generated ID derives from the command (commandId / stable keys),
 *   never from randomness inside the cell;
 * - every timestamp is the command's `issuedAt`, never a cell-local clock.
 */

import type { JsonValue } from '../canonical-json.js';

export type CellProblemStatus = 'open' | 'in-progress' | 'resolved' | 'closed';

/** Mirrors the hub `Problem` field names the façade needs for result compatibility. */
export interface CellProblem {
  id: string;
  workspaceId: string;
  title: string;
  description: string;
  createdBy: string;
  assignedTo?: string;
  status: CellProblemStatus;
  branchId?: string;
  branchFromThought: 0;
  resolution?: string;
  /** Structured completion payload (e.g. the canary's { paymentMethodIdType, sourceImpactId }). */
  output?: Record<string, JsonValue>;
  createdAt: string;
  updatedAt: string;
}

export interface CellMember {
  agentId: string;
  role: 'coordinator' | 'contributor';
  joinedAt: string;
}

export interface CellChannelMessage {
  id: string;
  agentId: string;
  content: string;
  timestamp: string;
  ref?: { sessionId?: string; thoughtNumber?: number; branchId?: string };
}

export interface WorkIntentV1 {
  intentId: string;
  workspaceId: string;
  problemId: string;
  agentId: string;
  teamRunId: string;
  nativeTaskId?: string;
  processRunId?: string;
  readScopes: string[];
  writeScopes: string[];
  contractRefs: string[];
  assumptionIds: string[];
  branchId?: string;
  leaseUntil: string;
  generation: number;
  declaredAt: string;
  updatedAt: string;
}

export type ImpactSeverity = 'blocking' | 'advisory';

export interface ImpactMatchingReason {
  kind: 'scope' | 'contractRef' | 'assumptionId';
  source: string;
  target: string;
}

export interface ImpactV1 {
  impactId: string;
  changeId: string;
  targetAgentId: string;
  targetProblemId: string;
  targetNativeTaskId?: string;
  targetIntentGeneration: number;
  severity: ImpactSeverity;
  status: 'pending' | 'acknowledged';
  matchingReasons: ImpactMatchingReason[];
  disposition?: 'accepted' | 'not_applicable';
  note?: string;
  detectedAt: string;
  acknowledgedAt?: string;
}

export interface WorkChangeV1 {
  changeId: string;
  workspaceId: string;
  agentId: string;
  kind: string;
  summary: string;
  scopes: string[];
  contractRefs: string[];
  assumptionIds: string[];
  severity: ImpactSeverity;
  recordedAt: string;
}

export interface CellWorkspaceState {
  schemaVersion: 'workspace-state-v1';
  workspace: {
    id: string;
    name: string;
    description: string;
    createdBy: string;
    createdAt: string;
    updatedAt: string;
  };
  /** agentId → member record */
  members: Record<string, CellMember>;
  /** problemId → problem */
  problems: Record<string, CellProblem>;
  /** problemId → ordered messages */
  channels: Record<string, CellChannelMessage[]>;
  /** intentId → intent; intentId is the stable key `int:<agentId>:<problemId>` */
  intents: Record<string, WorkIntentV1>;
  /** impactId → impact */
  impacts: Record<string, ImpactV1>;
  /** changeId → change */
  changes: Record<string, WorkChangeV1>;
}

/** Stable intent key: one active intent per (agent, problem); re-declaring bumps `generation`. */
export function intentKey(agentId: string, problemId: string): string {
  return `int:${agentId}:${problemId}`;
}

/** Deterministic impact identity (RFC 0001: at most one per (changeId, targetAgentId, intentGeneration)). */
export function impactId(changeId: string, targetAgentId: string, intentGeneration: number): string {
  return `imp:${changeId}:${targetAgentId}:${intentGeneration}`;
}

/**
 * Event drafts produced by the reducer. The Worker (or test harness) stamps
 * sequence / aggregateRevision / eventId / actor / occurredAt when persisting;
 * `data` must already carry everything `apply` needs to replay the mutation.
 */
export interface CellEventDraft {
  type: string;
  data: Record<string, JsonValue>;
}

export const CELL_EVENT_TYPES = [
  'workspace_created',
  'workspace_joined',
  'problem_created',
  'problem_claimed',
  'problem_status_changed',
  'message_posted',
  'work_intent_declared',
  'work_change_recorded',
  'impact_detected',
  'impact_acknowledged',
] as const;

export type CellEventType = (typeof CELL_EVENT_TYPES)[number];
