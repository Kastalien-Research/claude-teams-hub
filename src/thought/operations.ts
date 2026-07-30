/**
 * Operations Catalog for Thought Tool
 *
 * Defines the thought operation with its schema,
 * description, category, and example.
 */

import type { OperationDefinition } from "../sessions/operations.js";

/**
 * The per-thoughtType payload contract, transcribed from the ONLY thing that
 * enforces it: ThoughtHandler.validateStructuredFields and its per-type
 * validators in src/thought-handler.ts. The advertised schema below is
 * derived from this map, so a client that trusts the catalog can construct a
 * valid typed thought instead of learning the shape from serial validation
 * errors (docs/KNOWN-ISSUES.md #2).
 *
 * Keys are exactly the thoughtTypes the validator accepts; an empty array
 * means the type carries no payload beyond `thought` (validateStructuredFields
 * breaks without checking anything). Nested requirements within each payload
 * object are declared on the property schemas themselves.
 */
export const THOUGHT_TYPE_REQUIRED_FIELDS: Record<string, readonly string[]> = {
  reasoning: [],
  finding: [],
  synthesis: [],
  question: [],
  conclusion: [],
  decision_frame: ["confidence", "options"],
  action_report: ["actionResult"],
  belief_snapshot: ["beliefs"],
  assumption_update: ["assumptionChange"],
  context_snapshot: ["contextData"],
  progress: ["progressData"],
  action_receipt: ["receiptData"],
};

const THOUGHT_TYPES = Object.keys(THOUGHT_TYPE_REQUIRED_FIELDS);

/**
 * Human-readable one-liners for the typed payloads, kept next to the map so
 * the description text and the schema cannot drift apart.
 */
const TYPED_PAYLOAD_SUMMARY = [
  "decision_frame: confidence ('high'|'medium'|'low') + options (non-empty; exactly one selected:true)",
  "action_report: actionResult { success, reversible ('yes'|'no'|'partial'), tool (non-empty), target (non-empty) }",
  "belief_snapshot: beliefs.entities (non-empty)",
  "assumption_update: assumptionChange.newStatus ('believed'|'uncertain'|'refuted')",
  "context_snapshot: contextData (object)",
  "progress: progressData { task (non-empty), status ('pending'|'in_progress'|'done'|'blocked') }",
  "action_receipt: receiptData { toolName (non-empty), match (boolean) }",
  "reasoning, finding, synthesis, question, conclusion: no payload beyond `thought`",
].join("; ");

/**
 * `required` cannot express "required only for this thoughtType", so the
 * conditional half of the contract is published as standard JSON Schema
 * if/then, generated from THOUGHT_TYPE_REQUIRED_FIELDS.
 */
const TYPED_PAYLOAD_CONDITIONS = Object.entries(THOUGHT_TYPE_REQUIRED_FIELDS)
  .filter(([, fields]) => fields.length > 0)
  .map(([thoughtType, fields]) => ({
    if: {
      properties: { thoughtType: { const: thoughtType } },
      required: ["thoughtType"],
    },
    // `then` is the JSON Schema keyword, not a promise hook — the value is a
    // plain object, so this is never actually thenable.
    // oxlint-disable-next-line no-thenable
    then: { required: [...fields] },
  }));

