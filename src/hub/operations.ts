/**
 * Operations Catalog for Hub Toolhost
 *
 * Defines all 35 hub operations organized by category with stage metadata.
 * Includes hub vocabulary for agent onboarding.
 */

import { REVIEW_VERDICTS } from './hub-types.js';
import { EXPECTATION_ASSESSMENTS } from './decision-types.js';

export interface OperationDefinition {
  name: string;
  title: string;
  description: string;
  category: string;
  stage: number;
  inputSchema: any;
  example?: any;
}

// =============================================================================
// Hub Vocabulary
// =============================================================================

export const HUB_VOCABULARY = {
  workspace: "A shared collaboration space where agents coordinate. Contains problems, proposals, consensus markers, and channels. Agents must join a workspace before participating.",
  problem: "A unit of work to be solved. Problems can have dependencies, sub-problems, and status tracking (open → in-progress → resolved → closed). Agents claim problems to work on them.",
  proposal: "A proposed solution to a problem. Includes a source branch reference for code changes. Other agents review and approve proposals before they can be merged.",
  consensus: "A decision marker that records agreement among agents. Tied to a thought reference for traceability. Other agents endorse consensus markers to show agreement.",
  channel: "A message stream scoped to a problem within a workspace. Used for discussion, status updates, and coordination between agents working on related problems.",
  agent: "A registered participant in the hub. Has a unique agentId, name, and optional profile. The agentId is a durable handle stored in the hub, not a connection-scoped session: pass it on every call to act as that agent, from any connection or client, for as long as the record exists.",
  profile: "An optional role specialization (MANAGER, ARCHITECT, DEBUGGER, SECURITY, RESEARCHER, REVIEWER) that provides domain-specific mental models and behavioral priming.",
  decision: "A durable choice about a scope (a module or path), recorded with its rationale, the alternatives rejected, and evidence a reader can check. Decisions are hub-global, not workspace-scoped, and append-only: a decision that turns out wrong is retired with supersede_decision, which writes a NEW record pointing at the old one. Nothing is ever edited in place, and no decision carries a confidence or probability.",
  assumption: "A belief a decision rests on, recorded separately so it can be challenged independently. Status is never stored — it is derived: an assumption is 'challenged' once any challenge exists, 'proposed' otherwise. Challenging one surfaces the flag 'rests-on-challenged-assumption' on every decision linked to it, which is how a fired reversal condition reaches the decisions it invalidates.",
  outcome: "Raw observed facts about what a decision actually produced, recorded after the fact. `data` holds measurements only, never a verdict; the optional `expectationAssessment` ('consistent' | 'contradicts' | 'unclear') is a separate categorical adjudication kept apart from the data so a reader can check one against the other.",
};

// =============================================================================
// Operations by Category
// =============================================================================

const IDENTITY_OPERATIONS: OperationDefinition[] = [
  {
    name: "register",
    title: "Register Agent",
    description: "Mint a durable agent identity. Returns a unique agentId — RECORD IT AND REUSE IT: pass it as agentId on every later hub call, including from a new connection, session, or client. Identity lives in hub storage, not in the connection, so re-registering is never how you recover an existing agent (it mints a second one). Every call registers a NEW agent.",
    category: "identity",
    stage: 0,
    inputSchema: {
      type: "object",
      properties: {
        name: {
          type: "string",
          description: "Display name for this agent",
        },
        profile: {
          type: "string",
          enum: ["MANAGER", "ARCHITECT", "DEBUGGER", "SECURITY", "RESEARCHER", "REVIEWER"],
          description: "Optional role profile for behavioral priming",
        },
        clientInfo: {
          type: "string",
          description: "Optional client identifier (e.g., 'claude-code-v1')",
        },
      },
      required: ["name"],
    },
    example: {
      name: "Architect Agent",
      profile: "ARCHITECT",
    },
  },
  {
    name: "quick_join",
    title: "Quick Join",
    description: "Register and join a workspace in a single call. Combines register + join_workspace for efficient onboarding. Returns an agentId to record and reuse. Pass your existing agentId to re-join or join a second workspace as yourself; omit it and a new agent is minted.",
    category: "identity",
    stage: 0,
    inputSchema: {
      type: "object",
      properties: {
        name: {
          type: "string",
          description: "Display name for this agent",
        },
        workspaceId: {
          type: "string",
          description: "Workspace to join immediately after registration",
        },
        profile: {
          type: "string",
          enum: ["MANAGER", "ARCHITECT", "DEBUGGER", "SECURITY", "RESEARCHER", "REVIEWER"],
          description: "Optional role profile",
        },
        clientInfo: {
          type: "string",
          description: "Optional client identifier",
        },
      },
      required: ["name", "workspaceId"],
    },
    example: {
      name: "Debugger",
      workspaceId: "ws-abc123",
      profile: "DEBUGGER",
    },
  },
  {
    name: "list_workspaces",
    title: "List Workspaces",
    description: "List all available workspaces. Does not require registration.",
    category: "identity",
    stage: 0,
    inputSchema: {
      type: "object",
      properties: {},
    },
    example: {},
  },
];

