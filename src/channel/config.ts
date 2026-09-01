import type { ChannelConfig } from "./types.js";

export const DEFAULT_EVENTS_URL = "http://127.0.0.1:1731/events";

/**
 * Resolve channel configuration from the environment.
 *
 * HUB_EVENTS_URL            SSE endpoint (default http://127.0.0.1:1731/events)
 * HUB_CHANNEL_AGENT_ID      this session's hub agentId — enables targeted mode
 * HUB_CHANNEL_WORKSPACE_ID  restrict the stream to one workspace
 * HUB_CHANNEL_FORWARD       comma-separated extra event types to forward as-is
 */
export function resolveChannelConfig(env: NodeJS.ProcessEnv): ChannelConfig {
  const url = new URL(env.HUB_EVENTS_URL || DEFAULT_EVENTS_URL);
  // Thought-ledger events are high-volume process noise; the channel only
  // carries hub coordination events.
  url.searchParams.set("source", "hub");

  const workspaceId = env.HUB_CHANNEL_WORKSPACE_ID?.trim() || undefined;
  if (workspaceId !== undefined) {
    url.searchParams.set("workspace_id", workspaceId);
  }

  const forwardTypes = new Set(
    (env.HUB_CHANNEL_FORWARD ?? "")
      .split(",")
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0),
  );

  const config: ChannelConfig = {
    eventsUrl: url.toString(),
    forwardTypes,
  };
  const agentId = env.HUB_CHANNEL_AGENT_ID?.trim() || undefined;
  if (agentId !== undefined) config.agentId = agentId;
  if (workspaceId !== undefined) config.workspaceId = workspaceId;
  return config;
}
