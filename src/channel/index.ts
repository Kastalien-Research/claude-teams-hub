#!/usr/bin/env node

/**
 * Team-hub channel — stdio MCP server (Claude Code Channels research preview).
 *
 * Bridges the hub's SSE /events stream into a live Claude Code session as
 * `notifications/claude/channel` notifications, so an agent learns that
 * another agent's recorded work change impacts its declared work intent at
 * the next turn boundary instead of at its next poll.
 *
 * One-way by design: the session already has full `tb.hub` write access
 * through the team-hub MCP server, so acknowledgements and channel replies go
 * through `thoughtbox_execute` — this server exposes no tools.
 *
 * Launch (research preview):
 *   claude --channels --dangerously-load-development-channels team-hub-channel
 * with an .mcp.json entry running `node dist/channel/index.js` and the
 * HUB_CHANNEL_* environment described in config.ts.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { Request } from "@modelcontextprotocol/sdk/types.js";
import { resolveChannelConfig } from "./config.js";
import { decideForward, parseHubEvent } from "./filter.js";
import { subscribeSse } from "./sse.js";
import type { ChannelPush } from "./types.js";

const SERVER_VERSION = "0.1.0";

interface ChannelNotification {
  method: "notifications/claude/channel";
  params: { content: string; meta: Record<string, string> };
}

function buildInstructions(agentId: string | undefined): string {
  const identity =
    agentId === undefined
      ? "This channel runs in OBSERVER mode (no HUB_CHANNEL_AGENT_ID): every impact in the workspace is forwarded, not just yours."
      : `This channel is filtered to hub agent ${agentId}: forwarded impacts target that agent's declared work intents.`;
  return [
    "Team-hub coordination events arrive as",
    '<channel source="team-hub-channel" event_type="..." workspace_id="..." ...>body</channel>.',
    "",
    identity,
    "",
    "On event_type=\"impact_detected\": another agent recorded a work change that overlaps a declared work intent",
    "(shared scope, contractRef, or assumption). Before continuing work in the overlapping scope, review the change",
    "and acknowledge the impact through the team-hub MCP server (tb.hub.acknowledgeImpact); the body carries the",
    "exact call. Deduplicate by the impact_id attribute — the same impact is never worth acting on twice.",
    "",
    "Delivery is turn-gated and best-effort: events arriving mid-turn queue until the next turn boundary, and an",
    "event_type=\"channel_reconnected\" notification means the stream was down and events in the gap were NOT",
    "replayed — run tb.hub.listImpacts({ workspaceId, status: \"pending\" }) to catch up before trusting silence.",
    "This channel exposes no tools; all hub writes go through the team-hub MCP server.",
  ].join("\n");
}

async function main(): Promise<void> {
  const config = resolveChannelConfig(process.env);

  const mcp = new Server<Request, ChannelNotification>(
    { name: "team-hub-channel", version: SERVER_VERSION },
    {
      capabilities: {
        experimental: {
          "claude/channel": {},
        },
      },
      instructions: buildInstructions(config.agentId),
    },
  );

  const push = (notification: ChannelPush) => {
    mcp
      .notification({
        method: "notifications/claude/channel",
        params: notification,
      })
      .catch((error: unknown) => {
        console.error("[team-hub-channel] notification failed:", error);
      });
  };

  // Subscribe only once the MCP handshake completes — a notification sent
  // before initialization would be dropped or rejected by the client.
  mcp.oninitialized = () => {
    console.error(
      `[team-hub-channel] subscribed to ${config.eventsUrl}` +
        (config.agentId === undefined
          ? " (observer mode)"
          : ` for agent ${config.agentId}`),
    );
    subscribeSse(config.eventsUrl, {
      onData: (data) => {
        const event = parseHubEvent(data);
        if (event === null) return;
        const decision = decideForward(event, config);
        if (decision !== null) push(decision);
      },
      onConnect: ({ reconnected, downMs }) => {
        if (!reconnected) return;
        push({
          content:
            `Event stream reconnected after ~${Math.round(downMs / 1000)}s down. Events in the gap were not ` +
            `replayed — run tb.hub.listImpacts({ workspaceId, status: "pending" }) to catch up.`,
          meta: {
            event_type: "channel_reconnected",
            down_ms: String(downMs),
          },
        });
      },
      onError: (error) => {
        console.error(
          "[team-hub-channel] event stream error (will reconnect):",
          error instanceof Error ? error.message : error,
        );
      },
    });
  };

  const transport = new StdioServerTransport();
  await mcp.connect(transport);
  console.error("[team-hub-channel] connected over stdio, awaiting initialize");
}

main().catch((error) => {
  console.error("[team-hub-channel] fatal:", error);
  process.exit(1);
});