const AGENT_OPERATIONS: OperationDefinition[] = [
  {
    name: "whoami",
    title: "Who Am I",
    description: "Get an agent's identity, role, and workspace memberships. Reports the agent named by the call's agentId (or the THOUGHTBOX_AGENT_ID/THOUGHTBOX_AGENT_NAME identity when none is passed) — there is no per-connection 'current agent'.",
    category: "agent",
    stage: 1,
    inputSchema: {
      type: "object",
      properties: {},
    },
    example: {},
  },
  {
    name: "create_workspace",
    title: "Create Workspace",
    description: "Create a new collaboration workspace. The creating agent becomes the coordinator.",
    category: "agent",
    stage: 1,
    inputSchema: {
      type: "object",
      properties: {
        name: {
          type: "string",
          description: "Workspace name",
        },
        description: {
          type: "string",
          description: "Workspace purpose and scope",
        },
      },
      required: ["name", "description"],
    },
    example: {
      name: "Operations Catalogs",
      description: "Implement operations catalogs for all handler domains",
    },
  },
  {
    name: "join_workspace",
    title: "Join Workspace",
    description: "Join an existing workspace. Returns current workspace state including problems and proposals.",
    category: "agent",
    stage: 1,
    inputSchema: {
      type: "object",
      properties: {
        workspaceId: {
          type: "string",
          description: "ID of the workspace to join",
        },
      },
      required: ["workspaceId"],
    },
    example: {
      workspaceId: "ws-abc123",
    },
  },
  {
    name: "transfer_coordinator",
    title: "Transfer Coordinator",
    description: "Hand coordinatorship of a workspace to another agent that has joined it. Only the current coordinator may transfer. The previous coordinator becomes a contributor and loses merge_proposal; the new coordinator gains it. Coordinator power is durable — it survives disconnection, so transfer is for handing over deliberately, not for recovering a live coordinator.",
    category: "agent",
    stage: 1,
    inputSchema: {
      type: "object",
      properties: {
        workspaceId: { type: "string", description: "Workspace whose coordinator changes" },
        toAgentId: { type: "string", description: "agentId of the member receiving coordinatorship" },
      },
      required: ["workspaceId", "toAgentId"],
    },
    example: {
      workspaceId: "ws-abc123",
      toAgentId: "b3f1c2d4-5678-4abc-9def-0123456789ab",
    },
  },
  {
    name: "get_profile_prompt",
    title: "Get Profile Prompt",
    description: "Get the behavioral prompt for a specific profile role. Includes domain-specific mental models and guidelines.",
    category: "agent",
    stage: 1,
    inputSchema: {
      type: "object",
      properties: {
        profile: {
          type: "string",
          enum: ["MANAGER", "ARCHITECT", "DEBUGGER", "SECURITY", "RESEARCHER", "REVIEWER"],
          description: "Profile to retrieve",
        },
      },
      required: ["profile"],
    },
    example: {
      profile: "ARCHITECT",
    },
  },
];

