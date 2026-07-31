import { describe, it, expect } from "vitest";
import { SearchTool, SEARCH_TOOL, searchToolInputSchema } from "../search-tool.js";
import { buildSearchCatalog } from "../search-index.js";

const catalog = buildSearchCatalog();
const tool = new SearchTool(catalog);

describe("thoughtbox_search", () => {
  it("lists only the Code Mode operation modules", async () => {
    const result = await tool.handle({
      code: "async () => Object.keys(catalog.operations).sort()",
    });
    const output = JSON.parse(result.content[0].text);
    expect(output.error).toBeUndefined();
    expect(output.result).toEqual(["hub", "session", "thought", "vars"]);
  });

  it("hub operations are discoverable in the catalog", async () => {
    const result = await tool.handle({
      code: "async () => Object.keys(catalog.operations.hub).sort()",
    });
    const output = JSON.parse(result.content[0].text);
    expect(output.error).toBeUndefined();
    expect(output.result).toHaveLength(28);
    expect(output.result).toContain("register");
    expect(output.result).toContain("create_workspace");
    expect(output.result).toContain("merge_proposal");
    expect(output.result).toContain("workspace_digest");
  });

  it("filters operations by module", async () => {
    const result = await tool.handle({
      code: `async () => Object.keys(catalog.operations.session)`,
    });
    const output = JSON.parse(result.content[0].text);
    expect(output.result).toContain("session_list");
    expect(output.result).toContain("session_get");
  });

  it("searches prompts by name", async () => {
    const result = await tool.handle({
      code: `async () => catalog.prompts.filter(p => p.name.includes('interleaved'))`,
    });
    const output = JSON.parse(result.content[0].text);
    expect(output.result.length).toBeGreaterThanOrEqual(1);
    expect(output.result.some((p: { name: string }) => p.name === "interleaved-thinking")).toBe(true);
  });

  it("searches resources by URI pattern", async () => {
    const result = await tool.handle({
      code: `async () => catalog.resources.filter(r => r.uri.includes('operations'))`,
    });
    const output = JSON.parse(result.content[0].text);
    expect(output.result.length).toBeGreaterThanOrEqual(2);
  });

  it("returns resource templates", async () => {
    const result = await tool.handle({
      code: `async () => catalog.resourceTemplates.map(t => t.uriTemplate)`,
    });
    const output = JSON.parse(result.content[0].text);
    expect(output.result.length).toBeGreaterThan(0);
    expect(output.result.some((t: string) => t.includes("{op}"))).toBe(true);
  });

  it("returns durationMs in response envelope", async () => {
    const result = await tool.handle({
      code: `async () => 42`,
    });
    const output = JSON.parse(result.content[0].text);
    expect(output.durationMs).toBeTypeOf("number");
    expect(output.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("captures console.log in logs", async () => {
    const result = await tool.handle({
      code: `async () => { console.log("hello"); return "done"; }`,
    });
    const output = JSON.parse(result.content[0].text);
    expect(output.logs).toContain("hello");
    expect(output.result).toBe("done");
  });

  it("blocks access to process", async () => {
    const result = await tool.handle({
      code: `async () => typeof process`,
    });
    const output = JSON.parse(result.content[0].text);
    expect(output.result).toBe("undefined");
  });

  it("returns truncated output instead of throwing on oversized results", async () => {
    const result = await tool.handle({
      code: `async () => ({ payload: "x".repeat(30000) })`,
    });
    const output = JSON.parse(result.content[0].text);
    expect(output.error).toBeUndefined();
    expect(output.truncated).toBe(true);
    expect(typeof output.result).toBe("string");
    expect(output.result).toContain("[truncated]");
  });

  it("returns error for invalid code", async () => {
    const result = await tool.handle({
      code: `async () => { throw new Error("search failed"); }`,
    });
    const output = JSON.parse(result.content[0].text);
    expect(output.error).toBe("search failed");
    expect(output.result).toBeNull();
  });

  it("catalog top-level is frozen (writes silently fail)", async () => {
    const result = await tool.handle({
      code: `async () => { catalog.newProp = "bad"; return catalog.newProp; }`,
    });
    const output = JSON.parse(result.content[0].text);
    // Object.freeze in sloppy mode: assignment silently fails, property not added
    // undefined serializes to null in JSON
    expect(output.result).toBeNull();
  });
});

// The executor evaluates the submitted string and CALLS the result, so a
// submission of bare top-level statements fails with a parse or type error
// that says nothing about the actual contract. Both the description and the
// error have to name the requirement.
describe("thoughtbox_search — submission contract", () => {
  it("names the function requirement and shows a working example", () => {
    expect(SEARCH_TOOL.description).toMatch(/must evaluate to a function/i);
    expect(SEARCH_TOOL.description).toContain("async () =>");
    expect(searchToolInputSchema.shape.code.description).toMatch(
      /must evaluate to a function/i,
    );
  });

  it("explains the contract when the code evaluates to a non-function", async () => {
    const result = await tool.handle({ code: `catalog.operations` });
    const output = JSON.parse(result.content[0].text);
    expect(output.result).toBeNull();
    expect(output.error).toMatch(/must evaluate to a function/i);
    expect(output.error).toContain("async () =>");
    // The old error blamed the catalog, which sent readers the wrong way.
    expect(output.error).not.toMatch(/catalog\.operations is not a function/);
  });

  it("explains the contract when bare top-level statements are submitted", async () => {
    const result = await tool.handle({ code: `const ops = catalog.operations; return ops;` });
    const output = JSON.parse(result.content[0].text);
    expect(output.result).toBeNull();
    expect(output.error).toMatch(/must evaluate to a function/i);
    expect(output.error).toContain("async () =>");
  });

  it("still reports a genuine syntax error inside a well-formed function", async () => {
    const result = await tool.handle({ code: `async () => { const x = ; return x; }` });
    const output = JSON.parse(result.content[0].text);
    expect(output.result).toBeNull();
    expect(output.error).toMatch(/unexpected token/i);
  });

  it("leaves errors thrown inside a valid function untouched", async () => {
    const result = await tool.handle({
      code: `async () => { throw new Error("search failed"); }`,
    });
    const output = JSON.parse(result.content[0].text);
    expect(output.error).toBe("search failed");
  });
});
