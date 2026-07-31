/**
 * TypeScript type declarations for the `tb` SDK object.
 * Embedded in the thoughtbox_execute tool description so the LLM
 * gets type hints without loading operation catalogs.
 *
 * IMPORTANT: This file must stay in sync with the source Zod schemas:
 * - thought: src/thought/tool.ts (thoughtToolInputSchema); the per-thoughtType
 *            payload requirements come from THOUGHT_TYPE_REQUIRED_FIELDS in
 *            src/thought/operations.ts, which transcribes the validator
 * - session: src/sessions/tool.ts (sessionToolInputSchema)
 * - hub:     src/hub/operations.ts (HUB_OPERATIONS catalog)
 * - vars:    src/code-mode/vars-operations.ts (VARS_OPERATIONS catalog)
 */

export const TB_SDK_TYPES = `\`\`\`ts
type HubProfile = "MANAGER" | "ARCHITECT" | "DEBUGGER" | "SECURITY" | "RESEARCHER" | "REVIEWER";

interface TB {
  /**
   * Submit a structured thought. Source: src/thought/tool.ts
   *
   * thoughtType selects a payload that the server REQUIRES — the call throws
   * without it, and thought/nextThoughtNeeded/thoughtType alone are never
   * enough for a typed form:
   *   decision_frame    confidence + options (non-empty, exactly one selected: true)
   *   action_report     actionResult { success, reversible, tool, target }
   *   belief_snapshot   beliefs.entities (non-empty; item keys unvalidated)
   *   assumption_update assumptionChange.newStatus
   *   context_snapshot  contextData (any object)
   *   progress          progressData { task, status }
   *   action_receipt    receiptData { toolName, match }
   *   reasoning, finding, synthesis, question, conclusion — no payload
   * Optional keys inside those payloads (sideEffects, constraints, risks,
   * expected/actual, reason, entity name/state, assumption text/oldStatus, ...)
   * are stored but never required.
   * The required strings must be non-empty: "" is rejected for
   * actionResult.tool, actionResult.target, progressData.task and
   * receiptData.toolName.
   * branchId additionally requires branchFromThought.
   */
  thought(input: {
    thought: string;
    thoughtType: "reasoning" | "decision_frame" | "action_report" | "belief_snapshot" | "assumption_update" | "context_snapshot" | "progress" | "action_receipt" | "finding" | "synthesis" | "question" | "conclusion";
    nextThoughtNeeded: boolean;
    thoughtNumber?: number;
    totalThoughts?: number;
    isRevision?: boolean;
    revisesThought?: number;
    branchFromThought?: number;
    branchId?: string;
    needsMoreThoughts?: boolean;
    includeGuide?: boolean;
    sessionTitle?: string;
    sessionTags?: string[];
    verbose?: boolean;
    confidence?: "high" | "medium" | "low";
    options?: Array<{ label: string; selected: boolean; reason?: string }>;
    actionResult?: { success: boolean; reversible: "yes" | "no" | "partial"; tool: string; target: string; sideEffects?: string[] };
    beliefs?: { entities: Array<{ name?: string; state?: string }>; constraints?: string[]; risks?: string[] };
    assumptionChange?: { text?: string; oldStatus?: string; newStatus: "believed" | "uncertain" | "refuted"; trigger?: string; downstream?: number[] };
    contextData?: { toolsAvailable?: string[]; systemPromptHash?: string; modelId?: string; constraints?: string[]; dataSourcesAccessed?: string[] };
    progressData?: { task: string; status: "pending" | "in_progress" | "done" | "blocked"; note?: string };
    receiptData?: { toolName: string; match: boolean; expected?: string; actual?: string; residual?: string; durationMs?: number };
    agentId?: string;
    agentName?: string;
  }): Promise<unknown>;

  /**
   * Session management. Source: src/sessions/tool.ts
   * Positional methods (get, resume) equally accept a single named-args
   * object, e.g. resume({ sessionId }).
   */
  session: {
    list(args?: { limit?: number; offset?: number; tags?: string[] }): Promise<unknown>;
    get(sessionId: string): Promise<unknown>;
    get(args: { sessionId: string }): Promise<unknown>;
    resume(sessionId: string): Promise<unknown>;
    resume(args: { sessionId: string }): Promise<unknown>;
    /** Structured thought-graph queries: exactly one of type | start+end | referencesThought | revisionsOf. */
    queryThoughts(args: { sessionId: string; type?: string; start?: number; end?: number; referencesThought?: number; revisionsOf?: number }): Promise<unknown>;
  };

  /**
   * Multi-agent hub coordination: workspaces, problems, proposals, consensus,
   * channels. Call register or quickJoin once per session — the returned
   * agentId is then implicit for every other call. Pass agentId explicitly
   * only to act as another agent registered in this session.
   *
   * These camelCase method names are what you call here; thoughtbox_search
   * lists the same operations under their snake_case wire names and carries
   * the callable name in each entry's sdkMethod field.
   * Source: src/hub/operations.ts
   */
  hub: {
    register(args: { name: string; profile?: HubProfile; clientInfo?: string }): Promise<unknown>;
    quickJoin(args: { name: string; workspaceId: string; profile?: HubProfile; clientInfo?: string }): Promise<unknown>;
    listWorkspaces(): Promise<unknown>;
    whoami(args?: { agentId?: string }): Promise<unknown>;
    createWorkspace(args: { name: string; description: string; agentId?: string }): Promise<unknown>;
    joinWorkspace(args: { workspaceId: string; agentId?: string }): Promise<unknown>;
    getProfilePrompt(args: { profile: HubProfile }): Promise<unknown>;
    createProblem(args: { workspaceId: string; title: string; description: string; agentId?: string }): Promise<unknown>;
    claimProblem(args: { workspaceId: string; problemId: string; branchId?: string; agentId?: string }): Promise<unknown>;
    updateProblem(args: { workspaceId: string; problemId: string; status: "open" | "in-progress" | "resolved" | "closed"; resolution?: string; agentId?: string }): Promise<unknown>;
    listProblems(args: { workspaceId: string; status?: "open" | "in-progress" | "resolved" | "closed"; assignedTo?: string }): Promise<unknown>;
    addDependency(args: { workspaceId: string; problemId: string; dependsOnProblemId: string; agentId?: string }): Promise<unknown>;
    removeDependency(args: { workspaceId: string; problemId: string; dependsOnProblemId: string; agentId?: string }): Promise<unknown>;
    readyProblems(args: { workspaceId: string }): Promise<unknown>;
    blockedProblems(args: { workspaceId: string }): Promise<unknown>;
    createSubProblem(args: { workspaceId: string; parentId: string; title: string; description: string; agentId?: string }): Promise<unknown>;
    createProposal(args: { workspaceId: string; title: string; description: string; sourceBranch: string; problemId?: string; agentId?: string }): Promise<unknown>;
    reviewProposal(args: { workspaceId: string; proposalId: string; verdict: "approve" | "request-changes" | "comment"; reasoning: string; thoughtRefs?: number[]; agentId?: string }): Promise<unknown>;
    /** Coordinator-only; requires at least one approve review — which is also what moves the proposal to "approved". The synthesis thought persists to the workspace main session. */
    mergeProposal(args: { workspaceId: string; proposalId: string; mergeMessage: string; agentId?: string }): Promise<unknown>;
    listProposals(args: { workspaceId: string; status?: "open" | "reviewing" | "approved" | "merged" | "rejected" }): Promise<unknown>;
    markConsensus(args: { workspaceId: string; name: string; description: string; thoughtRef: number; branchId?: string; agentId?: string }): Promise<unknown>;
    endorseConsensus(args: { workspaceId: string; consensusId: string; agentId?: string }): Promise<unknown>;
    listConsensus(args: { workspaceId: string }): Promise<unknown>;
    postMessage(args: { workspaceId: string; problemId: string; content: string; ref?: { sessionId?: string; thoughtNumber?: number; branchId?: string }; agentId?: string }): Promise<unknown>;
    readChannel(args: { workspaceId: string; problemId: string; since?: string }): Promise<unknown>;
    postSystemMessage(args: { workspaceId: string; problemId: string; content: string; ref?: { sessionId?: string; thoughtNumber?: number; branchId?: string } }): Promise<unknown>;
    workspaceStatus(args: { workspaceId: string }): Promise<unknown>;
    workspaceDigest(args: { workspaceId: string }): Promise<unknown>;
  };

  /**
   * Durable named variables (RLM-lite): store a JSON-serialisable value in
   * one thoughtbox_execute call and read it back in a later call within the
   * SAME MCP session, without threading it through your context window.
   * In-memory only — variables are lost when the session ends; nothing is
   * persisted. get() throws a clear error for unset names. Freely chainable
   * (does not count as the call's one state-mutating operation). Methods
   * also accept named-args form, e.g. set({ name, value }).
   * Source: src/code-mode/vars-operations.ts
   */
  vars: {
    set(name: string, value: unknown): Promise<{ name: string; bytes: number }>;
    get(name: string): Promise<unknown>;
    list(): Promise<{ vars: Array<{ name: string; bytes: number }>; count: number }>;
    delete(name: string): Promise<{ deleted: boolean }>;
  };
}
\`\`\``;