const PROBLEM_OPERATIONS: OperationDefinition[] = [
  {
    name: "create_problem",
    title: "Create Problem",
    description: "Define a new problem to be solved within a workspace.",
    category: "problems",
    stage: 2,
    inputSchema: {
      type: "object",
      properties: {
        workspaceId: { type: "string", description: "Workspace ID" },
        title: { type: "string", description: "Problem title" },
        description: { type: "string", description: "Detailed problem description" },
      },
      required: ["workspaceId", "title", "description"],
    },
    example: {
      workspaceId: "ws-abc123",
      title: "Missing operations catalog for gateway",
      description: "Gateway operations have no self-service schema discovery",
    },
  },
  {
    name: "claim_problem",
    title: "Claim Problem",
    description: "Claim a problem to work on. Auto-generates a branch name if not provided. Sets status to in-progress.",
    category: "problems",
    stage: 2,
    inputSchema: {
      type: "object",
      properties: {
        workspaceId: { type: "string", description: "Workspace ID" },
        problemId: { type: "string", description: "Problem ID to claim" },
        branchId: { type: "string", description: "Optional thought branch name (auto-generated if omitted)" },
      },
      required: ["workspaceId", "problemId"],
    },
    example: {
      workspaceId: "ws-abc123",
      problemId: "prob-001",
    },
  },
  {
    name: "update_problem",
    title: "Update Problem",
    description: "Update problem status or resolution. Status transitions: open → in-progress → resolved → closed.",
    category: "problems",
    stage: 2,
    inputSchema: {
      type: "object",
      properties: {
        workspaceId: { type: "string", description: "Workspace ID" },
        problemId: { type: "string", description: "Problem ID" },
        status: { type: "string", enum: ["open", "in-progress", "resolved", "closed"], description: "New status" },
        resolution: { type: "string", description: "Resolution summary (for resolved/closed)" },
      },
      required: ["workspaceId", "problemId", "status"],
    },
    example: {
      workspaceId: "ws-abc123",
      problemId: "prob-001",
      status: "resolved",
      resolution: "Operations catalog implemented and registered",
    },
  },
  {
    name: "list_problems",
    title: "List Problems",
    description: "List all problems in a workspace with their status and assignments.",
    category: "problems",
    stage: 2,
    inputSchema: {
      type: "object",
      properties: {
        workspaceId: { type: "string", description: "Workspace ID" },
        status: { type: "string", enum: ["open", "in-progress", "resolved", "closed"], description: "Filter by problem status" },
        assignedTo: { type: "string", description: "Filter by assigned agent ID" },
      },
      required: ["workspaceId"],
    },
    example: {
      workspaceId: "ws-abc123",
    },
  },
  {
    name: "add_dependency",
    title: "Add Dependency",
    description: "Add a dependency between problems. The problem cannot be claimed until its dependency is resolved.",
    category: "problems",
    stage: 2,
    inputSchema: {
      type: "object",
      properties: {
        workspaceId: { type: "string", description: "Workspace ID" },
        problemId: { type: "string", description: "Problem that depends on another" },
        dependsOnProblemId: { type: "string", description: "Problem that must be resolved first" },
      },
      required: ["workspaceId", "problemId", "dependsOnProblemId"],
    },
    example: {
      workspaceId: "ws-abc123",
      problemId: "prob-002",
      dependsOnProblemId: "prob-001",
    },
  },
  {
    name: "remove_dependency",
    title: "Remove Dependency",
    description: "Remove a dependency between problems.",
    category: "problems",
    stage: 2,
    inputSchema: {
      type: "object",
      properties: {
        workspaceId: { type: "string", description: "Workspace ID" },
        problemId: { type: "string", description: "Problem to remove dependency from" },
        dependsOnProblemId: { type: "string", description: "Dependency to remove" },
      },
      required: ["workspaceId", "problemId", "dependsOnProblemId"],
    },
    example: {
      workspaceId: "ws-abc123",
      problemId: "prob-002",
      dependsOnProblemId: "prob-001",
    },
  },
  {
    name: "ready_problems",
    title: "Ready Problems",
    description: "List problems that are ready to claim (no unresolved dependencies, status is open).",
    category: "problems",
    stage: 2,
    inputSchema: {
      type: "object",
      properties: {
        workspaceId: { type: "string", description: "Workspace ID" },
      },
      required: ["workspaceId"],
    },
    example: {
      workspaceId: "ws-abc123",
    },
  },
  {
    name: "blocked_problems",
    title: "Blocked Problems",
    description: "List problems that are blocked by unresolved dependencies.",
    category: "problems",
    stage: 2,
    inputSchema: {
      type: "object",
      properties: {
        workspaceId: { type: "string", description: "Workspace ID" },
      },
      required: ["workspaceId"],
    },
    example: {
      workspaceId: "ws-abc123",
    },
  },
  {
    name: "create_sub_problem",
    title: "Create Sub-Problem",
    description: "Create a sub-problem under an existing parent problem. Sub-problems inherit workspace scope.",
    category: "problems",
    stage: 2,
    inputSchema: {
      type: "object",
      properties: {
        workspaceId: { type: "string", description: "Workspace ID" },
        parentId: { type: "string", description: "Parent problem ID" },
        title: { type: "string", description: "Sub-problem title" },
        description: { type: "string", description: "Sub-problem description" },
      },
      required: ["workspaceId", "parentId", "title", "description"],
    },
    example: {
      workspaceId: "ws-abc123",
      parentId: "prob-001",
      title: "Create gateway/operations.ts",
      description: "Extract schemas from gateway-handler.ts into operations catalog",
    },
  },
];

