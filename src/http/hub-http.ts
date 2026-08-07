import type { Express, Request, Response } from "express";
import type { HubHandler } from "../hub/hub-handler.js";

export interface HubApiSurface {
  mount(app: Express): void;
}

/**
 * Read surface behind the two read-only endpoints (RFC 0001: HubReadModel).
 * Structural on purpose: src/http stays decoupled from src/celld — the
 * composition layer passes in whichever implementation is wired (filesystem
 * or celld-routed), and this module never imports either.
 */
export interface HubReadSurface {
  listWorkspaces(): Promise<unknown[]>;
  workspaceSnapshot(workspaceId: string): Promise<unknown | undefined>;
}

/** Additive structured-error body (RFC 0001 §Error codes): {error} always; code/retryable/details when carried. */
function errorBody(error: unknown): Record<string, unknown> {
  const message = error instanceof Error ? error.message : String(error);
  const body: Record<string, unknown> = { error: message };
  if (error instanceof Error) {
    const coded = error as Error & { code?: unknown; retryable?: unknown; details?: unknown };
    if (typeof coded.code === "string") {
      body.code = coded.code;
      if (typeof coded.retryable === "boolean") body.retryable = coded.retryable;
      if (typeof coded.details === "object" && coded.details !== null) body.details = coded.details;
    }
  }
  return body;
}

export function createHubApiSurface(
  sharedHubHandler: HubHandler,
  readModel: HubReadSurface,
): HubApiSurface {
  function mount(app: Express): void {
    app.post("/hub/api", async (req: Request, res: Response) => {
      try {
        const { operation, agentId, ...args } = req.body as {
          operation: string;
          agentId?: string;
          [key: string]: unknown;
        };

        if (!operation) {
          res.status(400).json({ error: "operation is required" });
          return;
        }

        const result = await sharedHubHandler.handle(
          agentId ?? null,
          operation,
          args as Record<string, any>,
        );

        res.json(result);
      } catch (error) {
        res.status(400).json(errorBody(error));
      }
    });

    // The two read-only endpoints below deliberately bypass the hub's
    // stage-gating and membership checks: this is a local single-trust-domain
    // server whose observer (the dashboard) has no agent identity to gate on.
    // They read through the injected HubReadSurface rather than storage
    // directly, so celld-routed workspaces appear alongside filesystem ones.

    app.get("/hub/workspaces", async (_req: Request, res: Response) => {
      try {
        res.json({ workspaces: await readModel.listWorkspaces() });
      } catch (error) {
        res.status(500).json(errorBody(error));
      }
    });

    app.get(
      "/hub/workspaces/:id/snapshot",
      async (req: Request, res: Response) => {
        try {
          // Express 5 types a path param as string | string[] to cover
          // repeated segments; a single `:id` only ever produces a string.
          const rawId = req.params.id;
          const workspaceId = Array.isArray(rawId) ? String(rawId[0]) : rawId;
          const snapshot = await readModel.workspaceSnapshot(workspaceId);

          if (snapshot === undefined) {
            res
              .status(404)
              .json({ error: `Workspace not found: ${workspaceId}` });
            return;
          }

          res.json(snapshot);
        } catch (error) {
          res.status(500).json(errorBody(error));
        }
      },
    );
  }

  return { mount };
}

export function shouldWarnOnExposedLocalMode(
  host: string | undefined,
  isMultiTenant: boolean,
): boolean {
  if (isMultiTenant) return false;
  return (host ?? "0.0.0.0") === "0.0.0.0";
}
