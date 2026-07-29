import express from "express";
import { describe, expect, it } from "vitest";
import { createEventStreamSurface } from "../event-stream.js";
import type { ThoughtboxEvent } from "../../events/types.js";

function listRoutes(app: express.Express): string[] {
  const router = (app as express.Express & {
    router?: { stack?: Array<{ route?: { path?: string } }> };
  }).router;

  return (router?.stack ?? [])
    .map((layer) => layer.route?.path)
    .filter((path): path is string => typeof path === "string");
}

/**
 * Mount the surface against a stub that captures the /events handler, then
 * drive it with a fake request/response pair. This exercises the real filter
 * logic without binding a port.
 */
function connectClient(
  surface: ReturnType<typeof createEventStreamSurface>,
  query: Record<string, string>,
): string[] {
  let handler: ((req: express.Request, res: express.Response) => void) | undefined;
  const stubApp = {
    get(path: string, h: (req: express.Request, res: express.Response) => void) {
      if (path === "/events") handler = h;
    },
  } as unknown as express.Express;

  surface.mount(stubApp);
  if (!handler) throw new Error("surface did not register a /events handler");

  const writes: string[] = [];
  const req = { query, on() {} } as unknown as express.Request;
  const res = {
    writeHead() {},
    write(chunk: string) {
      writes.push(chunk);
      return true;
    },
  } as unknown as express.Response;

  handler(req, res);
  // Drop the ": connected" preamble; callers assert on delivered events.
  writes.length = 0;
  return writes;
}

function deliveredTypes(writes: string[]): string[] {
  return writes.map((w) => JSON.parse(w.replace(/^data: /, "").trim()).type);
}

describe("event stream surface", () => {
  it("mounts /events route", () => {
    const app = express();
    const surface = createEventStreamSurface();
    surface.mount(app);

    expect(listRoutes(app)).toContain("/events");
  });

  it("does not mount when not called", () => {
    const app = express();
    createEventStreamSurface();

    expect(listRoutes(app)).not.toContain("/events");
  });

  it("broadcast does not throw with no clients", () => {
    const surface = createEventStreamSurface();
    const event: ThoughtboxEvent = {
      source: "hub",
      type: "problem_created",
      workspaceId: "ws-1",
      timestamp: new Date().toISOString(),
      data: { title: "test" },
    };

    expect(() => surface.broadcast(event)).not.toThrow();
  });

  it("delivers workspaceId '*' events to a client filtered to one workspace", () => {
    const surface = createEventStreamSurface();
    const writes = connectClient(surface, { workspace_id: "ws-1" });

    // Registration precedes workspace membership, so it carries '*'.
    surface.broadcast({
      source: "hub",
      type: "agent_registered",
      workspaceId: "*",
      timestamp: new Date().toISOString(),
      data: { agentId: "a-1", name: "alice" },
    });
    // A different workspace's event must still be filtered out.
    surface.broadcast({
      source: "hub",
      type: "problem_created",
      workspaceId: "ws-2",
      timestamp: new Date().toISOString(),
      data: {},
    });

    expect(deliveredTypes(writes)).toEqual(["agent_registered"]);
  });

  it("source filter 'thought' receives thought_recorded and not hub events", () => {
    const surface = createEventStreamSurface();
    const writes = connectClient(surface, { source: "thought" });

    surface.broadcast({
      source: "thought",
      type: "thought_recorded",
      workspaceId: "ws-1",
      timestamp: new Date().toISOString(),
      data: { sessionId: "s-1", thoughtNumber: 1, kind: "added" },
    });
    surface.broadcast({
      source: "hub",
      type: "problem_created",
      workspaceId: "ws-1",
      timestamp: new Date().toISOString(),
      data: {},
    });
    // '*' bypasses the WORKSPACE filter only — the source filter still applies.
    surface.broadcast({
      source: "hub",
      type: "agent_registered",
      workspaceId: "*",
      timestamp: new Date().toISOString(),
      data: {},
    });

    expect(deliveredTypes(writes)).toEqual(["thought_recorded"]);
  });
});
