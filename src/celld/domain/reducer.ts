/**
 * Pure WorkspaceCell command reducer (RFC 0001 §Cell command semantics).
 *
 * `reduce(state, command, currentRevision)` decides one command: it returns
 * either an accepted outcome (post-state + event drafts + result) or a domain
 * rejection. It never throws for domain conditions — the Worker persists
 * rejections as receipts without advancing revision or sequence, and a THROW
 * out of the storage transaction would roll the receipt back too (probed
 * celld v0.1.0 behavior). It has no clock and no randomness: every timestamp
 * is the command's `issuedAt`, every generated ID derives from the command.
 *
 * `apply(state, event)` replays one event. The invariant — folding `apply`
 * over an accepted command's events from the prior state equals the reducer's
 * post-state — is enforced in tests and is what the canary's deterministic
 * verifier uses as the replay authority.
 */

import type { JsonValue } from '../canonical-json.js';
import { rejection, type CelldRejection } from '../errors.js';
import {
  impactId as impactIdFor,
  intentKey,
  type CellChannelMessage,
  type CellEventDraft,
  type CellMember,
  type CellProblem,
  type CellProblemStatus,
  type CellWorkspaceState,
  type ImpactMatchingReason,
  type ImpactSeverity,
  type ImpactV1,
  type WorkChangeV1,
  type WorkIntentV1,
} from './state.js';

export interface ReducerCommand {
  commandId: string;
  operation: string;
  workspaceId: string;
  actorId: string;
  issuedAt: string;
  expectedRevision?: number;
  context: { teamRunId?: string; nativeTaskId?: string; processRunId?: string };
  payload: Record<string, JsonValue>;
}

export type ReducerOutcome =
  | {
      ok: true;
      state: CellWorkspaceState;
      events: CellEventDraft[];
      result: Record<string, JsonValue>;
    }
  | { ok: false; rejection: CelldRejection };

const TERMINAL_STATUSES: readonly CellProblemStatus[] = ['resolved', 'closed'];
const PROBLEM_STATUSES: readonly CellProblemStatus[] = ['open', 'in-progress', 'resolved', 'closed'];

// =============================================================================
// Payload validation helpers (VALIDATION_FAILED, never a throw)
// =============================================================================

function str(payload: Record<string, JsonValue>, key: string): string | CelldRejection {
  const v = payload[key];
  if (typeof v !== 'string' || v.length === 0) {
    return rejection('VALIDATION_FAILED', `'${key}' must be a non-empty string`, { key });
  }
  return v;
}

function optStr(payload: Record<string, JsonValue>, key: string): string | undefined | CelldRejection {
  const v = payload[key];
  if (v === undefined) return undefined;
  if (typeof v !== 'string') return rejection('VALIDATION_FAILED', `'${key}' must be a string`, { key });
  return v;
}

function strArray(payload: Record<string, JsonValue>, key: string): string[] | CelldRejection {
  const v = payload[key];
  if (v === undefined) return [];
  if (!Array.isArray(v) || v.some(item => typeof item !== 'string')) {
    return rejection('VALIDATION_FAILED', `'${key}' must be an array of strings`, { key });
  }
  return v as string[];
}

function isRejection(v: unknown): v is CelldRejection {
  return typeof v === 'object' && v !== null && 'code' in v && 'retryable' in v;
}

// =============================================================================
// Scope matching (RFC 0001 §Work intent and impact model)
// =============================================================================

function normalizeScope(scope: string): string[] {
  return scope.split('/').filter(seg => seg.length > 0);
}

/** Exact, ancestor, or descendant match at segment boundaries: a/b ~ a/b/c and a, never a/bc. */
export function scopesOverlap(a: string, b: string): boolean {
  const sa = normalizeScope(a);
  const sb = normalizeScope(b);
  if (sa.length === 0 || sb.length === 0) return false;
  const n = Math.min(sa.length, sb.length);
  for (let i = 0; i < n; i++) {
    if (sa[i] !== sb[i]) return false;
  }
  return true;
}

// =============================================================================
// reduce
// =============================================================================

