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
  "hub.quick_join": {
    whenToUse:
      "Onboarding into a workspace. Preferred over register + join_workspace: it registers the agent and joins the workspace in one call, and the returned agentId is implicit for every later hub call in this session. Requires name and workspaceId.",
    commonMistakes: [
      "calling register first and then quick_join — quick_join already registers",
      "omitting workspaceId (use list_workspaces to find one, or create_workspace first)",
    ],
    relatedOps: ["hub.list_workspaces", "hub.create_workspace", "hub.whoami"],
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
        description: "Discover Thoughtbox operations, prompts, resources, and public tool surfaces by querying this catalog with JavaScript.",
      },
      {
        name: "thoughtbox_execute",
        description: "Run JavaScript against the tb SDK for Thoughtbox operation modules.",
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
