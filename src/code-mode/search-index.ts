/**
 * Code Mode — Search Index
 *
 * Builds a unified catalog object used by the search tool's sandbox.
 * Aggregates operations, prompts, resources, and resource templates
 * from across the server surface.
 */

import { SESSION_OPERATIONS } from "../sessions/operations.js";
import { THOUGHT_OPERATIONS } from "../thought/operations.js";
import { HUB_OPERATIONS } from "../hub/operations.js";
import { HUB_OPERATION_SDK_CALLS } from "./hub-sdk-methods.js";
// tb.vars.* — durable named session variables (RLM-lite)
import { VARS_OPERATIONS } from "./vars-operations.js";
import {
  STATIC_RESOURCES,
  RESOURCE_TEMPLATES,
} from "../resources/static-registry.js";

export interface SearchCatalog {
  publicTools: Array<{
    name: string;
    description: string;
    operations?: string[];
  }>;
  operations: Record<string, Record<string, {
    title: string;
    description: string;
    category: string;
    inputSchema?: object;
    /**
     * The fully-qualified thoughtbox_execute call for this operation, e.g.
     * "tb.hub.reviewProposal" for the hub operation "review_proposal".
     * Present on every hub entry, because hub catalog keys are snake_case
     * while the SDK is camelCase and a discovered name that is not callable
     * is a discovery lie (docs/KNOWN-ISSUES.md #3).
     */
    sdkMethod?: string;
  }>>;
  prompts: Array<{
    name: string;
    description: string;
    args: string[];
  }>;
  resources: Array<{
    name: string;
    uri: string;
    description: string;
    mimeType: string;
  }>;
  resourceTemplates: Array<{
    name: string;
    uriTemplate: string;
    description: string;
    mimeType: string;
  }>;
}

interface OperationEntry {
  name: string;
  title: string;
  description: string;
  category: string;
  inputSchema?: object;
}

/**
 * The session operations the catalog advertises. Transitional narrowing:
 * this server is a multi-agent hub with a thought/session ledger attached,
 * not a session-analytics product, so discovery points at the four
 * operations that serve coordination — list, get, resume, query_thoughts.
 *
 * session_search, session_resume_latest, session_export, and session_analyze
 * remain WIRED on tb.session (src/code-mode/execute-tool.ts passes them
 * through to the session tool) and keep working for anyone who calls them.
 * They are simply withheld from the catalog and the SDK type declaration so
 * they do not read as part of the supported surface while the ledger's shape
 * is still moving. Widen this set — do not re-add the plumbing — when they
 * become load-bearing again.
 */
const CORE_SESSION_OPS = new Set([
  "session_list",
  "session_get",
  "session_resume",
  "session_query_thoughts",
]);

/**
 * Hand-curated operation annotations. Carries the equivalent of
 * .claude/rules/mcp-gotchas.md into the agent-visible catalog so common
 * mistakes surface at discovery time without the agent having to load
 * project-local rule files. Keyed by `${module}.${operation}`.
 *
 * v0 is hand-curated; the sleep-time pipeline (ADR-EPI-03) will mine
 * these from session calibration data when it ships.
 */
export interface CatalogAnnotation {
  whenToUse?: string;
  commonMistakes?: string[];
  relatedOps?: string[];
}