const PROPOSAL_OPERATIONS: OperationDefinition[] = [
  {
    name: "create_proposal",
    title: "Create Proposal",
    description: "Propose a solution to a problem. References a thought branch containing the work.",
    category: "proposals",
    stage: 2,
    inputSchema: {
      type: "object",
      properties: {
        workspaceId: { type: "string", description: "Workspace ID" },
        title: { type: "string", description: "Proposal title" },
        description: { type: "string", description: "Proposal description and approach" },
        sourceBranch: { type: "string", description: "Thought branch containing the work" },
        problemId: { type: "string", description: "Optional problem this proposal solves" },
      },
      required: ["workspaceId", "title", "description", "sourceBranch"],
    },
    example: {
      workspaceId: "ws-abc123",
      title: "Gateway operations catalog",
      description: "Added operations.ts with 5 operations",
      sourceBranch: "architect/gateway-ops",
      problemId: "prob-001",
    },
  },
  {
    name: "review_proposal",
    title: "Review Proposal",
    description: "Review a proposal with approve/request-changes/comment verdict.",
    category: "proposals",
    stage: 2,
    inputSchema: {
      type: "object",
      properties: {
        workspaceId: { type: "string", description: "Workspace ID" },
        proposalId: { type: "string", description: "Proposal ID to review" },
        // Derived, not restated — a hand-written copy is what drifted before.
        verdict: { type: "string", enum: [...REVIEW_VERDICTS], description: "Review verdict" },
        reasoning: { type: "string", description: "Explanation of the verdict" },
        thoughtRefs: { type: "array", items: { type: "number" }, description: "Thought numbers supporting the review" },
      },
      required: ["workspaceId", "proposalId", "verdict", "reasoning"],
    },
    example: {
      workspaceId: "ws-abc123",
      proposalId: "prop-001",
      verdict: "approve",
      reasoning: "Schemas match handler validation code",
    },
  },
  {
    name: "merge_proposal",
    title: "Merge Proposal",
    description: "Merge an approved proposal. Requires at least one approval review.",
    category: "proposals",
    stage: 2,
    inputSchema: {
      type: "object",
      properties: {
        workspaceId: { type: "string", description: "Workspace ID" },
        proposalId: { type: "string", description: "Proposal ID to merge" },
        mergeMessage: { type: "string", description: "Content for the merge thought" },
      },
      required: ["workspaceId", "proposalId", "mergeMessage"],
    },
    example: {
      workspaceId: "ws-abc123",
      proposalId: "prop-001",
      mergeMessage: "Merged gateway improvements",
    },
  },
  {
    name: "list_proposals",
    title: "List Proposals",
    description: "List all proposals in a workspace with their review status.",
    category: "proposals",
    stage: 2,
    inputSchema: {
      type: "object",
      properties: {
        workspaceId: { type: "string", description: "Workspace ID" },
        status: { type: "string", enum: ["open", "reviewing", "approved", "merged", "rejected"], description: "Filter by proposal status" },
      },
      required: ["workspaceId"],
    },
    example: {
      workspaceId: "ws-abc123",
    },
  },
];

