#!/usr/bin/env node
/**
 * teammate-launch — give a teammate Claude Code session its OWN durable
 * team-hub identity and its OWN channel (one command, idempotent).
 *
 *   node team-hub/scripts/teammate-launch.mjs <name> [--workspace <id>] [--cwd <dir>]
 *                                                     [--hub <url>] [--team-run <id>]
 *                                                     [--inherit-mcp] [--print-only]
 *
 * Run it from the CONSUMER repo (the project whose sessions the teammate will
 * join). Steps, all idempotent:
 *   1. Identity — reuses `<consumer>/.claude/state/teammates/<name>.json` if
 *      present, otherwise registers `teammate-<name>` on the hub ONCE and
 *      records the agentId. Re-registering mints a stranger; the file IS the
 *      identity. The consumer root is the main checkout (git-common-dir), so
 *      every worktree of the consumer shares one identity set.
 *   2. Verifies the identity resolves on the target hub (whoami) — a miss is
 *      usually the wrong hub/data dir, not lost state.
 *   3. --workspace: joins that workspace (tolerates already-a-member) and
 *      filters the channel to it.
 *   4. Writes `<name>.mcp.json` beside the identity: the hub MCP server plus a
 *      team-hub-channel entry whose env carries THIS teammate's agentId. The
 *      channel binary is this repo's own `dist/channel/index.js` (resolved
 *      from this script's location — build it with `pnpm build:local`).
 *   5. Prints the launch line and the identity block to paste into the brief.
 *
 * Probe-verified 2026-09-01 (Claude Code 2.1.257): `--mcp-config <file>
 * --strict-mcp-config --dangerously-load-development-channels
 * server:team-hub-channel` spawns the channel with the per-file env; channel
 * entries MUST be tagged `server:<name>`.
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_HUB = "http://localhost:1731";
const HERE = dirname(fileURLToPath(import.meta.url));

function usage(exitCode) {
  const text = `usage: node team-hub/scripts/teammate-launch.mjs <name> [options]
  --workspace <id>   join this workspace as the teammate; filter its channel to it
  --cwd <dir>        directory the printed launch line cd's into (default: cwd)
  --hub <url>        hub base URL (default ${DEFAULT_HUB})
  --team-run <id>    teamRunId for celld command metadata (default: teammate-<name>-<date>)
  --inherit-mcp      omit --strict-mcp-config so the consumer's .mcp.json servers also load
  --print-only       no hub calls; rewrite config from the recorded identity
`;
  (exitCode === 0 ? console.log : console.error)(text);
  process.exit(exitCode);
}

function parseArgs(argv) {
  const args = { name: undefined, workspace: undefined, cwd: process.cwd(), hub: DEFAULT_HUB,
    teamRun: undefined, inheritMcp: false, printOnly: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => { i++; if (i >= argv.length) usage(2); return argv[i]; };
    if (a === "--help" || a === "-h") usage(0);
    else if (a === "--workspace") args.workspace = next();
    else if (a === "--cwd") args.cwd = resolve(next());
    else if (a === "--hub") args.hub = next().replace(/\/+$/, "");
    else if (a === "--team-run") args.teamRun = next();
    else if (a === "--inherit-mcp") args.inheritMcp = true;
    else if (a === "--print-only") args.printOnly = true;
    else if (a.startsWith("--")) usage(2);
    else if (args.name === undefined) args.name = a;
    else usage(2);
  }
  if (args.name === undefined || !/^[a-z0-9][a-z0-9-]{0,40}$/.test(args.name)) {
    console.error("name must match /^[a-z0-9][a-z0-9-]{0,40}$/");
    usage(2);
  }
  args.teamRun ??= `teammate-${args.name}-${new Date().toISOString().slice(0, 10)}`;
  return args;
}

/**
 * Consumer repo root: the MAIN checkout even when run from a linked worktree
 * (worktrees share one git-common-dir under it). Falls back to cwd outside git.
 */
