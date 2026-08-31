/**
 * Team-hub channel — shared types.
 *
 * The channel is a one-way bridge: it subscribes to the hub's SSE stream at
 * /events and forwards selected events into a live Claude Code session as
 * `notifications/claude/channel` notifications. It exposes no tools — the
 * session already holds full `tb.hub` write access through the team-hub MCP
 * server, so acknowledgements and replies go through `thoughtbox_execute`.
 */

export interface ChannelConfig {
  /** Fully-resolved SSE URL, query params included. */
  eventsUrl: string;
  /**
   * Hub agentId this session acts as. When set, `impact_detected` events are
   * forwarded only when they target this agent. When unset the channel runs
   * in observer mode and forwards every impact.
   */
  agentId?: string;
  /** Workspace filter, passed to /events as `workspace_id`. */
  workspaceId?: string;
  /**
   * Additional hub event types forwarded unfiltered (e.g. `message_posted`).
   * `impact_detected` is always handled and never needs listing here.
   */
  forwardTypes: ReadonlySet<string>;
}

/** One notification pushed into the session. */
export interface ChannelPush {
  content: string;
  /** Flattened onto the `<channel>` tag as attributes — strings only. */
  meta: Record<string, string>;
}
