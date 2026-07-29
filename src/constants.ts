/**
 * Deterministic workspace identifiers.
 *
 * Provenance: extracted from the Thoughtbox MCP server's
 * `src/auth/static-workspace.ts`. That module resolved a slug to a workspace
 * UUID and, when Supabase was configured, upserted the matching row. Team Hub
 * is filesystem-only and single-tenant, so only the ID derivation survives —
 * there is no database round-trip and no auth path to resolve a slug from.
 *
 * The UUIDs and the `deterministicUuid` algorithm are carried over verbatim so
 * that data written by the original server under the `local-dev` workspace
 * remains addressable here.
 */

import crypto from "node:crypto";

/**
 * The workspace every local (non-multi-tenant) request runs under.
 *
 * The original server called `ensureStaticWorkspace('local-dev')` on the
 * local-mode paths (`src/index.ts` session setup and OAuth
 * `defaultWorkspaceId`); with Supabase unconfigured that call returned this
 * constant directly.
 */
export const LOCAL_WORKSPACE_ID: string = "00000000-0000-4000-a000-000000000002";

/** The original's `default` static workspace, kept for slug parity. */
export const DEFAULT_WORKSPACE_ID: string = "00000000-0000-4000-a000-000000000001";

/**
 * Static workspace UUIDs, keyed by slug — verbatim from the original
 * `STATIC_WORKSPACE_IDS` table.
 */
export const STATIC_WORKSPACE_IDS: Record<string, string> = {
  default: DEFAULT_WORKSPACE_ID,
  "local-dev": LOCAL_WORKSPACE_ID,
};

/**
 * Derive a stable RFC-4122 v4-shaped UUID from an arbitrary slug.
 *
 * Algorithm is unchanged from the original: SHA-256 the input, then splice the
 * version nibble (4) and the variant bits (0b10) into the hex digest.
 */
export function deterministicUuid(input: string): string {
  const hex = crypto.createHash("sha256").update(input).digest("hex");
  const parts = [
    hex.slice(0, 8),
    hex.slice(8, 12),
    "4" + hex.slice(13, 16),
    ((parseInt(hex.slice(16, 18), 16) & 0x3f) | 0x80)
      .toString(16)
      .padStart(2, "0") + hex.slice(18, 20),
    hex.slice(20, 32),
  ];
  return parts.join("-");
}

/**
 * Resolve a workspace slug to its UUID: the static table when the slug is
 * known, a deterministic derivation otherwise.
 */
export function staticWorkspaceId(slug: string): string {
  return STATIC_WORKSPACE_IDS[slug] ?? deterministicUuid(slug);
}