export const THOUGHT_OPERATIONS: OperationDefinition[] = [
  {
    name: "thoughtbox_thought",
    title: "Record Thought",
    description:
      "Submit a structured thought to the active reasoning session. Supports branching, revision, typed metadata (decision frames, action reports, belief snapshots, assumption updates, context snapshots, progress, action receipts), payload-free inquiry types (finding, synthesis, question, conclusion), and multi-agent attribution.\n\n" +
      `Typed thoughtTypes require a payload beyond the three base fields, and the server REJECTS the call without it — ${TYPED_PAYLOAD_SUMMARY}. ` +
      "The conditional requirements are published as if/then entries under `allOf`; the payload objects' own required keys are on their property schemas.",
    category: "reasoning",
    inputSchema: {
      type: "object",
      properties: {
        thought: {
          type: "string",
          description: "Your current thinking process, insights, or analysis",
        },
        thoughtNumber: {
          type: "number",
          description:
            "Optional explicit thought number. Send 1 to restart a thought track.",
        },
        totalThoughts: {
          type: "number",
          description: "Estimated total thoughts needed",
        },
        nextThoughtNeeded: {
          type: "boolean",
          description:
            "Whether another thought is needed to complete the reasoning step",
        },
        thoughtType: {
          type: "string",
          enum: THOUGHT_TYPES,
          description:
            "The structured type of this thought, which determines the required payload (see allOf). Inquiry-session types (finding, synthesis, question, conclusion) carry no extra payload, like reasoning.",
        },
        isRevision: {
          type: "boolean",
          description: "Whether this thought revises a previous one",
        },
        revisesThought: {
          type: "number",
          description: "The thought number being revised",
        },
        branchFromThought: {
          type: "number",
          description: "The thought number this branch originates from",
        },
        branchId: {
          type: "string",
          description:
            "A unique identifier for this new reasoning branch. Requires branchFromThought — the server rejects branchId on its own.",
        },
        sessionTitle: {
          type: "string",
          description: "Title for a new reasoning session (for thought 1)",
        },
        sessionTags: {
          type: "array",
          items: { type: "string" },
          description: "Tags for a new reasoning session",
        },
        confidence: {
          type: "string",
          enum: ["high", "medium", "low"],
          description: "Required for thoughtType 'decision_frame'.",
        },
        options: {
          type: "array",
          description:
            "Required for thoughtType 'decision_frame': non-empty, and exactly one item must have selected: true. Item keys other than that selected flag are not validated, but consumers read label.",
          minItems: 1,
          items: {
            type: "object",
            properties: {
              label: { type: "string" },
              selected: { type: "boolean" },
              reason: { type: "string" },
            },
          },
        },
        actionResult: {
          type: "object",
          description:
            "Required for thoughtType 'action_report'. tool and target must be non-empty strings — the server rejects \"\".",
          properties: {
            success: { type: "boolean" },
            reversible: { type: "string", enum: ["yes", "no", "partial"] },
            tool: { type: "string", minLength: 1 },
            target: { type: "string", minLength: 1 },
            sideEffects: { type: "array", items: { type: "string" } },
          },
          required: ["success", "reversible", "tool", "target"],
        },
        beliefs: {
          type: "object",
          description:
            "Required for thoughtType 'belief_snapshot'. Only entities is enforced, and only as a non-empty array — item keys are not validated, but consumers read name and state.",
          properties: {
            entities: {
              type: "array",
              minItems: 1,
              items: {
                type: "object",
                properties: {
                  name: { type: "string" },
                  state: { type: "string" },
                },
              },
            },
            constraints: { type: "array", items: { type: "string" } },
            risks: { type: "array", items: { type: "string" } },
          },
          required: ["entities"],
        },
        assumptionChange: {
          type: "object",
          description:
            "Required for thoughtType 'assumption_update'. Only newStatus is enforced.",
          properties: {
            text: { type: "string" },
            oldStatus: { type: "string" },
            newStatus: {
              type: "string",
              enum: ["believed", "uncertain", "refuted"],
            },
            trigger: { type: "string" },
            downstream: { type: "array", items: { type: "number" } },
          },
          required: ["newStatus"],
        },
        contextData: {
          type: "object",
          description:
            "Required for thoughtType 'context_snapshot'. Must be an object; no individual key is enforced.",
          properties: {
            toolsAvailable: { type: "array", items: { type: "string" } },
            systemPromptHash: { type: "string" },
            modelId: { type: "string" },
            constraints: { type: "array", items: { type: "string" } },
            dataSourcesAccessed: { type: "array", items: { type: "string" } },
          },
        },
        progressData: {
          type: "object",
          description:
            "Required for thoughtType 'progress'. task must be a non-empty string — the server rejects \"\".",
          properties: {
            task: { type: "string", minLength: 1 },
            status: {
              type: "string",
              enum: ["pending", "in_progress", "done", "blocked"],
            },
            note: { type: "string" },
          },
          required: ["task", "status"],
        },
        receiptData: {
          type: "object",
          description:
            "Required for thoughtType 'action_receipt'. Only toolName and match are enforced; toolName must be a non-empty string — the server rejects \"\".",
          properties: {
            toolName: { type: "string", minLength: 1 },
            expected: { type: "string" },
            actual: { type: "string" },
            match: { type: "boolean" },
            residual: { type: "string" },
            durationMs: { type: "number" },
          },
          required: ["toolName", "match"],
        },
        agentId: {
          type: "string",
          description: "ID of the agent submitting this thought",
        },
        agentName: {
          type: "string",
          description: "Name of the agent submitting this thought",
        },
      },
      required: ["thought", "nextThoughtNeeded", "thoughtType"],
      allOf: TYPED_PAYLOAD_CONDITIONS,
    },
    example: {
      thought:
        "The toolhost pattern consolidates related operations under one tool, reducing discovery overhead.",
      thoughtNumber: 1,
      totalThoughts: 5,
      nextThoughtNeeded: true,
      thoughtType: "reasoning",
      sessionTitle: "Architecture Decision: Toolhost Pattern",
      sessionTags: ["architecture", "mcp"],
    },
  },
];

/**
 * Get operation definition by name
 */
export function getOperation(
  name: string,
): OperationDefinition | undefined {
  return THOUGHT_OPERATIONS.find((op) => op.name === name);
}