export function reduce(
  state: CellWorkspaceState | null,
  command: ReducerCommand,
  currentRevision: number,
): ReducerOutcome {
  const { operation, payload } = command;

  if (operation === 'create_workspace') {
    return createWorkspace(state, command);
  }

  if (state === null) {
    return {
      ok: false,
      rejection: rejection(
        'WORKSPACE_NOT_INITIALIZED',
        `Workspace ${command.workspaceId} has no initialized cell state`,
      ),
    };
  }

  if (state.members[command.actorId] === undefined) {
    if (operation === 'join_workspace') return joinWorkspace(state, command);
    return {
      ok: false,
      rejection: rejection(
        'NOT_WORKSPACE_MEMBER',
        `Agent ${command.actorId} is not a member of workspace ${command.workspaceId}`,
        { agentId: command.actorId },
      ),
    };
  }

  // Optimistic concurrency: an expectedRevision on any mutation must match.
  if (command.expectedRevision !== undefined && command.expectedRevision !== currentRevision) {
    return {
      ok: false,
      rejection: rejection(
        'REVISION_CONFLICT',
        `expectedRevision ${command.expectedRevision} does not match aggregate revision ${currentRevision}`,
        { expectedRevision: command.expectedRevision, aggregateRevision: currentRevision },
      ),
    };
  }

  switch (operation) {
    case 'join_workspace':
      return {
        ok: false,
        rejection: rejection(
          'ALREADY_WORKSPACE_MEMBER',
          `Agent ${command.actorId} is already a member of workspace ${command.workspaceId}`,
        ),
      };
    case 'create_problem':
      return createProblem(state, command);
    case 'claim_problem':
      return claimProblem(state, command);
    case 'update_problem':
      return updateProblem(state, command);
    case 'post_message':
      return postMessage(state, command);
    case 'declare_work_intent':
      return declareWorkIntent(state, command);
    case 'record_work_change':
      return recordWorkChange(state, command);
    case 'acknowledge_impact':
      return acknowledgeImpact(state, command);
    default:
      return {
        ok: false,
        rejection: rejection('VALIDATION_FAILED', `Unknown cell mutation: ${operation}`, {
          operation,
        }),
      };
  }
}

// =============================================================================
// Command handlers
// =============================================================================

function createWorkspace(state: CellWorkspaceState | null, command: ReducerCommand): ReducerOutcome {
  if (state !== null) {
    return {
      ok: false,
      rejection: rejection('VALIDATION_FAILED', `Workspace ${command.workspaceId} is already initialized`),
    };
  }
  const name = str(command.payload, 'name');
  if (isRejection(name)) return { ok: false, rejection: name };
  const description = str(command.payload, 'description');
  if (isRejection(description)) return { ok: false, rejection: description };

  const member: CellMember = { agentId: command.actorId, role: 'coordinator', joinedAt: command.issuedAt };
  const workspace = {
    id: command.workspaceId,
    name,
    description,
    createdBy: command.actorId,
    createdAt: command.issuedAt,
    updatedAt: command.issuedAt,
  };
  const next: CellWorkspaceState = {
    schemaVersion: 'workspace-state-v1',
    workspace,
    members: { [command.actorId]: member },
    problems: {},
    channels: {},
    intents: {},
    impacts: {},
    changes: {},
  };
  return {
    ok: true,
    state: next,
    events: [
      {
        type: 'workspace_created',
        data: { workspace: workspace as unknown as JsonValue, creator: member as unknown as JsonValue } as Record<string, JsonValue>,
      },
    ],
    result: {
      workspaceId: command.workspaceId,
      name,
      description,
      createdBy: command.actorId,
      createdAt: command.issuedAt,
    },
  };
}

function joinWorkspace(state: CellWorkspaceState, command: ReducerCommand): ReducerOutcome {
  const member: CellMember = { agentId: command.actorId, role: 'contributor', joinedAt: command.issuedAt };
  const next = structuredClone(state);
  next.members[command.actorId] = member;
  next.workspace.updatedAt = command.issuedAt;
  return {
    ok: true,
    state: next,
    events: [
      {
        type: 'workspace_joined',
        data: { member: member as unknown as JsonValue, updatedAt: command.issuedAt } as Record<string, JsonValue>,
      },
    ],
    result: { workspaceId: command.workspaceId, agentId: command.actorId, role: 'contributor' },
  };
}

