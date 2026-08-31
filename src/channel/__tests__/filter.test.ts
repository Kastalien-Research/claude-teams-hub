import { describe, expect, it } from "vitest";
import type { ThoughtboxEvent } from "../../events/types.js";
import { decideForward, parseHubEvent } from "../filter.js";
import type { ChannelConfig } from "../types.js";

function impactEvent(overrides: {
  targetAgentId?: string;
  impact?: Record<string, unknown> | null;
  matchingReasons?: unknown;
}): ThoughtboxEvent {
  const impact =
    overrides.impact !== undefined
      ? overrides.impact
      : {
          impactId: "imp-1",
          changeId: "chg-1",
          targetAgentId: overrides.targetAgentId ?? "agent-a",
          targetProblemId: "prob-1",
          targetIntentGeneration: 1,
          severity: "warning",
          status: "pending",
          matchingReasons: overrides.matchingReasons ?? [
            { kind: "scope", source: "src/dispatch", target: "src/dispatch/queue.ts" },
          ],
          detectedAt: "2026-08-31T00:00:00.000Z",
        };
  return {
    source: "hub",
    type: "impact_detected",
    workspaceId: "ws-1",
    timestamp: "2026-08-31T00:00:01.000Z",
    data: { impact: impact as unknown as Record<string, unknown> },
  };
}

function config(overrides: Partial<ChannelConfig> = {}): ChannelConfig {
  return {
    eventsUrl: "http://127.0.0.1:1731/events?source=hub",
    forwardTypes: new Set<string>(),
    ...overrides,
  };
}

describe("decideForward: impact_detected", () => {
  it("forwards an impact targeting the configured agent, with full meta", () => {
    const push = decideForward(
      impactEvent({ targetAgentId: "agent-a" }),
      config({ agentId: "agent-a" }),
    );
    expect(push).not.toBeNull();
    expect(push!.meta).toEqual({
      event_type: "impact_detected",
      workspace_id: "ws-1",
      impact_id: "imp-1",
      change_id: "chg-1",
      target_agent_id: "agent-a",
      target_problem_id: "prob-1",
      severity: "warning",
      timestamp: "2026-08-31T00:00:01.000Z",
    });
    expect(push!.content).toContain("chg-1");
    expect(push!.content).toContain("your declared work intent");
    expect(push!.content).toContain("scope src/dispatch ~ src/dispatch/queue.ts");
    expect(push!.content).toContain('acknowledgeImpact({ workspaceId: "ws-1", impactId: "imp-1"');
  });

  it("drops an impact targeting a different agent in targeted mode", () => {
    const push = decideForward(
      impactEvent({ targetAgentId: "agent-b" }),
      config({ agentId: "agent-a" }),
    );
    expect(push).toBeNull();
  });

  it("forwards every impact in observer mode, naming the target", () => {
    const push = decideForward(impactEvent({ targetAgentId: "agent-b" }), config());
    expect(push).not.toBeNull();
    expect(push!.content).toContain("agent agent-b's declared work intent");
  });

  it("collapses a same-source/target reason to a single mention", () => {
    const push = decideForward(
      impactEvent({
        matchingReasons: [
          { kind: "contractRef", source: "docs/contracts.md#queue", target: "docs/contracts.md#queue" },
        ],
      }),
      config(),
    );
    expect(push!.content).toContain("contractRef docs/contracts.md#queue.");
    expect(push!.content).not.toContain("~");
  });

  it("drops a malformed impact payload instead of throwing", () => {
    expect(decideForward(impactEvent({ impact: null }), config())).toBeNull();
    expect(decideForward(impactEvent({ impact: {} }), config())).toBeNull();
    expect(
      decideForward(impactEvent({ impact: { impactId: "imp-1" } }), config()),
    ).toBeNull();
  });

  it("tolerates malformed matchingReasons entries", () => {
    const push = decideForward(
      impactEvent({
        matchingReasons: ["nope", { kind: "scope" }, null, 7],
      }),
      config(),
    );
    expect(push).not.toBeNull();
    expect(push!.content).not.toContain("Overlap:");
  });
});

describe("decideForward: forward list", () => {
  const messageEvent: ThoughtboxEvent = {
    source: "hub",
    type: "message_posted",
    workspaceId: "ws-1",
    timestamp: "2026-08-31T00:00:02.000Z",
    data: { problemId: "prob-1", body: "heads up" },
  };

  it("drops event types outside the forward list", () => {
    expect(decideForward(messageEvent, config())).toBeNull();
  });

  it("forwards listed event types verbatim", () => {
    const push = decideForward(
      messageEvent,
      config({ forwardTypes: new Set(["message_posted"]) }),
    );
    expect(push).not.toBeNull();
    expect(push!.meta).toEqual({
      event_type: "message_posted",
      workspace_id: "ws-1",
      timestamp: "2026-08-31T00:00:02.000Z",
    });
    expect(JSON.parse(push!.content)).toEqual({ problemId: "prob-1", body: "heads up" });
  });
});

describe("parseHubEvent", () => {
  it("parses a well-formed envelope", () => {
    const event = parseHubEvent(
      JSON.stringify({
        source: "hub",
        type: "impact_detected",
        workspaceId: "ws-1",
        timestamp: "2026-08-31T00:00:00.000Z",
        data: { impact: {} },
      }),
    );
    expect(event).not.toBeNull();
    expect(event!.type).toBe("impact_detected");
  });

  it.each([
    ["not json", "{nope"],
    ["non-object", '"hello"'],
    ["missing type", '{"source":"hub","workspaceId":"w","timestamp":"t","data":{}}'],
    ["bad source", '{"source":"x","type":"t","workspaceId":"w","timestamp":"t","data":{}}'],
    ["missing data", '{"source":"hub","type":"t","workspaceId":"w","timestamp":"t"}'],
  ])("returns null for %s", (_label, payload) => {
    expect(parseHubEvent(payload)).toBeNull();
  });
});
