/**
 * Code Mode Execute Tool
 *
 * Accepts LLM-generated JavaScript that chains Thoughtbox operations
 * via the `tb` SDK object. Runs in a node:vm sandbox with only
 * the tb namespace, console, and standard builtins available.
 */

import * as vm from "node:vm";
import { z } from "zod";
import type { CodeModeResult } from "./types.js";
import { TB_SDK_TYPES } from "./sdk-types.js";
import { HUB_SDK_METHODS } from "./hub-sdk-methods.js";
import { isBareStatementSubmission } from "./submission-contract.js";

import type { ThoughtTool, ThoughtToolInput } from "../thought/tool.js";
import type { SessionTool, SessionToolInput } from "../sessions/tool.js";
import type { HubToolResult } from "../hub/hub-tool-handler.js";

const MAX_LOGS = 100;
const TIMEOUT_MS = 30_000;
const MAX_RESULT_BYTES = 24_000;

export const executeToolInputSchema = z.object({
  code: z.string().describe(
    "JavaScript that must evaluate to a function — the executor evaluates this " +
    "string and calls the result with no arguments, so bare top-level statements " +
    "do not work. `tb` is in scope. " +
    "Example: `async () => { const s = await tb.session.list(); return s; }`"
  ),
});

/** Guidance substituted for errors caused by a non-function submission. */
const FUNCTION_CONTRACT_HINT =
  "your code must evaluate to a function, e.g. `async () => { ... }` " +
  "(with `tb` in scope). The submitted code is evaluated as a single " +
  "expression and the result is called, so bare top-level statements such as " +
  "`const x = await tb.session.list(); return x;` are not valid.";

export type ExecuteToolInput = z.infer<typeof executeToolInputSchema>;

/**
 * Hub dispatch surface over the process-shared hub storage. Identity is
 * resolved per request from the durable agent record (SPEC-HUB-003): a
 * tb.hub call acts as the agentId it carries, or as the process-level env
 * identity when it carries none. Nothing here is session-bound, so multiple
 * agents can be driven from one connection without misattribution.
 */
export interface HubDispatcher {
  handle(input: { operation: string; [key: string]: unknown }): Promise<HubToolResult>;
}

export interface ExecuteToolDeps {
  thoughtTool: ThoughtTool;
  sessionTool: SessionTool;
  /**
   * Per-session dispatcher over the process-shared hub storage. Undefined
   * when no hub storage was wired at server creation; `tb.hub.*` then
   * returns a clear error instead of crashing.
   */
  hubDispatcher?: HubDispatcher;
}