function createProblem(state: CellWorkspaceState, command: ReducerCommand): ReducerOutcome {
  const title = str(command.payload, 'title');
  if (isRejection(title)) return { ok: false, rejection: title };
  const description = str(command.payload, 'description');
  if (isRejection(description)) return { ok: false, rejection: description };

  const id = `prob:${command.commandId}`;
  if (state.problems[id] !== undefined) {
    return { ok: false, rejection: rejection('VALIDATION_FAILED', `Problem ${id} already exists`) };
  }
  const problem: CellProblem = {
    id,
    workspaceId: command.workspaceId,
    title,
    description,
    createdBy: command.actorId,
    status: 'open',
    branchFromThought: 0,
    createdAt: command.issuedAt,
    updatedAt: command.issuedAt,
  };
  const next = structuredClone(state);
  next.problems[id] = problem;
  next.channels[id] = [];
  return {
    ok: true,
    state: next,
    events: [{ type: 'problem_created', data: { problem: problem as unknown as JsonValue } as Record<string, JsonValue> }],
    result: { problem: problem as unknown as JsonValue },
  };
}

function claimProblem(state: CellWorkspaceState, command: ReducerCommand): ReducerOutcome {
  const problemId = str(command.payload, 'problemId');
  if (isRejection(problemId)) return { ok: false, rejection: problemId };
  const problem = state.problems[problemId];
  if (problem === undefined) {
    return { ok: false, rejection: rejection('NOT_FOUND', `Problem not found: ${problemId}`, { problemId }) };
  }
  if (TERMINAL_STATUSES.includes(problem.status)) {
    return {
      ok: false,
      rejection: rejection('VALIDATION_FAILED', `Problem ${problemId} is ${problem.status}`, {
        problemId,
        status: problem.status,
      }),
    };
  }
  if (problem.assignedTo !== undefined) {
    return {
      ok: false,
      rejection: rejection('PROBLEM_ALREADY_CLAIMED', `Problem already claimed by ${problem.assignedTo}`, {
        problemId,
        assignedTo: problem.assignedTo,
      }),
    };
  }
  const branchIdInput = optStr(command.payload, 'branchId');
  if (isRejection(branchIdInput)) return { ok: false, rejection: branchIdInput };
  const branchId = branchIdInput ?? `${command.actorId}/${problemId}`;

  const next = structuredClone(state);
  const updated = next.problems[problemId] as CellProblem;
  updated.assignedTo = command.actorId;
  updated.status = 'in-progress';
  updated.branchId = branchId;
  updated.updatedAt = command.issuedAt;
  return {
    ok: true,
    state: next,
    events: [
      {
        type: 'problem_claimed',
        data: {
          problemId,
          assignedTo: command.actorId,
          branchId,
          status: 'in-progress',
          updatedAt: command.issuedAt,
        },
      },
    ],
    result: { problem: updated as unknown as JsonValue, branchId, branchFromThought: 0 },
  };
}

