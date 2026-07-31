/**
 * Catalog drift test.
 *
 * STATIC_RESOURCES / RESOURCE_TEMPLATES (src/resources/static-registry.ts)
 * are the single source of truth for static resource metadata. Three surfaces
 * derive from it: registerResource() registrations, the ListResources /
 * ListResourceTemplates escape hatches, and the Code Mode search catalog.
 *
 * This test verifies the derivations actually hold on a live server —
 * every registry entry is listed, readable, and mirrored in the search
 * catalog — so a hand-edit to any one surface fails here instead of
 * drifting silently.
 */
import { describe, it, expect } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { createMcpServer } from "../../server-factory.js";
import { InMemoryStorage } from "../../persistence/index.js";
import { ThoughtHandler } from "../../thought-handler.js";
import { buildSearchCatalog } from "../search-index.js";
import { SEARCH_TOOL } from "../search-tool.js";
import { HUB_SDK_METHODS, HUB_OPERATION_SDK_CALLS } from "../hub-sdk-methods.js";
import { TB_SDK_TYPES } from "../sdk-types.js";
import { HUB_OPERATIONS } from "../../hub/operations.js";
import { THOUGHT_TYPE_REQUIRED_FIELDS } from "../../thought/operations.js";
import { thoughtToolInputSchema } from "../../thought/tool.js";
import {
  STATIC_RESOURCES,
  RESOURCE_TEMPLATES,
} from "../../resources/static-registry.js";

const silentLogger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

async function withClient<T>(
  fn: (client: Client) => Promise<T>,
): Promise<T> {
  const server = await createMcpServer({
    storage: new InMemoryStorage(),
    logger: silentLogger,
  });
  const client = new Client(
    { name: "catalog-drift-test", version: "1.0.0" },
    { capabilities: {} },
  );
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    return await fn(client);
  } finally {
    await Promise.allSettled([client.close(), server.close()]);
  }
}

describe("static catalog single-registry (drift guard)", () => {
  it("registry has unique keys and URIs", () => {
    const uris = STATIC_RESOURCES.map((r) => r.uri);
    const keys = STATIC_RESOURCES.map((r) => r.key);
    expect(new Set(uris).size).toBe(uris.length);
    expect(new Set(keys).size).toBe(keys.length);

    const templateUris = RESOURCE_TEMPLATES.map((t) => t.uriTemplate);
    const templateKeys = RESOURCE_TEMPLATES.map((t) => t.key);
    expect(new Set(templateUris).size).toBe(templateUris.length);
    expect(new Set(templateKeys).size).toBe(templateKeys.length);
  });

  it("resources/list matches the registry exactly", async () => {
    await withClient(async (client) => {
      const { resources } = await client.listResources();
      const listed = resources
        .map((r) => ({
          uri: r.uri,
          name: r.name,
          description: r.description,
          mimeType: r.mimeType,
        }))
        .sort((a, b) => a.uri.localeCompare(b.uri));
      const expected = STATIC_RESOURCES.map((d) => ({
        uri: d.uri,
        name: d.name,
        description: d.description,
        mimeType: d.mimeType,
      })).sort((a, b) => a.uri.localeCompare(b.uri));
      expect(listed).toEqual(expected);
    });
  });

  it("resources/templates/list matches the registry exactly", async () => {
    await withClient(async (client) => {
      const { resourceTemplates } = await client.listResourceTemplates();
      const listed = resourceTemplates
        .map((t) => ({
          uriTemplate: t.uriTemplate,
          name: t.name,
          description: t.description,
          mimeType: t.mimeType,
        }))
        .sort((a, b) => a.uriTemplate.localeCompare(b.uriTemplate));
      const expected = RESOURCE_TEMPLATES.map((d) => ({
        uriTemplate: d.uriTemplate,
        name: d.name,
        description: d.description,
        mimeType: d.mimeType,
      })).sort((a, b) => a.uriTemplate.localeCompare(b.uriTemplate));
      expect(listed).toEqual(expected);
    });
  });

  it("every registry resource is readable with the declared mimeType", async () => {
    await withClient(async (client) => {
      for (const def of STATIC_RESOURCES) {
        const result = await client.readResource({ uri: def.uri });
        expect(result.contents.length).toBeGreaterThan(0);
        const content = result.contents[0] as {
          uri: string;
          mimeType?: string;
          text?: string;
        };
        expect(content.uri).toBe(def.uri);
        expect(content.mimeType).toBe(def.mimeType);
        expect(typeof content.text).toBe("string");
        expect((content.text as string).length).toBeGreaterThan(0);
      }
    });
  });

  it("search catalog resources/templates mirror the registry", () => {
    const catalog = buildSearchCatalog();
    expect(catalog.resources).toEqual(
      STATIC_RESOURCES.map((d) => ({
        name: d.name,
        uri: d.uri,
        description: d.description,
        mimeType: d.mimeType,
      })),
    );
    expect(catalog.resourceTemplates).toEqual(
      RESOURCE_TEMPLATES.map((d) => ({
        name: d.name,
        uriTemplate: d.uriTemplate,
        description: d.description,
        mimeType: d.mimeType,
      })),
    );
  });

  it("search-tool description lists every operations module incl. hub", () => {
    const catalog = buildSearchCatalog();
    // The SEARCH_TOOL description enumerates modules; keep it in sync with
    // the real catalog keys.
    for (const moduleName of Object.keys(catalog.operations)) {
      expect(SEARCH_TOOL.description).toContain(moduleName);
    }
    expect(Object.keys(catalog.operations)).toContain("hub");
  });
});

