import { describe, it, expect } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { createMcpServer } from "../../server-factory.js";
import { InMemoryStorage } from "../../persistence/index.js";

const silentLogger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

async function connectedClient() {
  const server = await createMcpServer({
    storage: new InMemoryStorage(),
    logger: silentLogger,
  });
  const client = new Client(
    { name: "codemode-test-client", version: "1.0.0" },
    { capabilities: {} },
  );
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return { server, client };
}

describe("createMcpServer tool surface", () => {
  it("registers exactly the two Code Mode public tools", async () => {
    const { server, client } = await connectedClient();
    try {
      const { tools } = await client.listTools();
      const toolNames = tools.map((tool) => tool.name).sort();

      expect(toolNames).toEqual(["thoughtbox_execute", "thoughtbox_search"]);
      expect(client.getInstructions()).toContain("thoughtbox_search");
      expect(client.getInstructions()).toContain("thoughtbox_execute");
      expect(client.getInstructions()).not.toContain("thoughtbox_peer_notebook");
    } finally {
      await Promise.allSettled([client.close(), server.close()]);
    }
  });

  it("lists and serves the gateway operations catalog resource", async () => {
    const { server, client } = await connectedClient();
    try {
      const { resources } = await client.listResources();
      const listed = resources.find(
        (resource) => resource.uri === "thoughtbox://gateway/operations",
      );
      expect(listed).toBeDefined();

      const { contents } = await client.readResource({
        uri: "thoughtbox://gateway/operations",
      });
      expect(contents).toHaveLength(1);
      expect(contents[0]?.mimeType).toBe("application/json");

      const catalog = JSON.parse(contents[0]?.text as string) as {
        version: string;
        publicTools: Array<{ name: string }>;
        operations: Record<
          string,
          Record<
            string,
            {
              title: string;
              description: string;
              inputSchema?: { properties?: Record<string, unknown>; allOf?: unknown[] };
              sdkMethod?: string;
            }
          >
        >;
      };
      expect(catalog.version).toBe("1.0.0");
      expect(catalog.publicTools.map((tool) => tool.name)).toEqual([
        "thoughtbox_search",
        "thoughtbox_execute",
      ]);
      expect(Object.keys(catalog.operations).sort()).toEqual([
        "hub",
        "session",
        "thought",
        "vars",
      ]);
      expect(catalog.operations["thought"]?.["thoughtbox_thought"]?.description).toEqual(
        expect.any(String),
      );

      // KNOWN-ISSUES #3: the served catalog must name the callable for every
      // hub operation, since its own keys are snake_case and tb.hub is not.
      const hub = catalog.operations["hub"]!;
      const hubNames = Object.keys(hub);
      expect(hubNames).toHaveLength(28);
      expect(hubNames.filter((name) => !hub[name]!.sdkMethod)).toEqual([]);
      expect(hub["review_proposal"]?.sdkMethod).toBe("tb.hub.reviewProposal");

      // KNOWN-ISSUES #2: the served thoughtbox_thought schema must document
      // the payloads each thoughtType requires, not just the three base
      // fields. Contract details are pinned in catalog-drift.test.ts.
      const thought = catalog.operations["thought"]!["thoughtbox_thought"]!;
      expect(thought.inputSchema?.allOf).toEqual(expect.any(Array));
      expect((thought.inputSchema!.allOf as unknown[]).length).toBe(7);
      for (const payload of [
        "options",
        "actionResult",
        "beliefs",
        "assumptionChange",
        "contextData",
        "progressData",
        "receiptData",
      ]) {
        expect(thought.inputSchema?.properties).toHaveProperty(payload);
        expect(thought.description).toContain(payload);
      }

      const opDetail = await client.readResource({
        uri: "thoughtbox://gateway/operations/thoughtbox_thought",
      });
      const op = JSON.parse(opDetail.contents[0]?.text as string) as {
        module: string;
        name: string;
        title: string;
      };
      expect(op.module).toBe("thought");
      expect(op.name).toBe("thoughtbox_thought");

      await expect(
        client.readResource({ uri: "thoughtbox://gateway/operations/no_such_op" }),
      ).rejects.toThrow(/Unknown gateway operation/);
    } finally {
      await Promise.allSettled([client.close(), server.close()]);
    }
  });
});