export const EXECUTE_TOOL = {
  name: "thoughtbox_execute",
  description: `Run JavaScript using the \`tb\` SDK to chain Thoughtbox operations in a single call.

**Your code must evaluate to a function.** The string you send is evaluated as a single expression and the result is called with no arguments, so submit \`async () => { ... }\` (normal JavaScript inside) and not bare top-level statements. Minimal working example: \`async () => { const s = await tb.session.list(); return s; }\`.

**One state-mutating operation per call.** Submit only one \`tb.thought()\`, or one hub-mutating call (\`tb.hub.register()\`, \`tb.hub.quickJoin()\`, \`tb.hub.createWorkspace()\`, \`tb.hub.transferCoordinator()\`, \`tb.hub.createProblem()\`, \`tb.hub.claimProblem()\`, \`tb.hub.updateProblem()\`, \`tb.hub.createProposal()\`, \`tb.hub.reviewProposal()\`, \`tb.hub.mergeProposal()\`, \`tb.hub.markConsensus()\`, \`tb.hub.endorseConsensus()\`, \`tb.hub.postMessage()\`, etc.), per \`thoughtbox_execute\` invocation. Each response carries guidance (patterns, session state, workspace state) that should inform your next operation. Batching multiple state-mutating calls bypasses this feedback loop and produces lower-quality reasoning. Read-only operations — \`tb.session.*\` and hub reads (\`tb.hub.whoami()\`, \`tb.hub.listWorkspaces()\`, \`tb.hub.listProblems()\`, \`tb.hub.readyProblems()\`, \`tb.hub.blockedProblems()\`, \`tb.hub.listProposals()\`, \`tb.hub.listConsensus()\`, \`tb.hub.readChannel()\`, \`tb.hub.workspaceStatus()\`, \`tb.hub.workspaceDigest()\`) — plus session variables (\`tb.vars.*\` — store intermediate values across execute calls within this MCP session) may be freely chained.

**Pick a semantic thoughtType.** \`reasoning\` is the fallback, not the default: it records that you thought, but leaves nothing a teammate or a later session can query. Whenever a thought carries a durable finding, use the typed form that matches it — \`action_report\` (you ran something; what happened, whether it is reversible), \`belief_snapshot\` (the entities, constraints, and risks you currently believe are in play), \`decision_frame\` (the options you weighed, with exactly one \`selected: true\`), \`assumption_update\` (a belief moved between believed / uncertain / refuted, and what triggered the move), \`context_snapshot\` (the tools, model, and data sources you had available), \`progress\` (a task's status). These populate structured payloads that \`tb.session.queryThoughts({ sessionId, type })\` retrieves directly; a \`reasoning\` thought is prose someone has to re-read to use.

${TB_SDK_TYPES}

Example:
\`\`\`js
async () => {
  const ready = await tb.hub.readyProblems({ workspaceId: "ws-abc123" });
  await tb.thought({
    thought: "Two problems are unblocked. Claiming the dependency root first so the second stops being blocked.",
    thoughtType: "decision_frame",
    options: [
      { label: "Claim prob-001 (dependency root)", selected: true, reason: "unblocks prob-002" },
      { label: "Claim prob-002 first", selected: false, reason: "still blocked by prob-001" },
    ],
    nextThoughtNeeded: true,
  });
  return ready;
}
\`\`\`

Use \`console.log()\` for debugging — output captured in response logs.
All tb methods return their result directly (already parsed from the tool response).`,
  inputSchema: executeToolInputSchema,
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
  },
};

/**
 * Extract the result value from a tool handler response.
 * Tool handlers return { content: [{ type: "text", text: "..." }] }.
 * We parse the JSON text and return the value directly.
 */
function unwrapToolResult(raw: unknown): unknown {
  if (!raw || typeof raw !== "object") return raw;
  const obj = raw as Record<string, unknown>;
  if (obj.isError) {
    const text = (obj.content as Array<{ text: string }>)?.[0]?.text;
    throw new Error(text ?? "Tool execution failed");
  }
  const content = obj.content as Array<{ type: string; text: string }> | undefined;
  if (!content?.[0]?.text) return raw;
  try {
    return JSON.parse(content[0].text);
  } catch {
    return content[0].text;
  }
}

/**
 * Extract the result value from a hub dispatcher response.
 * HubToolHandler returns { content: [text, resource?], isError? } where the
 * text block carries either the operation result or { error } as JSON.
 */
function unwrapHubResult(raw: HubToolResult): unknown {
  const textBlock = raw.content.find(
    (block): block is { type: "text"; text: string } => block.type === "text",
  );
  let parsed: unknown = textBlock?.text;
  if (textBlock?.text) {
    try {
      parsed = JSON.parse(textBlock.text);
    } catch {
      parsed = textBlock.text;
    }
  }
  if (raw.isError) {
    const message = (parsed as { error?: string } | null)?.error;
    throw new Error(message ?? "Hub operation failed");
  }
  return parsed;
}

interface TbContext {
  sessionId?: string;
}

/**
 * Named-vs-positional argument coercion for SDK methods with positional
 * signatures (feedback spec A3). Historically `tb.session.export({ sessionId,
 * format })` shoved the whole object into the positional `sessionId` slot,
 * which Postgres then rejected as `invalid input syntax for type uuid:
 * "[object Object]"` — the worst failure mode, a wrong-looking type error.
 *
 * Rules:
 * - A single plain-object argument is treated as named args. It must contain
 *   every required parameter (extra keys pass through; downstream Zod strips
 *   unknowns).
 * - Otherwise arguments are mapped positionally onto `params`.
 * - Mixing both forms (object first arg plus more positional args) is
 *   ambiguous and throws with the two accepted call shapes spelled out.
 */