function updateProblem(state: CellWorkspaceState, command: ReducerCommand): ReducerOutcome {
  const problemId = str(command.payload, 'problemId');
  if (isRejection(problemId)) return { ok: false, rejection: problemId };
  const problem = state.problems[problemId];
  if (problem === undefined) {
    return { ok: false, rejection: rejection('NOT_FOUND', `Problem not found: ${problemId}`, { problemId }) };
  }
  const statusInput = optStr(command.payload, 'status');
  if (isRejection(statusInput)) return { ok: false, rejection: statusInput };
  if (statusInput !== undefined && !PROBLEM_STATUSES.includes(statusInput as CellProblemStatus)) {
    return {
      ok: false,
      rejection: rejection('VALIDATION_FAILED', `Invalid problem status: ${statusInput}`, { status: statusInput }),
    };
  }
  const status = statusInput as CellProblemStatus | undefined;
  const resolution = optStr(command.payload, 'resolution');
  if (isRejection(resolution)) return { ok: false, rejection: resolution };
  const output = command.payload.output;
  if (output !== undefined && (typeof output !== 'object' || output === null || Array.isArray(output))) {
    return { ok: false, rejection: rejection('VALIDATION_FAILED', `'output' must be an object`) };
  }

  // Completion gates (RFC 0001): only when moving to a terminal status.
  if (status !== undefined && TERMINAL_STATUSES.includes(status)) {
    const intent = state.intents[intentKey(command.actorId, problemId)];
    if (intent !== undefined) {
      const cited = command.payload.intentGeneration;
      if (typeof cited !== 'number' || cited !== intent.generation) {
        return {
          ok: false,
          rejection: rejection(
            'WORK_INTENT_GENERATION_STALE',
            `Completion cited intent generation ${String(cited)} but the current generation is ${intent.generation}`,
            { citedGeneration: (cited ?? null) as JsonValue, currentGeneration: intent.generation },
          ),
        };
      }
      const pendingBlocking = Object.values(state.impacts)
        .filter(
          impact =>
            impact.targetAgentId === command.actorId &&
            impact.targetProblemId === problemId &&
            impact.severity === 'blocking' &&
            impact.status === 'pending',
        )
        .map(impact => impact.impactId)
        .sort();
      if (pendingBlocking.length > 0) {
        return {
          ok: false,
          rejection: rejection(
            'BLOCKING_IMPACT_UNACKNOWLEDGED',
            `Completion blocked by ${pendingBlocking.length} unacknowledged blocking impact(s)`,
            { impactIds: pendingBlocking },
          ),
        };
      }
    }
  }

  const next = structuredClone(state);
  const updated = next.problems[problemId] as CellProblem;
  if (status !== undefined) updated.status = status;
  if (resolution !== undefined) updated.resolution = resolution;
  if (output !== undefined) updated.output = output as Record<string, JsonValue>;
  updated.updatedAt = command.issuedAt;

  const data: Record<string, JsonValue> = { problemId, updatedAt: command.issuedAt };
  if (status !== undefined) data.status = status;
  if (resolution !== undefined) data.resolution = resolution;
  if (output !== undefined) data.output = output;
  return {
    ok: true,
    state: next,
    events: [{ type: 'problem_status_changed', data }],
    result: { problem: updated as unknown as JsonValue },
  };
}

function postMessage(state: CellWorkspaceState, command: ReducerCommand): ReducerOutcome {
  const problemId = str(command.payload, 'problemId');
  if (isRejection(problemId)) return { ok: false, rejection: problemId };
  const content = str(command.payload, 'content');
  if (isRejection(content)) return { ok: false, rejection: content };
  if (state.problems[problemId] === undefined) {
    return { ok: false, rejection: rejection('NOT_FOUND', `Problem not found: ${problemId}`, { problemId }) };
  }
  const message: CellChannelMessage = {
    id: `msg:${command.commandId}`,
    agentId: command.actorId,
    content,
    timestamp: command.issuedAt,
  };
  const next = structuredClone(state);
  (next.channels[problemId] ??= []).push(message);
  return {
    ok: true,
    state: next,
    events: [
      {
        type: 'message_posted',
        data: { problemId, message: message as unknown as JsonValue } as Record<string, JsonValue>,
      },
    ],
    result: { problemId, message: message as unknown as JsonValue },
  };
}

