/**
 * The one mapping between hub catalog operation names (snake_case, as
 * HUB_OPERATIONS declares them) and the `tb.hub` SDK method names
 * (camelCase, as the execute sandbox exposes them).
 *
 * This lives in its own leaf module — with no imports — because two
 * surfaces need it and they must not diverge: execute-tool.ts builds the
 * `tb.hub` object from it, and search-index.ts stamps each hub catalog
 * entry with the `sdkMethod` that calls it. A catalog operation whose
 * discovered name is not callable is the defect this pairing prevents
 * (docs/KNOWN-ISSUES.md #3).
 */

/** camelCase SDK method -> snake_case hub operation. */
export const HUB_SDK_METHODS: Record<string, string> = {
  register: "register",
  quickJoin: "quick_join",
  listWorkspaces: "list_workspaces",
  whoami: "whoami",
  createWorkspace: "create_workspace",
  joinWorkspace: "join_workspace",
  transferCoordinator: "transfer_coordinator",
  getProfilePrompt: "get_profile_prompt",
  createProblem: "create_problem",
  claimProblem: "claim_problem",
  updateProblem: "update_problem",
  listProblems: "list_problems",
  addDependency: "add_dependency",
  removeDependency: "remove_dependency",
  readyProblems: "ready_problems",
  blockedProblems: "blocked_problems",
  createSubProblem: "create_sub_problem",
  createProposal: "create_proposal",
  reviewProposal: "review_proposal",
  mergeProposal: "merge_proposal",
  listProposals: "list_proposals",
  markConsensus: "mark_consensus",
  endorseConsensus: "endorse_consensus",
  listConsensus: "list_consensus",
  postMessage: "post_message",
  readChannel: "read_channel",
  postSystemMessage: "post_system_message",
  workspaceStatus: "workspace_status",
  workspaceDigest: "workspace_digest",
  recordDecision: "record_decision",
  recordAssumption: "record_assumption",
  challengeAssumption: "challenge_assumption",
  supersedeDecision: "supersede_decision",
  recordOutcome: "record_outcome",
  consultDecisions: "consult_decisions",
  declareWorkIntent: "declare_work_intent",
  recordWorkChange: "record_work_change",
  listImpacts: "list_impacts",
  acknowledgeImpact: "acknowledge_impact",
  readWorkspaceEvents: "read_workspace_events",
};

/**
 * snake_case hub operation -> fully-qualified `tb.hub` call, derived from
 * HUB_SDK_METHODS so there is nothing to keep in sync. Fully qualified
 * rather than bare (`tb.hub.reviewProposal`, not `reviewProposal`) so a
 * discovered entry needs no assembly to be callable.
 */
export const HUB_OPERATION_SDK_CALLS: Record<string, string> = Object.fromEntries(
  Object.entries(HUB_SDK_METHODS).map(([method, operation]) => [
    operation,
    `tb.hub.${method}`,
  ]),
);