function coerceCallArgs(
  method: string,
  params: string[],
  required: string[],
  args: unknown[],
): Record<string, unknown> {
  const positionalSig = `(${params.join(", ")})`;
  const namedSig = `({ ${params.join(", ")} })`;
  const usage = `${method} accepts positional ${positionalSig} or named ${namedSig}`;

  const [first, ...rest] = args;
  const firstIsObject =
    typeof first === "object" && first !== null && !Array.isArray(first);

  if (firstIsObject) {
    if (rest.some((r) => r !== undefined)) {
      throw new Error(
        `${method}: ambiguous call — received a named-args object plus extra ` +
          `positional arguments. ${usage}, not a mix of both.`,
      );
    }
    const named = first as Record<string, unknown>;
    for (const req of required) {
      if (named[req] === undefined) {
        throw new Error(
          `${method}: named-args object is missing required '${req}'. ${usage}.`,
        );
      }
    }
    return named;
  }

  if (Array.isArray(first)) {
    throw new Error(
      `${method}: received an array as the first argument. ${usage}.`,
    );
  }

  const mapped: Record<string, unknown> = {};
  params.forEach((param, i) => {
    if (args[i] !== undefined) mapped[param] = args[i];
  });
  for (const req of required) {
    if (mapped[req] === undefined) {
      throw new Error(`${method}: missing required '${req}'. ${usage}.`);
    }
  }
  return mapped;
}

// --- tb.vars — durable named variables (RLM-lite) ------------------------

const MAX_VARS = 100;
const MAX_VAR_BYTES = 256_000;

/**
 * Session-scoped variable store backing tb.vars.* (catalog:
 * src/code-mode/vars-operations.ts). One store per ExecuteTool instance;
 * server-factory creates one ExecuteTool per MCP session, so variables
 * survive across thoughtbox_execute calls within a session and die with it.
 * No persistence — this is deliberate v1 scope.
 *
 * Values are stored as JSON strings and re-parsed on read. This both
 * enforces JSON-serialisability at set time (with a clear error, not a
 * silent undefined) and prevents objects created inside one node:vm
 * context from leaking live references into later executions.
 */
export class SessionVarsStore {
  private vars = new Map<string, string>();

  set(name: string, value: unknown): { name: string; bytes: number } {
    if (typeof name !== "string" || name.length === 0) {
      throw new Error("tb.vars.set: 'name' must be a non-empty string.");
    }
    let serialized: string | undefined;
    try {
      serialized = JSON.stringify(value);
    } catch (err) {
      throw new Error(
        `tb.vars.set('${name}'): value is not JSON-serialisable ` +
          `(${(err as Error).message}). Only JSON-serialisable values can be stored.`,
      );
    }
    if (serialized === undefined) {
      throw new Error(
        `tb.vars.set('${name}'): value serialised to undefined (functions, ` +
          "symbols, and undefined cannot be stored). Only JSON-serialisable " +
          "values can be stored.",
      );
    }
    if (serialized.length > MAX_VAR_BYTES) {
      throw new Error(
        `tb.vars.set('${name}'): serialised value is ${serialized.length} bytes, ` +
          `over the ${MAX_VAR_BYTES}-byte per-variable limit.`,
      );
    }
    if (!this.vars.has(name) && this.vars.size >= MAX_VARS) {
      throw new Error(
        `tb.vars.set('${name}'): variable limit reached (${MAX_VARS}). ` +
          "Delete unused variables with tb.vars.delete(name).",
      );
    }
    this.vars.set(name, serialized);
    return { name, bytes: serialized.length };
  }

  get(name: string): unknown {
    const serialized = this.vars.get(name);
    if (serialized === undefined) {
      throw new Error(
        `tb.vars.get('${name}'): no such variable in this MCP session. ` +
          "Variables are session-scoped and in-memory only (a server or " +
          "session restart clears them). Use tb.vars.list() to see what exists.",
      );
    }
    return JSON.parse(serialized);
  }

  list(): { vars: Array<{ name: string; bytes: number }>; count: number } {
    const vars = Array.from(this.vars.entries()).map(([name, serialized]) => ({
      name,
      bytes: serialized.length,
    }));
    return { vars, count: vars.length };
  }

  delete(name: string): { deleted: boolean } {
    return { deleted: this.vars.delete(name) };
  }
}

// --- end tb.vars ----------------------------------------------------------

