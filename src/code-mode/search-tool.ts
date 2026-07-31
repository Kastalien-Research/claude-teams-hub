/**
 * Code Mode Search Tool
 *
 * Accepts LLM-generated JavaScript that runs against a frozen catalog
 * of operations, prompts, and resources. The LLM has full programmatic
 * filtering power over the catalog — no need for predefined query patterns.
 */

import * as vm from "node:vm";
import { z } from "zod";
import type { SearchCatalog } from "./search-index.js";
import type { CodeModeResult } from "./types.js";
import { isBareStatementSubmission } from "./submission-contract.js";

const MAX_LOGS = 100;
const TIMEOUT_MS = 10_000;
const MAX_RESULT_BYTES = 24_000;

export const searchToolInputSchema = z.object({
  code: z.string().describe(
    "JavaScript that must evaluate to a function — the executor evaluates this " +
    "string and calls the result with no arguments, so bare top-level statements " +
    "do not work. `catalog` is in scope. " +
    "Example: `async () => Object.keys(catalog.operations)` or " +
    "`async () => catalog.prompts.filter(p => p.name.includes('spec'))`"
  ),
});

/** Guidance appended to, or substituted for, errors caused by a non-function submission. */
const FUNCTION_CONTRACT_HINT =
  "your code must evaluate to a function, e.g. `async () => { ... }` " +
  "(with `catalog` in scope). The submitted code is evaluated as a single " +
  "expression and the result is called, so bare top-level statements such as " +
  "`const x = ...; return x;` are not valid.";

export type SearchToolInput = z.infer<typeof searchToolInputSchema>;

export const SEARCH_TOOL = {
  name: "thoughtbox_search",
  description: `Discover Thoughtbox operations, prompts, and resources by writing JavaScript that queries the catalog.

Submission contract — your code must evaluate to a function. The string you send is evaluated as a single expression and the result is called with no arguments, so submit \`async () => { ... }\` (normal JavaScript inside) and not bare top-level statements. Minimal working example: \`async () => Object.keys(catalog.operations)\`.

Sandbox contract — this is a read-only discovery sandbox, not an execution one:
- \`catalog\` is already parsed and frozen in scope. Return or log from it; do not re-parse anything. (The raw JSON string is also present as \`__catalogJson\`, but you never need it.)
- \`console\`, \`setTimeout\` and \`clearTimeout\` are the only other globals. There is no \`tb\` and no network or filesystem access — nothing here can run an operation.
- To RUN what you discover, call thoughtbox_execute. Catalog keys are the wire operation names (snake_case); hub entries additionally carry \`sdkMethod\`, the fully-qualified call to use there — e.g. \`review_proposal\` has \`sdkMethod: "tb.hub.reviewProposal"\`. Use \`sdkMethod\` verbatim; the snake_case key is not callable.

interface SearchCatalog {
  publicTools: Array<{ name: string; description: string; operations?: string[] }>;
  operations: Record<string, Record<string, {
    title: string;
    description: string;
    category: string;
    inputSchema?: object;
    /** Fully-qualified thoughtbox_execute call, e.g. "tb.hub.reviewProposal". Present on all hub entries. */
    sdkMethod?: string;
  }>>;
  prompts: Array<{ name: string; description: string; args: string[] }>;
  resources: Array<{ name: string; uri: string; description: string; mimeType: string }>;
  resourceTemplates: Array<{ name: string; uriTemplate: string; description: string; mimeType: string }>;
}

Modules in catalog.operations: hub, thought, session, vars
Public MCP tools in catalog.publicTools: thoughtbox_search, thoughtbox_execute

Examples:
- List all modules: \`async () => Object.keys(catalog.operations)\`
- List public tools: \`async () => catalog.publicTools\`
- Find session operations: \`async () => catalog.operations.session\`
- Search by keyword: \`async () => { const q = "workspace"; return Object.entries(catalog.operations).flatMap(([mod, ops]) => Object.entries(ops).filter(([_, op]) => op.description.toLowerCase().includes(q)).map(([name, op]) => ({ module: mod, name, title: op.title }))) }\`
- Find prompts: \`async () => catalog.prompts.filter(p => p.name.includes('interleaved'))\`
- List resources: \`async () => catalog.resources.map(r => ({ name: r.name, uri: r.uri }))\`
- Get callable hub names: \`async () => Object.entries(catalog.operations.hub).map(([name, op]) => ({ name, sdkMethod: op.sdkMethod }))\``,
  inputSchema: searchToolInputSchema,
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
  },
};

export class SearchTool {
  private catalog: SearchCatalog;

  constructor(catalog: SearchCatalog) {
    this.catalog = catalog;
  }

  async handle(input: SearchToolInput): Promise<{ content: Array<{ type: "text"; text: string }> }> {
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

    // Build the catalog inside the VM so async evaluation uses the context's
    // own intrinsics instead of host constructors. This mirrors the safer
    // execute-tool approach and avoids deployment-only hangs from cross-realm
    // Promise/builtin interactions.
    const context = vm.createContext({
      __catalogJson: JSON.stringify(this.catalog),
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
      // issues where host JSON.stringify silently returns undefined for
      // complex objects created inside the sandbox.
      const script = new vm.Script(`
        const catalog = Object.freeze(JSON.parse(__catalogJson));
        const __submission = (${input.code});
        if (typeof __submission !== "function") throw new TypeError(__contractHint);
        Promise.resolve(__submission()).then(
          r => JSON.stringify(r),
          e => { throw e; }
        )
      `, {
        filename: "codemode-search.js",
      });
      const rawResult = script.runInContext(context, { timeout: TIMEOUT_MS });
      const serialized: string = await Promise.race([
        rawResult,
        new Promise<string>((_, reject) =>
          setTimeout(() => reject(new Error("Search execution timed out")), TIMEOUT_MS)
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
        error: typeof err === "object" && err !== null && "message" in err
          ? String((err as { message: unknown }).message)
          : String(err),
        durationMs: Date.now() - start,
      };
    }

    return {
      content: [{ type: "text" as const, text: JSON.stringify(output, null, 2) }],
    };
  }
}
