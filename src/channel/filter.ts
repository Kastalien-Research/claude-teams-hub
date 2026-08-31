import type { ThoughtboxEvent } from "../events/types.js";
import type { ChannelConfig, ChannelPush } from "./types.js";

/**
 * Parse one SSE `data` payload into a ThoughtboxEvent, or null if it does not
 * carry the expected envelope. The stream is same-machine and hub-authored,
 * but a malformed frame must degrade to "dropped", never to a crash.
 */
export function parseHubEvent(data: string): ThoughtboxEvent | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch {
    return null;
  }
  const record = asRecord(parsed);
  if (record === null) return null;
  const source = asString(record.source);
  const type = asString(record.type);
  const workspaceId = asString(record.workspaceId);
  const timestamp = asString(record.timestamp);
  const eventData = asRecord(record.data);
  if (
    (source !== "hub" && source !== "thought") ||
    type === null ||
    workspaceId === null ||
    timestamp === null ||
    eventData === null
  ) {
    return null;
  }
  return {
    source,
    type: type as ThoughtboxEvent["type"],
    workspaceId,
    timestamp,
    data: eventData,
  };
}

/**
 * Decide whether one hub event reaches the session, and shape the push.
 *
 * Pure: no clock, no I/O. Returns null for events the session should not see.
 * Malformed payloads (an `impact_detected` without a usable impact record)
 * are dropped rather than forwarded half-parsed — the poll surface
 * (`tb.hub.listImpacts`) remains the authoritative backstop.
 */
export function decideForward(
  event: ThoughtboxEvent,
  config: ChannelConfig,
): ChannelPush | null {
  if (event.type === "impact_detected") {
    return decideImpact(event, config);
  }
  if (config.forwardTypes.has(event.type)) {
    return {
      content: JSON.stringify(event.data),
      meta: {
        event_type: event.type,
        workspace_id: event.workspaceId,
        timestamp: event.timestamp,
      },
    };
  }
  return null;
}

interface MatchingReason {
  kind: string;
  source: string;
  target: string;
}

function decideImpact(
  event: ThoughtboxEvent,
  config: ChannelConfig,
): ChannelPush | null {
  const impact = asRecord(event.data.impact);
  if (impact === null) return null;

  const impactId = asString(impact.impactId);
  const changeId = asString(impact.changeId);
  const targetAgentId = asString(impact.targetAgentId);
  if (impactId === null || changeId === null || targetAgentId === null) {
    return null;
  }
  if (config.agentId !== undefined && targetAgentId !== config.agentId) {
    return null;
  }

  const severity = asString(impact.severity) ?? "unknown";
  const reasons = describeReasons(impact.matchingReasons);
  const targetLine =
    config.agentId !== undefined
      ? "your declared work intent"
      : `agent ${targetAgentId}'s declared work intent`;

  const content = [
    `Work-change impact: change ${changeId} overlaps ${targetLine} (severity: ${severity}).`,
    reasons.length > 0 ? `Overlap: ${reasons.join("; ")}.` : undefined,
    `Review before continuing in the overlapping scope, then acknowledge via the team-hub MCP: ` +
      `tb.hub.acknowledgeImpact({ workspaceId: "${event.workspaceId}", impactId: "${impactId}", ` +
      `disposition: "accepted" | "not_applicable", agentId: <your agentId> }).`,
  ]
    .filter((line): line is string => line !== undefined)
    .join("\n");

  const meta: Record<string, string> = {
    event_type: event.type,
    workspace_id: event.workspaceId,
    impact_id: impactId,
    change_id: changeId,
    target_agent_id: targetAgentId,
    severity,
    timestamp: event.timestamp,
  };
  const problemId = asString(impact.targetProblemId);
  if (problemId !== null) meta.target_problem_id = problemId;
  return { content, meta };
}

function describeReasons(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const described: string[] = [];
  for (const entry of value) {
    const reason = asRecord(entry);
    if (reason === null) continue;
    const kind = asString(reason.kind);
    const source = asString(reason.source);
    const target = asString(reason.target);
    if (kind === null || source === null || target === null) continue;
    described.push(
      source === target ? `${kind} ${source}` : `${kind} ${source} ~ ${target}`,
    );
  }
  return described;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return null;
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}