const CONSENSUS_OPERATIONS: OperationDefinition[] = [
  {
    name: "mark_consensus",
    title: "Mark Consensus",
    description: "Record a consensus decision. Links to a thought reference for traceability.",
    category: "consensus",
    stage: 2,
    inputSchema: {
      type: "object",
      properties: {
        workspaceId: { type: "string", description: "Workspace ID" },
        name: { type: "string", description: "Consensus decision name" },
        description: { type: "string", description: "What was decided" },
        thoughtRef: { type: "number", description: "Thought number supporting this decision" },
        branchId: { type: "string", description: "Optional branch containing supporting reasoning" },
      },
      required: ["workspaceId", "name", "description", "thoughtRef"],
    },
    example: {
      workspaceId: "ws-abc123",
      name: "Use notebook pattern for operations",
      description: "Follow existing notebook/operations.ts as the template",
      thoughtRef: 5,
    },
  },
  {
    name: "endorse_consensus",
    title: "Endorse Consensus",
    description: "Endorse an existing consensus marker to show agreement.",
    category: "consensus",
    stage: 2,
    inputSchema: {
      type: "object",
      properties: {
        workspaceId: { type: "string", description: "Workspace ID" },
        consensusId: { type: "string", description: "Consensus marker ID to endorse" },
      },
      required: ["workspaceId", "consensusId"],
    },
    example: {
      workspaceId: "ws-abc123",
      consensusId: "cons-001",
    },
  },
  {
    name: "list_consensus",
    title: "List Consensus",
    description: "List all consensus markers in a workspace with endorsement counts.",
    category: "consensus",
    stage: 2,
    inputSchema: {
      type: "object",
      properties: {
        workspaceId: { type: "string", description: "Workspace ID" },
      },
      required: ["workspaceId"],
    },
    example: {
      workspaceId: "ws-abc123",
    },
  },
];

const CHANNEL_OPERATIONS: OperationDefinition[] = [
  {
    name: "post_message",
    title: "Post Message",
    description: "Post a message to a problem's discussion channel.",
    category: "channels",
    stage: 2,
    inputSchema: {
      type: "object",
      properties: {
        workspaceId: { type: "string", description: "Workspace ID" },
        problemId: { type: "string", description: "Problem whose channel to post in" },
        content: { type: "string", description: "Message content" },
        ref: {
          type: "object",
          description: "Thought reference for traceability",
          properties: {
            sessionId: { type: "string" },
            thoughtNumber: { type: "number" },
            branchId: { type: "string" },
          },
        },
      },
      required: ["workspaceId", "problemId", "content"],
    },
    example: {
      workspaceId: "ws-abc123",
      problemId: "prob-001",
      content: "Starting work on gateway operations catalog",
    },
  },
  {
    name: "read_channel",
    title: "Read Channel",
    description: "Read messages from a problem's discussion channel.",
    category: "channels",
    stage: 2,
    inputSchema: {
      type: "object",
      properties: {
        workspaceId: { type: "string", description: "Workspace ID" },
        problemId: { type: "string", description: "Problem whose channel to read" },
        since: { type: "string", description: "ISO 8601 timestamp — only return messages after this time" },
      },
      required: ["workspaceId", "problemId"],
    },
    example: {
      workspaceId: "ws-abc123",
      problemId: "prob-001",
    },
  },
  {
    name: "post_system_message",
    title: "Post System Message",
    description: "Post a system message to a problem's channel (automated notifications, status updates).",
    category: "channels",
    stage: 2,
    inputSchema: {
      type: "object",
      properties: {
        workspaceId: { type: "string", description: "Workspace ID" },
        problemId: { type: "string", description: "Problem whose channel to post in" },
        content: { type: "string", description: "System message content" },
        ref: {
          type: "object",
          description: "Thought reference for traceability",
          properties: {
            sessionId: { type: "string" },
            thoughtNumber: { type: "number" },
            branchId: { type: "string" },
          },
        },
      },
      required: ["workspaceId", "problemId", "content"],
    },
    example: {
      workspaceId: "ws-abc123",
      problemId: "prob-001",
      content: "Problem status changed to in-progress",
    },
  },
];

