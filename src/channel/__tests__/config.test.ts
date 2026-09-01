import { describe, expect, it } from "vitest";
import { resolveChannelConfig, DEFAULT_EVENTS_URL } from "../config.js";

describe("resolveChannelConfig", () => {
  it("defaults to the local hub with the hub source filter", () => {
    const config = resolveChannelConfig({});
    const url = new URL(config.eventsUrl);
    expect(`${url.origin}${url.pathname}`).toBe(DEFAULT_EVENTS_URL);
    expect(url.searchParams.get("source")).toBe("hub");
    expect(url.searchParams.get("workspace_id")).toBeNull();
    expect(config.agentId).toBeUndefined();
    expect(config.forwardTypes.size).toBe(0);
  });

  it("threads workspace and agent identity through", () => {
    const config = resolveChannelConfig({
      HUB_CHANNEL_AGENT_ID: "agent-a",
      HUB_CHANNEL_WORKSPACE_ID: "ws-1",
    });
    expect(config.agentId).toBe("agent-a");
    expect(config.workspaceId).toBe("ws-1");
    expect(new URL(config.eventsUrl).searchParams.get("workspace_id")).toBe("ws-1");
  });

  it("respects an explicit events URL", () => {
    const config = resolveChannelConfig({
      HUB_EVENTS_URL: "http://10.0.0.5:1731/events",
    });
    expect(config.eventsUrl.startsWith("http://10.0.0.5:1731/events?")).toBe(true);
  });

  it("parses the forward list, trimming blanks", () => {
    const config = resolveChannelConfig({
      HUB_CHANNEL_FORWARD: " message_posted , proposal_created,, ",
    });
    expect([...config.forwardTypes].sort()).toEqual([
      "message_posted",
      "proposal_created",
    ]);
  });

  it("treats empty-string env values as unset", () => {
    const config = resolveChannelConfig({
      HUB_CHANNEL_AGENT_ID: "  ",
      HUB_CHANNEL_WORKSPACE_ID: "",
    });
    expect(config.agentId).toBeUndefined();
    expect(config.workspaceId).toBeUndefined();
  });
});
