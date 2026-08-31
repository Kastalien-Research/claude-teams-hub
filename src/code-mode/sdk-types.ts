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

/**
 * celld-backed workspaces only (RFC 0001, canary): idempotent command
 * metadata, passed as \`command\` on create_workspace, join_workspace,
 * create_problem, claim_problem, update_problem, post_message, and the five
 * coordination methods. Ignored on filesystem workspaces. Retry with the
 * SAME id + payload on transport ambiguity only; a reused id with a
 * different payload is rejected (IDEMPOTENCY_KEY_REUSED).
 */
interface CommandMetadataV1 {
  id: string;
  expectedRevision?: number;
  teamRunId?: string;
  nativeTaskId?: string;
  processRunId?: string;
  promptVersion?: string;
  correlationId?: string;
  causationId?: string;
}

/**
 * Present, additively, on every result from a celld-backed workspace's
 * operations — never removes an existing field.
 */
interface CoordinationResultV1 {
  backend: "celld";
  commandId?: string;
  revision: number;
  replayed?: boolean;
  firstEventSequence?: number;
  lastEventSequence?: number;
}

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
   * channels, decisions. Call register or quickJoin ONCE, keep the returned agentId, and
   * pass it as agentId on every other call — identity is a durable record, so
   * the same agentId works from any connection or session and re-registering
   * mints a second agent instead of recovering the first. A call with no
   * agentId acts as the process identity (THOUGHTBOX_AGENT_ID /
   * THOUGHTBOX_AGENT_NAME) if one is configured, and otherwise fails.
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
    /** backend defaults to "filesystem"; "celld" (RFC 0001, canary) is the only opt-in gate for the coordination methods below. command is celld-backed workspaces only. */
    createWorkspace(args: { name: string; description: string; backend?: "filesystem" | "celld"; command?: CommandMetadataV1; agentId?: string }): Promise<unknown>;
    joinWorkspace(args: { workspaceId: string; command?: CommandMetadataV1; agentId?: string }): Promise<unknown>;
    /** Coordinator-only; hands the role to another member. Not needed after a reconnect — coordinator power is durable. */
    transferCoordinator(args: { workspaceId: string; toAgentId: string; agentId?: string }): Promise<unknown>;
    getProfilePrompt(args: { profile: HubProfile }): Promise<unknown>;
    createProblem(args: { workspaceId: string; title: string; description: string; command?: CommandMetadataV1; agentId?: string }): Promise<unknown>;
    claimProblem(args: { workspaceId: string; problemId: string; branchId?: string; command?: CommandMetadataV1; agentId?: string }): Promise<unknown>;
    /** intentGeneration is required when completing (resolved/closed) a problem you hold a work intent on (celld backend) — cite the current generation from declareWorkIntent, else WORK_INTENT_GENERATION_STALE. */
    updateProblem(args: { workspaceId: string; problemId: string; status: "open" | "in-progress" | "resolved" | "closed"; resolution?: string; intentGeneration?: number; command?: CommandMetadataV1; agentId?: string }): Promise<unknown>;
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
    postMessage(args: { workspaceId: string; problemId: string; content: string; ref?: { sessionId?: string; thoughtNumber?: number; branchId?: string }; command?: CommandMetadataV1; agentId?: string }): Promise<unknown>;
    readChannel(args: { workspaceId: string; problemId: string; since?: string }): Promise<unknown>;
    postSystemMessage(args: { workspaceId: string; problemId: string; content: string; ref?: { sessionId?: string; thoughtNumber?: number; branchId?: string } }): Promise<unknown>;
    workspaceStatus(args: { workspaceId: string }): Promise<unknown>;
    workspaceDigest(args: { workspaceId: string }): Promise<unknown>;
    /**
     * Decision ledger — hub-global, so no workspaceId scopes it and any
     * registered agent may write. Append-only: there is no update method, and
     * nothing anywhere takes a confidence or probability. Consult the scope
     * BEFORE deciding in it; correct a decision with supersedeDecision, never
     * by recording a second one that contradicts the first silently.
     */
    recordDecision(args: { scope: string; statement: string; rationale: string; assumptionIds?: string[]; alternatives?: Array<{ label: string; reason?: string }>; expectedOutcome?: string; evidenceRefs?: string[]; thoughtRef?: { sessionId?: string; thoughtNumber?: number; branchId?: string }; regimeRef?: string; workspaceId?: string; taskRef?: string; slug?: string; agentId?: string }): Promise<unknown>;
    recordAssumption(args: { statement: string; scope?: string; agentId?: string }): Promise<unknown>;
    /** Additive and never withdrawn; flips the assumption's derived status to 'challenged'. */
    challengeAssumption(args: { assumptionId: string; reason: string; evidenceRefs?: string[]; agentId?: string }): Promise<unknown>;
    /** scope defaults to the superseded decision's scope. Refused if that decision already has a successor. */
    supersedeDecision(args: { supersedes: string; statement: string; rationale: string; scope?: string; assumptionIds?: string[]; alternatives?: Array<{ label: string; reason?: string }>; expectedOutcome?: string; evidenceRefs?: string[]; thoughtRef?: { sessionId?: string; thoughtNumber?: number; branchId?: string }; regimeRef?: string; workspaceId?: string; taskRef?: string; slug?: string; agentId?: string }): Promise<unknown>;
    /** data is raw measurements only; expectationAssessment is the separate adjudication of them. */
    recordOutcome(args: { decisionId: string; kind: string; data: Record<string, unknown>; expectationAssessment?: "consistent" | "contradicts" | "unclear"; note?: string; agentId?: string }): Promise<unknown>;
    /** Scope matching runs both ways; health flags are computed at read time, never stored. */
    consultDecisions(args: { scope: string; currentRegimes?: Record<string, string>; includeSuperseded?: boolean }): Promise<unknown>;

    /**
     * Coordination — celld-backed workspaces only (RFC 0001, canary). Every
     * method below is rejected with OPERATION_REQUIRES_CELLD_BACKEND on a
     * filesystem workspace, and every result additively carries a
     * \`coordination: CoordinationResultV1\` field on a celld workspace.
     */
    /** leaseUntil (ISO 8601) is required; the intent is treated as expired for matching after it passes. */
    declareWorkIntent(args: { workspaceId: string; problemId: string; readScopes?: string[]; writeScopes?: string[]; contractRefs?: string[]; assumptionIds?: string[]; branchId?: string; leaseUntil: string; command?: CommandMetadataV1; agentId?: string }): Promise<unknown>;
    /** Matches against every OTHER agent's active, unexpired work intents; the change author is excluded. 'blocking' severity gates that agent's problem completion until acknowledged. */
    recordWorkChange(args: { workspaceId: string; kind: string; summary: string; scopes?: string[]; contractRefs?: string[]; assumptionIds?: string[]; severity: "blocking" | "advisory"; command?: CommandMetadataV1; agentId?: string }): Promise<unknown>;
    /** Read-only. */
    listImpacts(args: { workspaceId: string; targetAgentId?: string; status?: "pending" | "acknowledged" }): Promise<unknown>;
    /** Durable; must precede completing a problem with a pending blocking impact against it. */
    acknowledgeImpact(args: { workspaceId: string; impactId: string; disposition: "accepted" | "not_applicable"; note?: string; command?: CommandMetadataV1; agentId?: string }): Promise<unknown>;
    /** The durable replay authority — SSE is only an ephemeral hint; dedupe by eventId. after defaults to 0, limit defaults to 100. Read-only. */
    readWorkspaceEvents(args: { workspaceId: string; after?: number; limit?: number }): Promise<unknown>;
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