const STATUS_OPERATIONS: OperationDefinition[] = [
  {
    name: "workspace_status",
    title: "Workspace Status",
    description: "Get current status of a workspace including agent activity and problem summary.",
    category: "status",
    stage: 2,
    inputSchema: {
      type: "object",
      properties: {
        workspaceId: { type: "string", description: "Workspace ID" },
      },
      required: ["workspaceId"],
    },
    example: {
      workspaceId: "ws-abc123",
    },
  },
  {
    name: "workspace_digest",
    title: "Workspace Digest",
    description: "Get a comprehensive digest of workspace state: agents, problems, proposals, and consensus.",
    category: "status",
    stage: 2,
    inputSchema: {
      type: "object",
      properties: {
        workspaceId: { type: "string", description: "Workspace ID" },
      },
      required: ["workspaceId"],
    },
    example: {
      workspaceId: "ws-abc123",
    },
  },
];

/**
 * The decision ledger. Stage 1, not 2: these records are hub-global, so there
 * is no workspaceId to check membership against. `workspaceId` appears only as
 * an optional context field on record_decision, never as an access scope.
 */
const DECISION_OPERATIONS: OperationDefinition[] = [
  {
    name: "record_decision",
    title: "Record Decision",
    description: "Record a durable decision about a scope (a module or path), with the rationale, the alternatives rejected, and evidence a reader can check. Decisions are hub-global and append-only — there is no update operation. To correct one, use supersede_decision, which writes a new record pointing at the old one; the original is never edited. Do not record a confidence or probability: this ledger is categorical.",
    category: "decisions",
    stage: 1,
    inputSchema: {
      type: "object",
      properties: {
        scope: { type: "string", description: "Module or path the decision governs, e.g. 'src/dispatch/'" },
        statement: { type: "string", description: "What was decided" },
        rationale: { type: "string", description: "Why it was decided that way" },
        assumptionIds: {
          type: "array",
          items: { type: "string" },
          description: "Assumptions this decision rests on. Each must already exist (record_assumption first) — a dangling id is rejected, not stored.",
        },
        alternatives: {
          type: "array",
          description: "Options considered and NOT chosen",
          items: {
            type: "object",
            properties: {
              label: { type: "string" },
              reason: { type: "string", description: "Why it was rejected" },
            },
            required: ["label"],
          },
        },
        expectedOutcome: { type: "string", description: "What this decision is expected to produce — what record_outcome is later adjudicated against" },
        evidenceRefs: {
          type: "array",
          items: { type: "string" },
          description: "Commits, files, probe outputs a reader can go check",
        },
        thoughtRef: {
          type: "object",
          description: "Optional pointer into the thought ledger (structured but not validated)",
          properties: {
            sessionId: { type: "string" },
            thoughtNumber: { type: "number" },
            branchId: { type: "string" },
          },
        },
        regimeRef: { type: "string", description: "The governing regime and version, e.g. 'commit-message@2' — consult flags the decision when the caller reports a different current version" },
        workspaceId: { type: "string", description: "Optional context. Decisions are hub-global; this is NOT an access scope" },
        taskRef: { type: "string", description: "Optional task or issue reference" },
        slug: { type: "string", description: "Optional stable handle, unique across the ledger when present" },
      },
      required: ["scope", "statement", "rationale"],
    },
    example: {
      scope: "src/dispatch/",
      statement: "Queue rows move to 'processing' only after the runner acknowledges",
      rationale: "Boot recovery re-drives every 'processing' row, so an unacknowledged claim replays work",
      alternatives: [{ label: "Mark processing at dequeue", reason: "Loses the row if the runner dies before ack" }],
      evidenceRefs: ["src/dispatch/main.ts", "commit 1a70467"],
    },
  },
  {
    name: "record_assumption",
    title: "Record Assumption",
    description: "Record a belief a decision rests on, so it can be challenged independently of the decision. Status is never supplied and never stored — it is derived from the challenges present at read time.",
    category: "decisions",
    stage: 1,
    inputSchema: {
      type: "object",
      properties: {
        statement: { type: "string", description: "The belief, stated so it could be shown false" },
        scope: { type: "string", description: "Optional module or path the assumption is about" },
      },
      required: ["statement"],
    },
    example: {
      statement: "The dispatch queue has a single writer process",
      scope: "src/dispatch/",
    },
  },
  {
    name: "challenge_assumption",
    title: "Challenge Assumption",
    description: "Record evidence against an assumption. Challenges are additive and never withdrawn: the assumption's derived status becomes 'challenged', and every decision linked to it consults with the health flag 'rests-on-challenged-assumption'. This is how a fired reversal condition reaches the decisions it invalidates.",
    category: "decisions",
    stage: 1,
    inputSchema: {
      type: "object",
      properties: {
        assumptionId: { type: "string", description: "Assumption to challenge" },
        reason: { type: "string", description: "Why the assumption looks false" },
        evidenceRefs: {
          type: "array",
          items: { type: "string" },
          description: "Commits, files, probe outputs supporting the challenge",
        },
      },
      required: ["assumptionId", "reason"],
    },
    example: {
      assumptionId: "b3f1c2d4-5678-4abc-9def-0123456789ab",
      reason: "The reconcile timer starts a second writer every minute",
      evidenceRefs: ["deploy/README.md"],
    },
  },
  {
    name: "supersede_decision",
    title: "Supersede Decision",
    description: "Retire a decision by recording a NEW one in its place. This is the ONLY way to correct a decision — the superseded record is never edited, and the chain stays readable. `scope` defaults to the superseded decision's scope. A decision that already has a successor is refused, naming that successor: supersession is a chain, not a fork.",
    category: "decisions",
    stage: 1,
    inputSchema: {
      type: "object",
      properties: {
        supersedes: { type: "string", description: "Id of the decision being retired" },
        statement: { type: "string", description: "What is decided instead" },
        rationale: { type: "string", description: "Why the earlier decision no longer holds" },
        scope: { type: "string", description: "Defaults to the superseded decision's scope" },
        assumptionIds: { type: "array", items: { type: "string" }, description: "Assumptions the new decision rests on; each must already exist" },
        alternatives: {
          type: "array",
          description: "Options considered and NOT chosen",
          items: {
            type: "object",
            properties: { label: { type: "string" }, reason: { type: "string" } },
            required: ["label"],
          },
        },
        expectedOutcome: { type: "string", description: "What the replacement is expected to produce" },
        evidenceRefs: { type: "array", items: { type: "string" }, description: "Evidence a reader can check" },
        thoughtRef: {
          type: "object",
          description: "Optional pointer into the thought ledger",
          properties: {
            sessionId: { type: "string" },
            thoughtNumber: { type: "number" },
            branchId: { type: "string" },
          },
        },
        regimeRef: { type: "string", description: "Governing regime and version, e.g. 'commit-message@2'" },
        workspaceId: { type: "string", description: "Optional context, not an access scope" },
        taskRef: { type: "string", description: "Optional task or issue reference" },
        slug: { type: "string", description: "Optional stable handle, unique across the ledger" },
      },
      required: ["supersedes", "statement", "rationale"],
    },
    example: {
      supersedes: "a1b2c3d4-5678-4abc-9def-0123456789ab",
      statement: "Queue rows move to 'processing' under a lease with a deadline",
      rationale: "Acknowledgement alone leaks rows when a runner hangs without dying",
      evidenceRefs: ["docs/incidents/2026-07-21.md"],
    },
  },
  {
    name: "record_outcome",
    title: "Record Outcome",
    description: "Record what a decision actually produced. `data` carries raw measurements only — never a verdict. The optional expectationAssessment is a separate categorical adjudication of those measurements against the decision's expectedOutcome — 'consistent', 'contradicts', or 'unclear' — kept apart from the data so a reader can check one against the other. 'contradicts' surfaces the health flag 'outcome-contradicts-expectation' on every later consult.",
    category: "decisions",
    stage: 1,
    inputSchema: {
      type: "object",
      properties: {
        decisionId: { type: "string", description: "Decision this outcome is about. Must exist." },
        kind: { type: "string", description: "Free-form category, e.g. 'edit-distance', 'false_done', 'verify-exit'" },
        data: { type: "object", description: "Raw observed facts. Required — an outcome with no measurements is not checkable." },
        // Derived, not restated — a hand-written copy is what drifted before.
        expectationAssessment: {
          type: "string",
          enum: [...EXPECTATION_ASSESSMENTS],
          description: "How the data relates to the decision's expectedOutcome",
        },
        note: { type: "string", description: "Optional context for the reader" },
      },
      required: ["decisionId", "kind", "data"],
    },
    example: {
      decisionId: "a1b2c3d4-5678-4abc-9def-0123456789ab",
      kind: "verify-exit",
      data: { exitCode: 1, failedChecks: 3, runs: 12 },
      expectationAssessment: "contradicts",
      note: "The lease deadline fires before slow runners finish",
    },
  },
  {
    name: "consult_decisions",
    title: "Consult Decisions",
    description: "Read the decisions governing a scope before deciding in it. Scope matching runs both ways: consulting 'src/dispatch/runners/mcp.ts' returns decisions scoped 'src/dispatch/', and consulting 'src/dispatch/' returns the finer-scoped decisions beneath it. Each result carries health flags computed at read time — rests-on-challenged-assumption, outcome-contradicts-expectation, superseded, regime-changed-since — which are never stored on the record. Superseded decisions are omitted unless includeSuperseded is set.",
    category: "decisions",
    stage: 1,
    inputSchema: {
      type: "object",
      properties: {
        scope: { type: "string", description: "Module or path to consult, e.g. 'src/dispatch/runners/mcp.ts'" },
        currentRegimes: {
          type: "object",
          description: "Regime versions in force right now, e.g. { \"commit-message\": \"3\" }. A decision whose regimeRef names one of these at a different version is flagged 'regime-changed-since'. There is no server-side registry — this is caller-supplied.",
          additionalProperties: { type: "string" },
        },
        includeSuperseded: { type: "boolean", description: "Include retired decisions, each carrying supersededBy. Default false." },
      },
      required: ["scope"],
    },
    example: {
      scope: "src/dispatch/runners/mcp.ts",
      currentRegimes: { "commit-message": "3" },
    },
  },
];