/**
 * KNOWN-ISSUES #3: catalog hub keys are snake_case, the executable SDK is
 * camelCase. Every discovered hub entry must name the call that runs it, and
 * that name must be the one execute-tool actually binds — hence both surfaces
 * reading the single HUB_SDK_METHODS map.
 */
describe("hub catalog entries name their callable (discovery/execute parity)", () => {
  it("every one of the 29 hub operations carries an sdkMethod", () => {
    const hub = buildSearchCatalog().operations["hub"]!;
    const names = Object.keys(hub);
    expect(names).toHaveLength(29);
    expect(HUB_OPERATIONS).toHaveLength(29);

    const missing = names.filter((name) => !hub[name]!.sdkMethod);
    expect(missing).toEqual([]);
  });

  it("sdkMethod is the fully-qualified tb.hub call execute-tool binds", () => {
    const hub = buildSearchCatalog().operations["hub"]!;
    // Invert the map execute-tool iterates to build tb.hub, independently of
    // HUB_OPERATION_SDK_CALLS, so a wrong derivation cannot pass.
    const expected = Object.fromEntries(
      Object.entries(HUB_SDK_METHODS).map(([method, operation]) => [
        operation,
        `tb.hub.${method}`,
      ]),
    );
    const actual = Object.fromEntries(
      Object.entries(hub).map(([name, op]) => [name, op.sdkMethod]),
    );
    expect(actual).toEqual(expected);
    expect(HUB_OPERATION_SDK_CALLS).toEqual(expected);
  });

  it("the map covers exactly the hub operations the catalog publishes", () => {
    const operationNames = HUB_OPERATIONS.map((op) => op.name).sort();
    expect(Object.values(HUB_SDK_METHODS).sort()).toEqual(operationNames);
  });

  it("search-tool description states the sandbox contract and sdkMethod", () => {
    // The sandbox binds `catalog` already parsed (verified by
    // search-tool.test.ts); the description must not send agents to
    // __catalogJson or imply tb is reachable from here.
    expect(SEARCH_TOOL.description).toContain("sdkMethod");
    expect(SEARCH_TOOL.description).toContain("tb.hub.reviewProposal");
    expect(SEARCH_TOOL.description).toContain("already parsed and frozen in scope");
    expect(SEARCH_TOOL.description).toContain("thoughtbox_execute");
  });
});

/**
 * KNOWN-ISSUES #2: the catalog advertised only the three base required fields
 * while the server enforces a payload per thoughtType, so a client trusting
 * the published schema could not build a valid typed thought.
 *
 * THOUGHT_TYPE_REQUIRED_FIELDS is the transcription of
 * ThoughtHandler.validateStructuredFields that the catalog schema derives
 * from. These tests hold it against the running validator, so the schema
 * cannot claim a contract the server does not enforce, or miss one it does.
 */