function buildTbObject(deps: ExecuteToolDeps, ctx: TbContext, varsStore: SessionVarsStore): Record<string, unknown> {
  const { thoughtTool, sessionTool, hubDispatcher } = deps;

  const requireHubDispatcher = (): HubDispatcher => {
    if (!hubDispatcher) {
      throw new Error(
        "Hub operations are unavailable: no hub storage was wired into this " +
          "server instance. tb.hub.* requires the server to be started with " +
          "hub storage (see createMcpServer's hubStorage argument).",
      );
    }
    return hubDispatcher;
  };

  const hub: Record<string, (args?: Record<string, unknown>) => Promise<unknown>> = {};
  for (const [method, operation] of Object.entries(HUB_SDK_METHODS)) {
    hub[method] = async (hubArgs: Record<string, unknown> = {}) =>
      unwrapHubResult(await requireHubDispatcher().handle({ operation, ...hubArgs }));
  }

  return {
    thought: async (input: ThoughtToolInput) => {
      const result = unwrapToolResult(await thoughtTool.handle(input));
      const r = result as Record<string, unknown> | null;
      if (r?.sessionId && typeof r.sessionId === 'string') {
        ctx.sessionId = r.sessionId;
      }
      if (r?.closedSessionId && typeof r.closedSessionId === 'string') {
        ctx.sessionId = r.closedSessionId;
      }
      return result;
    },

    // search, resumeLatest, export, and analyze stay wired here but are
    // withheld from the search catalog and the SDK type declaration — see
    // CORE_SESSION_OPS in src/code-mode/search-index.ts for why.
    session: {
      list: async (args?: { limit?: number; offset?: number; tags?: string[] }) =>
        unwrapToolResult(await sessionTool.handle({ operation: "session_list", ...args })),
      get: async (...args: unknown[]) =>
        unwrapToolResult(await sessionTool.handle({
          operation: "session_get",
          ...coerceCallArgs("tb.session.get", ["sessionId"], ["sessionId"], args),
        } as SessionToolInput)),
      search: async (...args: unknown[]) =>
        unwrapToolResult(await sessionTool.handle({
          operation: "session_search",
          ...coerceCallArgs("tb.session.search", ["query", "limit"], ["query"], args),
        } as SessionToolInput)),
      resume: async (...args: unknown[]) =>
        unwrapToolResult(await sessionTool.handle({
          operation: "session_resume",
          ...coerceCallArgs("tb.session.resume", ["sessionId"], ["sessionId"], args),
        } as SessionToolInput)),
      resumeLatest: async (args?: { tags?: string[] }) =>
        unwrapToolResult(await sessionTool.handle({ operation: "session_resume_latest", ...args } as SessionToolInput)),
      queryThoughts: async (args: { sessionId: string; type?: string; start?: number; end?: number; referencesThought?: number; revisionsOf?: number }) =>
        unwrapToolResult(await sessionTool.handle({ operation: "session_query_thoughts", ...args } as SessionToolInput)),
      export: async (...args: unknown[]) =>
        unwrapToolResult(await sessionTool.handle({
          operation: "session_export",
          ...coerceCallArgs("tb.session.export", ["sessionId", "format"], ["sessionId"], args),
        } as SessionToolInput)),
      analyze: async (...args: unknown[]) =>
        unwrapToolResult(await sessionTool.handle({
          operation: "session_analyze",
          ...coerceCallArgs("tb.session.analyze", ["sessionId"], ["sessionId"], args),
        } as SessionToolInput)),
    },

    hub,

    // --- tb.vars — durable named variables (RLM-lite) --------------------
    // Session-scoped, in-memory, JSON-only. Catalog:
    // src/code-mode/vars-operations.ts. All methods accept positional or
    // named-args form, and none count as the call's one state-mutating
    // reasoning operation.
    vars: {
      set: async (...args: unknown[]) => {
        const a = coerceCallArgs("tb.vars.set", ["name", "value"], ["name", "value"], args);
        return varsStore.set(a.name as string, a.value);
      },
      get: async (...args: unknown[]) => {
        const a = coerceCallArgs("tb.vars.get", ["name"], ["name"], args);
        return varsStore.get(a.name as string);
      },
      list: async () => varsStore.list(),
      delete: async (...args: unknown[]) => {
        const a = coerceCallArgs("tb.vars.delete", ["name"], ["name"], args);
        return varsStore.delete(a.name as string);
      },
    },
    // --- end tb.vars ------------------------------------------------------
  };
}

