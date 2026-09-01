import type { Express, Request, Response } from "express";
import type { ThoughtboxEvent } from "../events/types.js";

interface SseClient {
  res: Response;
  workspaceId: string;
  sourceFilter: "all" | "hub" | "thought";
}

export interface EventStreamSurface {
  mount(app: Express): void;
  broadcast(event: ThoughtboxEvent): void;
}

/**
 * Comment frame written periodically to every connected client so idle
 * streams keep carrying bytes. Without it, intermediaries (observed:
 * Docker Desktop's port proxy, ~5-minute idle cull, 2026-09-01) silently
 * drop quiet SSE connections and subscribers reconnect in a loop.
 */
export const KEEPALIVE_FRAME = ": keepalive\n\n";
const KEEPALIVE_INTERVAL_MS = 25_000;

export function createEventStreamSurface(): EventStreamSurface {
  const clients = new Set<SseClient>();

  const keepalive = setInterval(() => {
    for (const client of clients) {
      try {
        client.res.write(KEEPALIVE_FRAME);
      } catch {
        clients.delete(client);
      }
    }
  }, KEEPALIVE_INTERVAL_MS);
  // The surface lives for the process lifetime; never hold the process open
  // for keepalives alone (also lets vitest workers exit cleanly).
  keepalive.unref?.();

  function broadcast(event: ThoughtboxEvent): void {
    const payload = `data: ${JSON.stringify(event)}\n\n`;
    for (const client of clients) {
      // An event carrying workspaceId '*' precedes workspace membership
      // (agent_registered fires before the agent has joined anything), so it
      // has no workspace to be scoped to and reaches every client — otherwise
      // a dashboard watching one workspace would never see agents appear.
      const workspaceMatch =
        event.workspaceId === "*" ||
        client.workspaceId === "*" ||
        client.workspaceId === event.workspaceId;
      const sourceMatch =
        client.sourceFilter === "all" ||
        client.sourceFilter === event.source;

      if (workspaceMatch && sourceMatch) {
        try {
          client.res.write(payload);
        } catch {
          clients.delete(client);
        }
      }
    }
  }

  function mount(app: Express): void {
    app.get("/events", (req: Request, res: Response) => {
      const workspaceId =
        (req.query.workspace_id as string) || "*";
      const sourceFilter =
        (req.query.source as "all" | "hub" | "thought") ||
        "all";

      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      });
      res.write(": connected\n\n");

      const client: SseClient = {
        res,
        workspaceId,
        sourceFilter,
      };
      clients.add(client);

      req.on("close", () => {
        clients.delete(client);
      });
    });
  }

  return { mount, broadcast };
}