export const CATALOG_ANNOTATIONS: Record<string, CatalogAnnotation> = {
  "thought.thoughtbox_thought": {
    whenToUse:
      "Submitting a structured thought. Submit one thought per call so the response's guidance can inform the next thought. Prefer a semantic thoughtType (action_report, belief_snapshot, decision_frame, assumption_update, context_snapshot, progress, action_receipt) over reasoning whenever the thought carries a durable finding — only the typed forms populate payloads that session_query_thoughts can retrieve. Set nextThoughtNeeded=false on the final thought to complete the session. " +
      "Each typed thoughtType REQUIRES its payload and the call fails without it: " +
      "decision_frame → confidence ('high'|'medium'|'low') + options (non-empty, exactly one selected:true); " +
      "action_report → actionResult { success, reversible ('yes'|'no'|'partial'), tool, target }; " +
      "belief_snapshot → beliefs.entities (non-empty); " +
      "assumption_update → assumptionChange.newStatus ('believed'|'uncertain'|'refuted'); " +
      "context_snapshot → contextData (object); " +
      "progress → progressData { task, status ('pending'|'in_progress'|'done'|'blocked') }; " +
      "action_receipt → receiptData { toolName, match (boolean) }. " +
      "reasoning, finding, synthesis, question and conclusion take no payload beyond `thought`. The inputSchema publishes the same contract as if/then entries under allOf.",
    commonMistakes: [
      "defaulting to thoughtType 'reasoning' for findings a teammate will need to query later",
      "forgetting to complete sessions (nextThoughtNeeded stays true)",
      "reusing thoughtNumber within the same branch (must be unique per session+branch)",
      "sending a typed thoughtType with only thought/nextThoughtNeeded/thoughtType — the three base required fields are not sufficient for any typed form",
      "submitting decision_frame without exactly one selected:true option",
      "passing branchId without branchFromThought",
    ],
    relatedOps: ["session.session_resume", "session.session_query_thoughts"],
  },
  "hub.register": {
    whenToUse:
      "Minting a NEW agent identity. Every call mints another one, so call it once and keep the agentId: hub identity is a durable record, and the returned agentId is the handle you pass as `agentId` on every later hub call — from this connection or any other. A process-level identity can be configured instead with THOUGHTBOX_AGENT_ID + THOUGHTBOX_AGENT_NAME, which then applies to calls that pass no agentId.",
    commonMistakes: [
      "re-registering to 'get back' an existing agent after a reconnect — that mints a second agent with no workspace memberships; reuse the original agentId instead",
      "omitting agentId on later calls and expecting the last registration to be assumed — mutations without an agentId fail unless a process-level env identity is configured",
    ],
    relatedOps: ["hub.quick_join", "hub.whoami", "hub.join_workspace"],
  },
  "hub.quick_join": {
    whenToUse:
      "Onboarding into a workspace. Preferred over register + join_workspace: it registers the agent and joins the workspace in one call. Record the returned agentId and pass it on every later call. Pass your existing agentId to re-join or to join a second workspace as yourself; omitting it mints a new agent. Requires name and workspaceId.",
    commonMistakes: [
      "calling register first and then quick_join — quick_join already registers",
      "omitting workspaceId (use list_workspaces to find one, or create_workspace first)",
      "quick_joining again after a reconnect without passing your agentId — that mints a second agent under the same name",
    ],
    relatedOps: ["hub.list_workspaces", "hub.create_workspace", "hub.whoami"],
  },
  "hub.record_decision": {
    whenToUse:
      "Recording a durable choice about a module or path, after consulting the scope. Capture the rationale and the alternatives you rejected — a decision without its rejected options cannot be re-evaluated later. Link assumptionIds for the beliefs it rests on so a later challenge can reach it. Never record a confidence or probability; this ledger is categorical by design.",
    commonMistakes: [
      "recording a second, contradicting decision for the same scope instead of superseding the first — the consult then reports both as governing",
      "linking assumptionIds that were never recorded (record_assumption first; a dangling id is rejected)",
      "putting the evidence in the rationale prose instead of evidenceRefs, where a reader can actually go check it",
    ],
    relatedOps: ["hub.consult_decisions", "hub.supersede_decision", "hub.record_assumption"],
  },
  "hub.consult_decisions": {
    whenToUse:
      "BEFORE deciding anything in a scope, and before changing code a past decision governs. Scope matching runs both ways, so a file path finds the decisions scoped to its directory and a directory finds the finer-scoped ones beneath it. Read the health flags: they are computed at read time and tell you whether a decision still stands.",
    commonMistakes: [
      "deciding first and consulting afterwards — the ledger only prevents rework if it is read first",
      "reading the decision statement and ignoring the health flags, which is where 'this rests on a challenged assumption' lives",
      "expecting superseded decisions by default — pass includeSuperseded to see the retired chain",
    ],
    relatedOps: ["hub.record_decision", "hub.challenge_assumption", "hub.record_outcome"],
  },
  "hub.challenge_assumption": {
    whenToUse:
      "Evidence has appeared that a recorded assumption is false — including a reversal condition firing. The challenge is additive and permanent, and it propagates: every decision linked to that assumption consults with 'rests-on-challenged-assumption' from then on. Follow it with supersede_decision on the decisions it undermines.",
    commonMistakes: [
      "editing or re-recording the assumption instead of challenging it — status is derived from challenges and nothing is ever rewritten",
      "challenging the assumption and stopping there, leaving decisions that rest on it still reading as current",
    ],
    relatedOps: ["hub.record_assumption", "hub.supersede_decision", "hub.consult_decisions"],
  },
  "hub.transfer_coordinator": {
    whenToUse:
      "Handing coordinatorship to another member deliberately — before going offline for good, or when the coordinating agent is being retired. Coordinator power is durable and survives disconnection, so this is not needed to recover from a dropped connection: reconnect and pass the same agentId.",
    commonMistakes: [
      "reaching for it after a disconnect — the original coordinator keeps merge_proposal as long as it passes its agentId",
      "naming an agent that has not joined the workspace (it must already be a member)",
    ],
    relatedOps: ["hub.merge_proposal", "hub.workspace_status", "hub.join_workspace"],
  },
  "hub.add_dependency": {
    whenToUse:
      "Declaring that one problem must wait on another. Requires dependsOnProblemId (the problem that must resolve FIRST) alongside workspaceId and problemId. The dependent problem stays out of ready_problems until the dependency resolves.",
    commonMistakes: [
      "passing 'dependsOn' or 'blockedBy' instead of 'dependsOnProblemId'",
      "reversing the direction — problemId is the waiter, dependsOnProblemId is the blocker",
    ],
    relatedOps: ["hub.ready_problems", "hub.blocked_problems", "hub.remove_dependency"],
  },
  "hub.create_sub_problem": {
    whenToUse:
      "Decomposing a problem into a child that inherits workspace scope. Requires parentId (the existing problem being decomposed) alongside workspaceId, title, and description.",
    commonMistakes: [
      "passing 'problemId' or 'parentProblemId' instead of 'parentId'",
      "using create_problem for a decomposition, which loses the parent link",
    ],
    relatedOps: ["hub.create_problem", "hub.list_problems"],
  },
  "hub.create_proposal": {
    whenToUse:
      "Proposing a solution to a problem. Requires sourceBranch — the thought branch holding the work — alongside workspaceId, title, and description. problemId is optional but links the proposal to the problem it resolves.",
    commonMistakes: [
      "omitting sourceBranch (it is required, not inferred from the claim)",
      "passing 'branch' or 'branchId' instead of 'sourceBranch'",
    ],
    relatedOps: ["hub.review_proposal", "hub.merge_proposal", "hub.claim_problem"],
  },
  "hub.merge_proposal": {
    whenToUse:
      "Merging an approved proposal. Requires at least one approve review first, and takes mergeMessage — the content of the merge thought that persists to the workspace's main session, so write it as the synthesis, not as a label.",
    commonMistakes: [
      "passing 'message' or 'summary' instead of 'mergeMessage'",
      "merging before any review_proposal with verdict 'approve' exists",
    ],
    relatedOps: ["hub.review_proposal", "hub.list_proposals"],
  },
  "hub.endorse_consensus": {
    whenToUse:
      "Recording agreement with an existing consensus marker. Requires consensusId (from mark_consensus or list_consensus) alongside workspaceId.",
    commonMistakes: [
      "passing the consensus name instead of consensusId",
      "calling mark_consensus again to agree — that creates a competing marker",
    ],
    relatedOps: ["hub.mark_consensus", "hub.list_consensus"],
  },
  "hub.post_message": {
    whenToUse:
      "Posting to a problem's discussion channel. Channels are problem-scoped, so both workspaceId and problemId are required — there is no workspace-wide channel. Pass ref to cite the thought behind the message.",
    commonMistakes: [
      "omitting problemId and expecting a workspace-level channel",
      "using post_system_message for agent-authored discussion (it is for automated notifications)",
    ],
    relatedOps: ["hub.read_channel", "hub.post_system_message"],
  },
  "hub.declare_work_intent": {
    whenToUse:
      "Requires a celld-backed workspace (RFC 0001). Declare the scopes and contracts you are about to touch BEFORE editing, so a teammate's record_work_change can detect a conflict with your live work instead of silently overwriting an assumption you both depend on. leaseUntil is required — the intent stops matching once it expires.",
    commonMistakes: [
      "declaring intent after the edit instead of before it — the impact detector only matches against ACTIVE intents at the time of record_work_change",
      "omitting leaseUntil or setting it too short, so the intent expires mid-task and later changes stop matching",
      "calling this on a filesystem workspace — it always rejects with OPERATION_REQUIRES_CELLD_BACKEND",
    ],
    relatedOps: ["hub.record_work_change", "hub.list_impacts", "hub.read_workspace_events"],
  },
  "hub.record_work_change": {
    whenToUse:
      "Requires a celld-backed workspace (RFC 0001). Record a change once it happens so every OTHER agent with a matching active work intent gets an impact. Set severity 'blocking' only when the matched agent's work cannot safely complete without acknowledging it — blocking impacts gate update_problem to resolved/closed.",
    commonMistakes: [
      "marking every change 'blocking' — advisory is the default posture; reserve blocking for changes that make the matched agent's in-flight work actually wrong",
      "expecting a change to notify its own author — the author is excluded from matching by design",
      "calling this on a filesystem workspace — it always rejects with OPERATION_REQUIRES_CELLD_BACKEND",
    ],
    relatedOps: ["hub.declare_work_intent", "hub.list_impacts", "hub.acknowledge_impact"],
  },
  "hub.list_impacts": {
    whenToUse:
      "Requires a celld-backed workspace (RFC 0001). Poll or check before completing a problem to see whether any pending blocking impact targets you. read_workspace_events is the durable replay authority; this is the filtered, read-only view.",
    commonMistakes: [
      "treating an empty result as proof no impact exists rather than re-checking after each record_work_change from a teammate",
      "calling this on a filesystem workspace — it always rejects with OPERATION_REQUIRES_CELLD_BACKEND",
    ],
    relatedOps: ["hub.record_work_change", "hub.acknowledge_impact", "hub.read_workspace_events"],
  },
  "hub.acknowledge_impact": {
    whenToUse:
      "Requires a celld-backed workspace (RFC 0001). Must precede completing a problem with a blocking impact — update_problem to resolved/closed rejects with BLOCKING_IMPACT_UNACKNOWLEDGED otherwise. Use disposition 'not_applicable' for a false-positive match rather than ignoring it; ignoring it still blocks completion.",
    commonMistakes: [
      "ignoring an advisory impact and assuming it never blocks anything — only 'blocking' severity gates completion, but advisory impacts are still real signals to read",
      "completing the problem first and acknowledging after — the gate checks BEFORE the status transition, not after",
      "calling this on a filesystem workspace — it always rejects with OPERATION_REQUIRES_CELLD_BACKEND",
    ],
    relatedOps: ["hub.list_impacts", "hub.record_work_change", "hub.update_problem"],
  },
  "hub.read_workspace_events": {
    whenToUse:
      "Requires a celld-backed workspace (RFC 0001). This is the replay authority for coordination state — not the SSE stream, which is only an ephemeral notification hint. A commit-before-reply retry can legitimately rebroadcast the same event IDs, so dedupe by eventId. Page forward with after: <lastEventSequence> from the previous call.",
    commonMistakes: [
      "treating an SSE notification as durable state instead of a hint to come read here",
      "re-processing an event whose eventId was already seen, instead of deduping — retries can legitimately rebroadcast",
      "calling this on a filesystem workspace — it always rejects with OPERATION_REQUIRES_CELLD_BACKEND",
    ],
    relatedOps: ["hub.list_impacts", "hub.declare_work_intent", "hub.record_work_change"],
  },
};

