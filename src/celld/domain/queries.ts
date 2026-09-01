/**
 * Read-only WorkspaceCell queries (RFC 0001 §Operation surface).
 *
 * Pure functions over the aggregate state. `read_workspace_events` is NOT
 * here — the event journal is a Worker-side table and the replay authority;
 * queries here answer from the snapshot only.
 */

import type { JsonValue } from '../canonical-json.js';
import { rejection, type CelldRejection } from '../errors.js';
import type { CellWorkspaceState } from './state.js';

export type QueryOutcome =
  | { ok: true; result: Record<string, JsonValue> }
  | { ok: false; rejection: CelldRejection };

export function query(
  state: CellWorkspaceState | null,
  operation: string,
  actorId: string,
  payload: Record<string, JsonValue>,
): QueryOutcome {
  if (state === null) {
    return { ok: false, rejection: rejection('WORKSPACE_NOT_INITIALIZED', 'Workspace cell state is not initialized') };
  }
  if (state.members[actorId] === undefined) {
    return {
      ok: false,
      rejection: rejection('NOT_WORKSPACE_MEMBER', `Agent ${actorId} is not a member of workspace ${state.workspace.id}`),
    };
  }

  switch (operation) {
    case 'list_problems': {
      const status = payload.status;
      const problems = Object.values(state.problems)
        .filter(p => status === undefined || p.status === status)
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
      return { ok: true, result: { problems: problems as unknown as JsonValue, count: problems.length } };
    }
    case 'read_channel': {
      const problemId = payload.problemId;
      if (typeof problemId !== 'string' || problemId.length === 0) {
        return { ok: false, rejection: rejection('VALIDATION_FAILED', `'problemId' must be a non-empty string`) };
      }
      if (state.problems[problemId] === undefined) {
        return { ok: false, rejection: rejection('NOT_FOUND', `Problem not found: ${problemId}`, { problemId }) };
      }
      const all = state.channels[problemId] ?? [];
      const limit = typeof payload.limit === 'number' && payload.limit > 0 ? Math.floor(payload.limit) : undefined;
      const messages = limit === undefined ? all : all.slice(-limit);
      return {
        ok: true,
        result: { problemId, messages: messages as unknown as JsonValue, count: messages.length, total: all.length },
      };
    }
    case 'list_impacts': {
      const targetAgentId = payload.targetAgentId;
      const status = payload.status;
      const impacts = Object.values(state.impacts)
        .filter(i => targetAgentId === undefined || i.targetAgentId === targetAgentId)
        .filter(i => status === undefined || i.status === status)
        .sort((a, b) => a.detectedAt.localeCompare(b.detectedAt) || a.impactId.localeCompare(b.impactId));
      return { ok: true, result: { impacts: impacts as unknown as JsonValue, count: impacts.length } };
    }
    case 'workspace_status': {
      const problems = Object.values(state.problems);
      const byStatus: Record<string, number> = {};
      for (const p of problems) byStatus[p.status] = (byStatus[p.status] ?? 0) + 1;
      return {
        ok: true,
        result: {
          workspace: state.workspace as unknown as JsonValue,
          members: Object.values(state.members) as unknown as JsonValue,
          problemCounts: byStatus,
          problemCount: problems.length,
          intentCount: Object.keys(state.intents).length,
          pendingImpactCount: Object.values(state.impacts).filter(i => i.status === 'pending').length,
        },
      };
    }
    case 'workspace_digest': {
      const open = Object.values(state.problems).filter(p => p.status === 'open' || p.status === 'in-progress');
      const pendingImpacts = Object.values(state.impacts).filter(i => i.status === 'pending');
      return {
        ok: true,
        result: {
          workspace: state.workspace as unknown as JsonValue,
          members: Object.values(state.members) as unknown as JsonValue,
          activeProblems: open as unknown as JsonValue,
          pendingImpacts: pendingImpacts as unknown as JsonValue,
          recentMessages: Object.entries(state.channels)
            .flatMap(([problemId, messages]) => messages.slice(-3).map(m => ({ problemId, ...m })))
            .sort((a, b) => a.timestamp.localeCompare(b.timestamp))
            .slice(-10) as unknown as JsonValue,
        },
      };
    }
    default:
      return { ok: false, rejection: rejection('VALIDATION_FAILED', `Unknown cell query: ${operation}`, { operation }) };
  }
}
