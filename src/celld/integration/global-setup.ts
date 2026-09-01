/**
 * vitest globalSetup for the celld integration tier (Docker required).
 *
 * Brings up a UNIQUE compose project (fresh volumes — never the standing
 * team-hub volume), health-gates the hub and both celld nodes plus a real
 * MCP initialize, and exposes the config to tests via environment variables.
 * Teardown dumps logs to the evidence dir FIRST, then removes the project
 * and its volumes unless KEEP_CELLD_STACK=1.
 */

import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { McpSession } from './mcp-client.js';
import {
  compose,
  dumpLogs,
  httpOk,
  pollUntil,
  resolveCelldImage,
  stageEsbuild,
  type StackConfig,
} from './stack.js';

export default async function globalSetup(): Promise<() => Promise<void>> {
  const repoRoot = process.cwd();
  const runId = process.env.CELLD_IT_RUN_ID ?? randomUUID().slice(0, 8);
  const config: StackConfig = {
    projectName: `celld-it-${runId}`,
    hubPort: parseInt(process.env.CELLD_IT_HUB_PORT ?? '17311', 10),
    celldAPort: parseInt(process.env.CELLD_IT_A_PORT ?? '18091', 10),
    celldBPort: parseInt(process.env.CELLD_IT_B_PORT ?? '18092', 10),
    repoRoot,
    evidenceDir: process.env.CELLD_IT_EVIDENCE_DIR ?? join(repoRoot, '.tmp-hubdata', 'celld-it', runId),
  };

  await stageEsbuild(repoRoot);
  const celldImage = await resolveCelldImage(repoRoot);

  console.error(`[celld-it] project ${config.projectName} (image ${celldImage})`);
  await compose(config, celldImage, ['up', '-d', '--build'], 600_000);

  await pollUntil('celld-a /health', 60_000, 1_000, () => httpOk(`http://localhost:${config.celldAPort}/health`));
  await pollUntil('celld-b /health', 60_000, 1_000, () => httpOk(`http://localhost:${config.celldBPort}/health`));
  await pollUntil('team-hub /health', 60_000, 1_000, () => httpOk(`http://localhost:${config.hubPort}/health`));
  await pollUntil('MCP initialize', 60_000, 2_000, async () => {
    const session = new McpSession(`http://localhost:${config.hubPort}`);
    await session.initialize('celld-it-healthcheck');
    return true;
  });

  process.env.CELLD_IT_PROJECT = config.projectName;
  process.env.CELLD_IT_HUB_URL = `http://localhost:${config.hubPort}`;
  process.env.CELLD_IT_A_PORT = String(config.celldAPort);
  process.env.CELLD_IT_B_PORT = String(config.celldBPort);
  process.env.CELLD_IT_EVIDENCE_DIR = config.evidenceDir;
  process.env.CELLD_IT_IMAGE = celldImage;

  return async () => {
    await dumpLogs(config, celldImage, 'teardown');
    if (process.env.KEEP_CELLD_STACK === '1') {
      console.error(`[celld-it] KEEP_CELLD_STACK=1 — stack left up. Teardown: docker compose -f docker-compose.celld.yml -p ${config.projectName} down -v`);
      return;
    }
    await compose(config, celldImage, ['down', '-v']);
  };
}