function consumerRoot() {
  try {
    const common = execFileSync("git", ["rev-parse", "--git-common-dir"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    return dirname(resolve(common));
  } catch {
    return process.cwd();
  }
}

async function hub(base, body) {
  const res = await fetch(`${base}/hub/api`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({ error: `non-JSON response (${res.status})` }));
  if (!res.ok) {
    const err = new Error(json.error ?? `hub ${res.status}`);
    err.code = json.code;
    err.status = res.status;
    throw err;
  }
  return json;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const channelBin = resolve(HERE, "../dist/channel/index.js");
  if (!existsSync(channelBin)) {
    console.error(`channel binary missing: ${channelBin}\n  build it: (cd ${resolve(HERE, "..")} && pnpm build:local)`);
    process.exit(1);
  }

  const stateDir = resolve(consumerRoot(), ".claude/state/teammates");
  mkdirSync(stateDir, { recursive: true });
  const identityPath = resolve(stateDir, `${args.name}.json`);
  const configPath = resolve(stateDir, `${args.name}.mcp.json`);

  let identity = existsSync(identityPath) ? JSON.parse(readFileSync(identityPath, "utf8")) : undefined;

  if (!args.printOnly) {
    if (identity === undefined) {
      const reg = await hub(args.hub, { operation: "register", name: `teammate-${args.name}`, role: "contributor" });
      identity = { name: args.name, agentId: reg.agentId, hubName: reg.name, hub: args.hub,
        registeredAt: new Date().toISOString() };
      writeFileSync(identityPath, `${JSON.stringify(identity, null, 2)}\n`);
      console.log(`registered ${identity.hubName} -> ${identity.agentId}`);
    } else {
      console.log(`reusing identity ${identity.agentId} (${identityPath})`);
    }

    const who = await hub(args.hub, { operation: "whoami", agentId: identity.agentId })
      .catch((e) => ({ error: e.message }));
    if (who.error !== undefined || who.agentId !== identity.agentId) {
      console.error(`identity ${identity.agentId} does not resolve on ${args.hub}: ${who.error ?? "mismatch"}\n` +
        "  This is usually the WRONG HUB or data dir, not lost state — check docker ps / --hub before re-minting.");
      process.exit(1);
    }

    if (args.workspace !== undefined) {
      try {
        await hub(args.hub, { operation: "join_workspace", agentId: identity.agentId, workspaceId: args.workspace,
          command: { id: `cmd-join-${args.name}-${Date.now()}`, teamRunId: args.teamRun } });
        console.log(`joined workspace ${args.workspace}`);
      } catch (e) {
        if (/already/i.test(e.message)) console.log(`already a member of ${args.workspace}`);
        else throw e;
      }
    }
  } else if (identity === undefined) {
    console.error(`--print-only but no identity recorded at ${identityPath}`);
    process.exit(1);
  }

  const env = { HUB_EVENTS_URL: `${args.hub}/events`, HUB_CHANNEL_AGENT_ID: identity.agentId };
  if (args.workspace !== undefined) env.HUB_CHANNEL_WORKSPACE_ID = args.workspace;
  const config = {
    mcpServers: {
      "team-hub": { type: "http", url: `${args.hub}/mcp` },
      "team-hub-channel": { type: "stdio", command: "node", args: [channelBin], env },
    },
  };
  writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);

  const strict = args.inheritMcp ? "" : " --strict-mcp-config";
  console.log(`\nconfig: ${configPath}`);
  console.log(`\nlaunch:\n  cd ${args.cwd} && claude --mcp-config ${configPath}${strict} --dangerously-load-development-channels server:team-hub-channel`);
  console.log(`\nidentity block for the brief:\n  agentId: ${identity.agentId}\n  hub: ${args.hub}` +
    (args.workspace !== undefined ? `\n  workspaceId: ${args.workspace}` : "") +
    `\n  teamRunId: ${args.teamRun}\n  (pass agentId on every hub call; never register — this identity is durable)`);
}

main().catch((e) => {
  console.error(`teammate-launch: ${e.message}`);
  process.exit(1);
});