function declareWorkIntent(state: CellWorkspaceState, command: ReducerCommand): ReducerOutcome {
  const problemId = str(command.payload, 'problemId');
  if (isRejection(problemId)) return { ok: false, rejection: problemId };
  if (state.problems[problemId] === undefined) {
    return { ok: false, rejection: rejection('NOT_FOUND', `Problem not found: ${problemId}`, { problemId }) };
  }
  const leaseUntil = str(command.payload, 'leaseUntil');
  if (isRejection(leaseUntil)) return { ok: false, rejection: leaseUntil };
  // An unparseable lease makes `Date.parse(leaseUntil) <= now` permanently
  // false in impact matching — the intent would never expire.
  if (Number.isNaN(Date.parse(leaseUntil))) {
    return {
      ok: false,
      rejection: rejection(
        'VALIDATION_FAILED',
        `leaseUntil must be a parseable ISO-8601 timestamp, got: ${leaseUntil}`,
        { leaseUntil },
      ),
    };
  }
  const readScopes = strArray(command.payload, 'readScopes');
  if (isRejection(readScopes)) return { ok: false, rejection: readScopes };
  const writeScopes = strArray(command.payload, 'writeScopes');
  if (isRejection(writeScopes)) return { ok: false, rejection: writeScopes };
  const contractRefs = strArray(command.payload, 'contractRefs');
  if (isRejection(contractRefs)) return { ok: false, rejection: contractRefs };
  const assumptionIds = strArray(command.payload, 'assumptionIds');
  if (isRejection(assumptionIds)) return { ok: false, rejection: assumptionIds };
  const branchId = optStr(command.payload, 'branchId');
  if (isRejection(branchId)) return { ok: false, rejection: branchId };
  const teamRunId = command.context.teamRunId;
  if (teamRunId === undefined) {
    return {
      ok: false,
      rejection: rejection('VALIDATION_FAILED', `declare_work_intent requires command context.teamRunId`),
    };
  }

  const key = intentKey(command.actorId, problemId);
  const existing = state.intents[key];
  const intent: WorkIntentV1 = {
    intentId: key,
    workspaceId: command.workspaceId,
    problemId,
    agentId: command.actorId,
    teamRunId,
    readScopes,
    writeScopes,
    contractRefs,
    assumptionIds,
    leaseUntil,
    generation: existing === undefined ? 1 : existing.generation + 1,
    declaredAt: existing?.declaredAt ?? command.issuedAt,
    updatedAt: command.issuedAt,
  };
  if (command.context.nativeTaskId !== undefined) intent.nativeTaskId = command.context.nativeTaskId;
  if (command.context.processRunId !== undefined) intent.processRunId = command.context.processRunId;
  if (branchId !== undefined) intent.branchId = branchId;

  const next = structuredClone(state);
  next.intents[key] = intent;
  return {
    ok: true,
    state: next,
    events: [
      { type: 'work_intent_declared', data: { intent: intent as unknown as JsonValue } as Record<string, JsonValue> },
    ],
    result: { intent: intent as unknown as JsonValue },
  };
}