export class ExecuteTool {
  private deps: ExecuteToolDeps;
  /**
   * tb.vars backing store. ExecuteTool is constructed once per MCP session
   * (server-factory), so this store is exactly session-scoped: it survives
   * across handle() calls and dies with the session.
   */
  private varsStore = new SessionVarsStore();

  constructor(deps: ExecuteToolDeps) {
    this.deps = deps;
  }

  async handle(input: ExecuteToolInput): Promise<{ content: Array<{ type: "text"; text: string }> }> {
    const start = Date.now();
    const logs: string[] = [];

    const cappedConsole = {
      log: (...args: unknown[]) => {
        if (logs.length < MAX_LOGS) logs.push(args.map(String).join(" "));
      },
      warn: (...args: unknown[]) => {
        if (logs.length < MAX_LOGS) logs.push(`[warn] ${args.map(String).join(" ")}`);
      },
      error: (...args: unknown[]) => {
        if (logs.length < MAX_LOGS) logs.push(`[error] ${args.map(String).join(" ")}`);
      },
    };

    const tbCtx: TbContext = {};
    const tb = buildTbObject(this.deps, tbCtx, this.varsStore);

    // Security: pass only bridged objects, NOT host builtins.
    // vm.createContext auto-provides context-local copies of Object,
    // Array, Promise, etc. whose prototype chains are isolated from host.
    // This closes [].constructor.constructor("return process")() escapes.
    //
    // THREAT MODEL: tb methods are host closures so
    // tb.session.list.constructor is still host Function. node:vm is not
    // a security boundary (https://nodejs.org/api/vm.html). The sandbox
    // is defense-in-depth: code is LLM-generated from system-controlled
    // prompts, not arbitrary user input. For true isolation, migrate to
    // isolated-vm.
    const context = vm.createContext({
      tb,
      __contractHint: FUNCTION_CONTRACT_HINT,
      console: cappedConsole,
      setTimeout: globalThis.setTimeout,
      clearTimeout: globalThis.clearTimeout,
    });

    let output: CodeModeResult;
    try {
      // Bare top-level statements cannot compile inside the expression
      // wrapper below, so they never reach the typeof guard — catch them here
      // and report the contract rather than a token from the wrapper.
      if (isBareStatementSubmission(input.code)) {
        throw new TypeError(FUNCTION_CONTRACT_HINT);
      }

      // Serialize the result inside the vm to avoid cross-realm object
      // issues where host JSON.stringify can silently return undefined
      // for complex objects created inside the sandbox.
      const script = new vm.Script(`
        const __submission = (${input.code});
        if (typeof __submission !== "function") throw new TypeError(__contractHint);
        Promise.resolve(__submission()).then(
          r => JSON.stringify(r),
          e => { throw e; }
        )
      `, {
        filename: "codemode-exec.js",
      });

      // vm.Script timeout only covers synchronous execution.
      // Promise.race adds a wall-clock timeout for async operations.
      const rawResult = script.runInContext(context, { timeout: TIMEOUT_MS });
      const serialized: string = await Promise.race([
        rawResult,
        new Promise<string>((_, reject) =>
          setTimeout(() => reject(new Error("Execution timed out")), TIMEOUT_MS)
        ),
      ]) as string;

      const durationMs = Date.now() - start;
      let resultJson = serialized ?? "null";
      let truncated = false;
      if (resultJson.length > MAX_RESULT_BYTES) {
        resultJson = resultJson.slice(0, MAX_RESULT_BYTES) + "\n... [truncated]";
        truncated = true;
      }

      output = {
        result: truncated ? resultJson : JSON.parse(resultJson),
        logs,
        truncated: truncated || undefined,
        durationMs,
      };
    } catch (err) {
      output = {
        result: null,
        logs,
        error: (err as { message?: string }).message ?? String(err),
        durationMs: Date.now() - start,
      };
    }

    if (tbCtx.sessionId) {
      output.sessionId = tbCtx.sessionId;
    }

    return {
      content: [{ type: "text" as const, text: JSON.stringify(output, null, 2) }],
    };
  }
}