function formatAnnotation(annotation: CatalogAnnotation): string {
  const stanzas: string[] = [];
  if (annotation.whenToUse) {
    stanzas.push(`When to use: ${annotation.whenToUse}`);
  }
  if (annotation.commonMistakes?.length) {
    stanzas.push(`Common mistakes: ${annotation.commonMistakes.join("; ")}`);
  }
  if (annotation.relatedOps?.length) {
    stanzas.push(`Related: ${annotation.relatedOps.join(", ")}`);
  }
  return stanzas.join("\n");
}

/**
 * Mutates catalog operation descriptions in place to append hand-curated
 * environmental memory (when_to_use / common mistakes / related ops).
 * No-op for operations not in CATALOG_ANNOTATIONS.
 */
export function annotateCatalog(
  catalog: SearchCatalog,
  annotations: Record<string, CatalogAnnotation> = CATALOG_ANNOTATIONS,
): void {
  for (const [moduleName, ops] of Object.entries(catalog.operations)) {
    for (const [opName, op] of Object.entries(ops)) {
      const annotation = annotations[`${moduleName}.${opName}`];
      if (!annotation) continue;
      const formatted = formatAnnotation(annotation);
      if (!formatted) continue;
      op.description = `${op.description}\n\n${formatted}`;
    }
  }
}