describe("thoughtbox_thought publishes its typed-payload contract", () => {
  /**
   * The minimal payload the catalog advertises for each type: only the keys
   * its property schemas mark required. belief_snapshot's entities carry no
   * required item keys, so `[{}]` is the advertised minimum — the same payload
   * every surface (catalog, zod, handler) has to accept.
   */
  const MINIMAL_PAYLOADS: Record<string, Record<string, unknown>> = {
    reasoning: {},
    finding: {},
    synthesis: {},
    question: {},
    conclusion: {},
    decision_frame: {
      confidence: "high",
      options: [{ label: "a", selected: true }],
    },
    action_report: {
      actionResult: { success: true, reversible: "yes", tool: "Bash", target: "/tmp" },
    },
    belief_snapshot: { beliefs: { entities: [{}] } },
    assumption_update: { assumptionChange: { newStatus: "refuted" } },
    context_snapshot: { contextData: {} },
    progress: { progressData: { task: "t", status: "done" } },
    action_receipt: { receiptData: { toolName: "Bash", match: true } },
  };

  /**
   * The four payload strings the handler rejects when empty (falsy checks in
   * validateActionReport / validateProgress / validateActionReceipt). Each
   * case names the catalog path that has to publish the same constraint.
   */
  const EMPTY_STRING_CASES: Array<{
    thoughtType: string;
    property: string;
    field: string;
    payload: Record<string, unknown>;
  }> = [
    {
      thoughtType: "action_report",
      property: "actionResult",
      field: "tool",
      payload: {
        actionResult: { success: true, reversible: "yes", tool: "", target: "/tmp" },
      },
    },
    {
      thoughtType: "action_report",
      property: "actionResult",
      field: "target",
      payload: {
        actionResult: { success: true, reversible: "yes", tool: "Bash", target: "" },
      },
    },
    {
      thoughtType: "progress",
      property: "progressData",
      field: "task",
      payload: { progressData: { task: "", status: "done" } },
    },
    {
      thoughtType: "action_receipt",
      property: "receiptData",
      field: "toolName",
      payload: { receiptData: { toolName: "", match: true } },
    },
  ];

  /** The catalog's schema for one key inside a payload object. */
  function catalogFieldSchema(property: string, field: string) {
    const op = buildSearchCatalog().operations["thought"]!["thoughtbox_thought"]!;
    const properties = (op.inputSchema as { properties: Record<string, unknown> })
      .properties;
    const payloadSchema = properties[property] as {
      properties: Record<string, unknown>;
    };
    return payloadSchema.properties[field] as {
      type: string;
      minLength?: number;
    };
  }

  function zodParse(input: Record<string, unknown>) {
    return thoughtToolInputSchema.safeParse({
      thought: "contract probe",
      nextThoughtNeeded: false,
      ...input,
    });
  }

  async function submit(input: Record<string, unknown>) {
    const storage = new InMemoryStorage();
    await storage.initialize();
    const handler = new ThoughtHandler(true, storage, `drift-${Math.random()}`);
    await handler.initialize();
    const result = await handler.processThought({
      thought: "contract probe",
      nextThoughtNeeded: false,
      ...input,
    });
    return {
      ok: result.isError !== true,
      text: String(result.content[0]?.text ?? ""),
    };
  }

  it("covers exactly the thoughtTypes the validator accepts", async () => {
    // Ask the validator itself which types are valid rather than re-reading
    // the switch statement: its rejection message enumerates them.
    const { ok, text } = await submit({ thoughtType: "not_a_real_type" });
    expect(ok).toBe(false);
    const listed = text
      .slice(text.indexOf("Valid types:") + "Valid types:".length)
      .replace(/\\n/g, " ")
      .split(/[,.]/)
      .map((s) => s.trim())
      .filter((s) => /^[a-z_]+$/.test(s));

    expect(listed.length).toBeGreaterThan(0);
    expect(Object.keys(THOUGHT_TYPE_REQUIRED_FIELDS).sort()).toEqual(
      [...new Set(listed)].sort(),
    );
  });

  it("accepts every thoughtType given only the advertised required fields", async () => {
    for (const [thoughtType, payload] of Object.entries(MINIMAL_PAYLOADS)) {
      const { ok, text } = await submit({ thoughtType, ...payload });
      expect(ok, `${thoughtType} rejected a minimal valid payload: ${text}`).toBe(true);
    }
  });

  /**
   * The tests above reach ThoughtHandler directly, which bypasses the zod
   * schema real MCP callers go through. A payload the catalog advertises is
   * only actually usable if BOTH gates pass it, so assert them as a pair.
   */
  it("the zod tool schema accepts every advertised minimal payload", () => {
    for (const [thoughtType, payload] of Object.entries(MINIMAL_PAYLOADS)) {
      const parsed = zodParse({ thoughtType, ...payload });
      expect(
        parsed.success,
        `${thoughtType} minimal payload rejected by zod: ${
          parsed.success ? "" : JSON.stringify(parsed.error.issues)
        }`,
      ).toBe(true);
    }
  });

  it("zod and the handler agree on every advertised minimal payload", async () => {
    for (const [thoughtType, payload] of Object.entries(MINIMAL_PAYLOADS)) {
      const zodOk = zodParse({ thoughtType, ...payload }).success;
      const { ok: handlerOk } = await submit({ thoughtType, ...payload });
      expect(
        zodOk,
        `${thoughtType}: zod=${zodOk} handler=${handlerOk} — surfaces disagree`,
      ).toBe(handlerOk);
    }
  });

  it("the catalog publishes minLength for the strings the handler needs non-empty", () => {
    for (const { property, field } of EMPTY_STRING_CASES) {
      const schema = catalogFieldSchema(property, field);
      expect(schema.type, `${property}.${field}`).toBe("string");
      expect(schema.minLength, `${property}.${field} must publish minLength`).toBe(1);
    }
  });

  it("empty strings are rejected by zod and the handler alike", async () => {
    for (const { thoughtType, property, field, payload } of EMPTY_STRING_CASES) {
      const parsed = zodParse({ thoughtType, ...payload });
      expect(
        parsed.success,
        `zod accepted empty ${property}.${field}`,
      ).toBe(false);

      const { ok } = await submit({ thoughtType, ...payload });
      expect(ok, `handler accepted empty ${property}.${field}`).toBe(false);
    }
  });

  it("rejects every typed thoughtType when its advertised payload is omitted", async () => {
    const typed = Object.entries(THOUGHT_TYPE_REQUIRED_FIELDS).filter(
      ([, fields]) => fields.length > 0,
    );
    // Every type with a declared requirement, and no others, must fail bare.
    expect(typed.map(([t]) => t).sort()).toEqual([
      "action_receipt",
      "action_report",
      "assumption_update",
      "belief_snapshot",
      "context_snapshot",
      "decision_frame",
      "progress",
    ]);

    for (const [thoughtType] of typed) {
      const { ok } = await submit({ thoughtType });
      expect(ok, `${thoughtType} accepted a thought with no payload`).toBe(false);
    }
    for (const [thoughtType, fields] of Object.entries(THOUGHT_TYPE_REQUIRED_FIELDS)) {
      if (fields.length > 0) continue;
      const { ok } = await submit({ thoughtType });
      expect(ok, `${thoughtType} should need no payload`).toBe(true);
    }
  });

  it("the advertised schema publishes the same per-type requirements", () => {
    const op = buildSearchCatalog().operations["thought"]!["thoughtbox_thought"]!;
    const schema = op.inputSchema as {
      properties: Record<string, unknown>;
      required: string[];
      allOf: Array<{ if: { properties: { thoughtType: { const: string } } }; then: { required: string[] } }>;
    };

    expect(schema.required).toEqual(["thought", "nextThoughtNeeded", "thoughtType"]);

    // Each required payload field is a declared property, and each type's
    // conditional requirement is published.
    const published = Object.fromEntries(
      schema.allOf.map((entry) => [
        entry.if.properties.thoughtType.const,
        entry.then.required.slice().sort(),
      ]),
    );
    const expected = Object.fromEntries(
      Object.entries(THOUGHT_TYPE_REQUIRED_FIELDS)
        .filter(([, fields]) => fields.length > 0)
        .map(([thoughtType, fields]) => [thoughtType, [...fields].sort()]),
    );
    expect(published).toEqual(expected);

    for (const fields of Object.values(THOUGHT_TYPE_REQUIRED_FIELDS)) {
      for (const field of fields) {
        expect(schema.properties).toHaveProperty(field);
      }
    }

    // thoughtType's enum must not advertise a type the map does not describe.
    const enumValues = (schema.properties["thoughtType"] as { enum: string[] }).enum;
    expect(enumValues.slice().sort()).toEqual(
      Object.keys(THOUGHT_TYPE_REQUIRED_FIELDS).sort(),
    );
  });

  it("the description and annotation name the typed payloads", () => {
    const op = buildSearchCatalog().operations["thought"]!["thoughtbox_thought"]!;
    // Annotations are appended to the description by annotateCatalog, so one
    // string covers both surfaces an agent reads at discovery time.
    for (const field of new Set(Object.values(THOUGHT_TYPE_REQUIRED_FIELDS).flat())) {
      expect(op.description).toContain(field);
    }
    for (const thoughtType of Object.keys(THOUGHT_TYPE_REQUIRED_FIELDS)) {
      expect(op.description).toContain(thoughtType);
    }
  });

  it("the tb SDK declaration names every thoughtType and its payload", () => {
    for (const thoughtType of Object.keys(THOUGHT_TYPE_REQUIRED_FIELDS)) {
      expect(TB_SDK_TYPES).toContain(thoughtType);
    }
    for (const field of new Set(Object.values(THOUGHT_TYPE_REQUIRED_FIELDS).flat())) {
      expect(TB_SDK_TYPES).toContain(field);
    }
  });
});