function recordWorkChange(state: CellWorkspaceState, command: ReducerCommand): ReducerOutcome {
  const kind = str(command.payload, 'kind');
  if (isRejection(kind)) return { ok: false, rejection: kind };
  const summary = str(command.payload, 'summary');
  if (isRejection(summary)) return { ok: false, rejection: summary };
  const severityInput = str(command.payload, 'severity');
  if (isRejection(severityInput)) return { ok: false, rejection: severityInput };
  if (severityInput !== 'blocking' && severityInput !== 'advisory') {
    return {
      ok: false,
      rejection: rejection('VALIDATION_FAILED', `'severity' must be 'blocking' or 'advisory'`, {
        severity: severityInput,
      }),
    };
  }
  const severity = severityInput as ImpactSeverity;
  const scopes = strArray(command.payload, 'scopes');
  if (isRejection(scopes)) return { ok: false, rejection: scopes };
  const contractRefs = strArray(command.payload, 'contractRefs');
  if (isRejection(contractRefs)) return { ok: false, rejection: contractRefs };
  const assumptionIds = strArray(command.payload, 'assumptionIds');
  if (isRejection(assumptionIds)) return { ok: false, rejection: assumptionIds };

  const changeId = `chg:${command.commandId}`;
  const change: WorkChangeV1 = {
    changeId,
    workspaceId: command.workspaceId,
    agentId: command.actorId,
    kind,
    summary,
    scopes,
    contractRefs,
    assumptionIds,
    severity,
    recordedAt: command.issuedAt,
  };

  // Match active, unexpired intents of OTHER agents. Iteration is sorted for
  // determinism; one impact per intent, keyed (changeId, targetAgentId,
  // targetProblemId, intentGeneration) — intents are stored one per
  // (agent, problem), so keys are unique within a change and the completion
  // gate (which filters by targetProblemId) sees every impacted problem.
  const issuedAtMs = Date.parse(command.issuedAt);
  const impacts: ImpactV1[] = [];
  const intentIds = Object.keys(state.intents).sort();
  for (const id of intentIds) {
    const intent = state.intents[id] as WorkIntentV1;
    if (intent.agentId === command.actorId) continue;
    if (Date.parse(intent.leaseUntil) <= issuedAtMs) continue;

    const reasons: ImpactMatchingReason[] = [];
    for (const ref of contractRefs) {
      if (intent.contractRefs.includes(ref)) reasons.push({ kind: 'contractRef', source: ref, target: ref });
    }
    for (const assumption of assumptionIds) {
      if (intent.assumptionIds.includes(assumption)) {
        reasons.push({ kind: 'assumptionId', source: assumption, target: assumption });
      }
    }
    const intentScopes = [...intent.readScopes, ...intent.writeScopes];
    for (const changeScope of scopes) {
      for (const intentScope of intentScopes) {
        if (scopesOverlap(changeScope, intentScope)) {
          reasons.push({ kind: 'scope', source: changeScope, target: intentScope });
        }
      }
    }
    if (reasons.length === 0) continue;

    const impact: ImpactV1 = {
      impactId: impactIdFor(changeId, intent.agentId, intent.problemId, intent.generation),
      changeId,
      targetAgentId: intent.agentId,
      targetProblemId: intent.problemId,
      targetIntentGeneration: intent.generation,
      severity,
      status: 'pending',
      matchingReasons: reasons,
      detectedAt: command.issuedAt,
    };
    if (intent.nativeTaskId !== undefined) impact.targetNativeTaskId = intent.nativeTaskId;
    impacts.push(impact);
  }

  const next = structuredClone(state);
  next.changes[changeId] = change;
  const sortedImpacts = [...impacts].sort((a, b) => a.impactId.localeCompare(b.impactId));
  for (const impact of sortedImpacts) next.impacts[impact.impactId] = impact;

  const events: CellEventDraft[] = [
    { type: 'work_change_recorded', data: { change: change as unknown as JsonValue } as Record<string, JsonValue> },
    ...sortedImpacts.map(impact => ({
      type: 'impact_detected',
      data: { impact: impact as unknown as JsonValue } as Record<string, JsonValue>,
    })),
  ];
  return {
    ok: true,
    state: next,
    events,
    result: {
      change: change as unknown as JsonValue,
      impactIds: sortedImpacts.map(impact => impact.impactId),
      impactCount: sortedImpacts.length,
    },
  };
}

function acknowledgeImpact(state: CellWorkspaceState, command: ReducerCommand): ReducerOutcome {
  const id = str(command.payload, 'impactId');
  if (isRejection(id)) return { ok: false, rejection: id };
  const impact = state.impacts[id];
  if (impact === undefined) {
    return { ok: false, rejection: rejection('NOT_FOUND', `Impact not found: ${id}`, { impactId: id }) };
  }
  if (impact.targetAgentId !== command.actorId) {
    return {
      ok: false,
      rejection: rejection(
        'VALIDATION_FAILED',
        `Only the targeted agent (${impact.targetAgentId}) may acknowledge impact ${id}`,
        { impactId: id, targetAgentId: impact.targetAgentId },
      ),
    };
  }
  if (impact.status === 'acknowledged') {
    return {
      ok: false,
      rejection: rejection('VALIDATION_FAILED', `Impact ${id} is already acknowledged`, { impactId: id }),
    };
  }
  const disposition = str(command.payload, 'disposition');
  if (isRejection(disposition)) return { ok: false, rejection: disposition };
  if (disposition !== 'accepted' && disposition !== 'not_applicable') {
    return {
      ok: false,
      rejection: rejection('VALIDATION_FAILED', `'disposition' must be 'accepted' or 'not_applicable'`, {
        disposition,
      }),
    };
  }
  const note = optStr(command.payload, 'note');
  if (isRejection(note)) return { ok: false, rejection: note };

  const next = structuredClone(state);
  const updated = next.impacts[id] as ImpactV1;
  updated.status = 'acknowledged';
  updated.disposition = disposition;
  updated.acknowledgedAt = command.issuedAt;
  if (note !== undefined) updated.note = note;

  const data: Record<string, JsonValue> = {
    impactId: id,
    disposition,
    acknowledgedAt: command.issuedAt,
  };
  if (note !== undefined) data.note = note;
  return {
    ok: true,
    state: next,
    events: [{ type: 'impact_acknowledged', data }],
    result: { impact: updated as unknown as JsonValue },
  };
}

