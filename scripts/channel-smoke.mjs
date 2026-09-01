#!/usr/bin/env node
// Smoke test for the team-hub channel: fake hub SSE server -> channel over
// real stdio MCP. Prints raw check results; it computes no verdict.
//
//   node scripts/channel-smoke.mjs
//
// Asserts observably: the initialize response carries the claude/channel
// capability + instructions, a targeted impact_detected SSE event surfaces as
// notifications/claude/channel, and an off-target impact does not.
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

const impact = (id, target) => ({
  source: "hub",
  type: "impact_detected",
  workspaceId: "ws-smoke",
  timestamp: new Date().toISOString(),
  data: {
    impact: {
      impactId: id,
      changeId: "chg-9",
      targetAgentId: target,
      targetProblemId: "prob-9",
      severity: "warning",
      status: "pending",
      matchingReasons: [
        { kind: "scope", source: "src/dispatch", target: "src/dispatch/queue.ts" },
      ],
      detectedAt: new Date().toISOString(),
    },
  },
});

let sseRes = null;
const server = createServer((req, res) => {
  if (!req.url.startsWith("/events")) {
    res.writeHead(404).end();
    return;
  }
  res.writeHead(200, { "Content-Type": "text/event-stream" });
  res.write(": connected\n\n");
  sseRes = res;
  setTimeout(() => {
    res.write(`data: ${JSON.stringify(impact("imp-hit", "agent-smoke"))}\n\n`);
    res.write(`data: ${JSON.stringify(impact("imp-miss", "agent-other"))}\n\n`);
  }, 300);
});

await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const port = server.address().port;

const child = spawn("npx", ["tsx", "src/channel/index.ts"], {
  cwd: repoRoot,
  env: {
    ...process.env,
    HUB_EVENTS_URL: `http://127.0.0.1:${port}/events`,
    HUB_CHANNEL_AGENT_ID: "agent-smoke",
    HUB_CHANNEL_WORKSPACE_ID: "ws-smoke",
  },
  stdio: ["pipe", "pipe", "pipe"],
});
child.stderr.on("data", (data) => process.stderr.write(`[child] ${data}`));

let out = "";
const received = [];
child.stdout.on("data", (data) => {
  out += data.toString();
  let index;
  while ((index = out.indexOf("\n")) !== -1) {
    const line = out.slice(0, index);
    out = out.slice(index + 1);
    if (line.trim()) received.push(JSON.parse(line));
  }
});

const send = (msg) => child.stdin.write(`${JSON.stringify(msg)}\n`);
send({
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "smoke", version: "0" },
  },
});
send({ jsonrpc: "2.0", method: "notifications/initialized" });

await new Promise((resolve) => setTimeout(resolve, 2500));

const init = received.find((msg) => msg.id === 1);
const notifications = received.filter(
  (msg) => msg.method === "notifications/claude/channel",
);

const checks = {
  init_has_channel_capability:
    init?.result?.capabilities?.experimental?.["claude/channel"] !== undefined,
  init_instructions_mention_impacts:
    typeof init?.result?.instructions === "string" &&
    init.result.instructions.includes("impact_detected"),
  notification_count: notifications.length,
  forwarded_impact_id: notifications[0]?.params?.meta?.impact_id ?? null,
  off_target_forwarded: notifications.some(
    (n) => n.params?.meta?.impact_id === "imp-miss",
  ),
};
console.log(JSON.stringify(checks, null, 2));
console.log("--- forwarded content ---");
console.log(notifications[0]?.params?.content ?? "(none)");

child.kill();
sseRes?.end();
server.close();
