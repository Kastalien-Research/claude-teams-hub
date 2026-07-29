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
        operations: Record<string, Record<string, { title: string; description: string }>>;
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