// =============================================================================
// apply — event replay
// =============================================================================

export interface AppliedCellEvent {
  type: string;
  data: Record<string, JsonValue>;
}

/** Replays one event. Throws on malformed journals — replay is trusted input. */
export function apply(state: CellWorkspaceState | null, event: AppliedCellEvent): CellWorkspaceState {
  if (event.type === 'workspace_created') {
    const workspace = event.data.workspace as unknown as CellWorkspaceState['workspace'];
    const creator = event.data.creator as unknown as CellMember;
    return {
      schemaVersion: 'workspace-state-v1',
      workspace: structuredClone(workspace),
      members: { [creator.agentId]: structuredClone(creator) },
      problems: {},
      channels: {},
      intents: {},
      impacts: {},
      changes: {},
    };
  }
  if (state === null) throw new Error(`Cannot apply ${event.type} before workspace_created`);
  const next = structuredClone(state);
  switch (event.type) {
    case 'workspace_joined': {
      const member = event.data.member as unknown as CellMember;
      next.members[member.agentId] = structuredClone(member);
      next.workspace.updatedAt = event.data.updatedAt as string;
      return next;
    }
    case 'problem_created': {
      const problem = event.data.problem as unknown as CellProblem;
      next.problems[problem.id] = structuredClone(problem);
      next.channels[problem.id] = [];
      return next;
    }
    case 'problem_claimed': {
      const problem = next.problems[event.data.problemId as string];
      if (problem === undefined) throw new Error(`problem_claimed for unknown problem ${String(event.data.problemId)}`);
      problem.assignedTo = event.data.assignedTo as string;
      problem.branchId = event.data.branchId as string;
      problem.status = event.data.status as CellProblemStatus;
      problem.updatedAt = event.data.updatedAt as string;
      return next;
    }
    case 'problem_status_changed': {
      const problem = next.problems[event.data.problemId as string];
      if (problem === undefined) {
        throw new Error(`problem_status_changed for unknown problem ${String(event.data.problemId)}`);
      }
      if (event.data.status !== undefined) problem.status = event.data.status as CellProblemStatus;
      if (event.data.resolution !== undefined) problem.resolution = event.data.resolution as string;
      if (event.data.output !== undefined) problem.output = event.data.output as Record<string, JsonValue>;
      problem.updatedAt = event.data.updatedAt as string;
      return next;
    }
    case 'message_posted': {
      const message = event.data.message as unknown as CellChannelMessage;
      (next.channels[event.data.problemId as string] ??= []).push(structuredClone(message));
      return next;
    }
    case 'work_intent_declared': {
      const intent = event.data.intent as unknown as WorkIntentV1;
      next.intents[intent.intentId] = structuredClone(intent);
      return next;
    }
    case 'work_change_recorded': {
      const change = event.data.change as unknown as WorkChangeV1;
      next.changes[change.changeId] = structuredClone(change);
      return next;
    }
    case 'impact_detected': {
      const impact = event.data.impact as unknown as ImpactV1;
      next.impacts[impact.impactId] = structuredClone(impact);
      return next;
    }
    case 'impact_acknowledged': {
      const impact = next.impacts[event.data.impactId as string];
      if (impact === undefined) throw new Error(`impact_acknowledged for unknown impact ${String(event.data.impactId)}`);
      impact.status = 'acknowledged';
      impact.disposition = event.data.disposition as ImpactV1['disposition'];
      impact.acknowledgedAt = event.data.acknowledgedAt as string;
      if (event.data.note !== undefined) impact.note = event.data.note as string;
      return next;
    }
    default:
      throw new Error(`Unknown cell event type: ${event.type}`);
  }
}