/**
 * @param sdkCallFor Optional resolver from operation name to the fully-
 *   qualified `tb` call that runs it. Supplied for the hub module, whose
 *   catalog keys differ from its SDK method names.
 */
function indexOperations(
  ops: OperationEntry[],
  sdkCallFor?: (operationName: string) => string | undefined,
): SearchCatalog["operations"][string] {
  const indexed: SearchCatalog["operations"][string] = {};
  for (const op of ops) {
    const sdkMethod = sdkCallFor?.(op.name);
    indexed[op.name] = {
      title: op.title,
      description: op.description,
      category: op.category,
      inputSchema: op.inputSchema,
      ...(sdkMethod ? { sdkMethod } : {}),
    };
  }
  return indexed;
}

export function buildSearchCatalog(): SearchCatalog {
  const catalog: SearchCatalog = {
    publicTools: [
      {
        name: "thoughtbox_search",
        description: "Discover Thoughtbox operations, prompts, resources, and public tool surfaces by querying this catalog. Submit code that evaluates to a function, e.g. async () => Object.keys(catalog.operations).",
      },
      {
        name: "thoughtbox_execute",
        description: "Run operations against the tb SDK. Submit code that evaluates to a function, e.g. async () => { const s = await tb.session.list(); return s; }.",
      },
    ],

    operations: {
      hub: indexOperations(
        HUB_OPERATIONS,
        (name) => HUB_OPERATION_SDK_CALLS[name],
      ),
      thought: indexOperations(THOUGHT_OPERATIONS),
      session: indexOperations(
        SESSION_OPERATIONS.filter((op) => CORE_SESSION_OPS.has(op.name)),
      ),
      // tb.vars.* — durable named session variables (RLM-lite)
      vars: indexOperations(VARS_OPERATIONS),
    },

    prompts: [
      {
        name: "interleaved-thinking",
        description:
          "Use this Thoughtbox server as a reasoning workspace to alternate between internal reasoning steps and external tool/action invocation. Enables structured multi-phase execution with tooling inventory, sufficiency assessment, strategy development, and execution.",
        args: ["task", "thoughts_limit", "clear_folder"],
      },
    ],

    resources: STATIC_RESOURCES.map((def) => ({
      name: def.name,
      uri: def.uri,
      description: def.description,
      mimeType: def.mimeType,
    })),

    resourceTemplates: RESOURCE_TEMPLATES.map((def) => ({
      name: def.name,
      uriTemplate: def.uriTemplate,
      description: def.description,
      mimeType: def.mimeType,
    })),
  };

  annotateCatalog(catalog);
  return catalog;
}