// =============================================================================
// Combined Operations
// =============================================================================

export const HUB_OPERATIONS: OperationDefinition[] = [
  ...IDENTITY_OPERATIONS,
  ...AGENT_OPERATIONS,
  ...PROBLEM_OPERATIONS,
  ...PROPOSAL_OPERATIONS,
  ...CONSENSUS_OPERATIONS,
  ...CHANNEL_OPERATIONS,
  ...STATUS_OPERATIONS,
  ...DECISION_OPERATIONS,
];

/**
 * Get operation definition by name
 */
export function getOperation(name: string): OperationDefinition | undefined {
  return HUB_OPERATIONS.find((op) => op.name === name);
}

/**
 * Get all operation names
 */
export function getOperationNames(): string[] {
  return HUB_OPERATIONS.map((op) => op.name);
}

/**
 * Get operations for a specific stage
 */
export function getOperationsByStage(stage: number): OperationDefinition[] {
  return HUB_OPERATIONS.filter((op) => op.stage === stage);
}

/**
 * Get operations catalog as JSON resource
 */
export function getOperationsCatalog(): string {
  return JSON.stringify(
    {
      version: "1.0.0",
      vocabulary: HUB_VOCABULARY,
      operations: HUB_OPERATIONS.map((op) => ({
        name: op.name,
        title: op.title,
        description: op.description,
        category: op.category,
        stage: op.stage,
        inputs: op.inputSchema,
        example: op.example,
      })),
      categories: [
        {
          name: "identity",
          stage: 0,
          description: "Register as an agent and discover workspaces",
        },
        {
          name: "agent",
          stage: 1,
          description: "Manage identity, create/join workspaces, get profile prompts",
        },
        {
          name: "problems",
          stage: 2,
          description: "Create, claim, update, and track problems with dependencies",
        },
        {
          name: "proposals",
          stage: 2,
          description: "Propose, review, and merge solutions",
        },
        {
          name: "consensus",
          stage: 2,
          description: "Record and endorse team decisions",
        },
        {
          name: "channels",
          stage: 2,
          description: "Post and read messages in problem-scoped channels",
        },
        {
          name: "status",
          stage: 2,
          description: "Workspace health and digest views",
        },
        {
          name: "decisions",
          stage: 1,
          description: "Record and consult durable decisions, assumptions, and outcome evidence (hub-global)",
        },
      ],
    },
    null,
    2
  );
}
