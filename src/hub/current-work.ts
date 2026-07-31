/**
 * Current-work bookkeeping — the other half of claimProblem.
 *
 * `claimProblem` stamps `currentWork` on the workspace agent record, and every
 * roster view (workspace_digest, workspace_status, the dashboard) reads it as
 * "what this agent is doing right now". Nothing used to clear it, so once a
 * problem reached a terminal state its assignee kept advertising finished work
 * and teammates routed around a slot that was actually free.
 */

import type { HubStorage, ProblemStatus } from './hub-types.js';

/** Problem statuses after which nobody is still working on the problem. */
const TERMINAL_STATUSES: ProblemStatus[] = ['resolved', 'closed'];

export function isTerminalProblemStatus(status: ProblemStatus): boolean {
  return TERMINAL_STATUSES.includes(status);
}

/**
 * Clears `currentWork` for every workspace agent pointed at `problemId`.
 *
 * Matches on the problem rather than on the assignee so a stale pointer is
 * cleared even when it belongs to an agent other than the one who resolved
 * the problem. Writes only when something actually changed, and is idempotent.
 */
export async function clearCurrentWorkOn(
  storage: HubStorage,
  workspaceId: string,
  problemId: string,
): Promise<void> {
  const workspace = await storage.getWorkspace(workspaceId);
  if (!workspace) return;

  const stale = workspace.agents.filter(a => a.currentWork === problemId);
  if (stale.length === 0) return;

  for (const agent of stale) delete agent.currentWork;
  workspace.updatedAt = new Date().toISOString();
  await storage.saveWorkspace(workspace);
}
