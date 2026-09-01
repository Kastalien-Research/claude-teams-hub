/**
 * celld canary `setup` (RFC 0001 §Verification gates).
 *
 * Brings up the disposable canary stack and seeds the canary world entirely
 * through MCP. Refuses to seed if the celld-backed workspace authority
 * marker (`coordination.backend === 'celld'`, `mainSessionId ===
 * 'celld:<workspaceId>'`, absence from filesystem storage) does not hold —
 * seeding on top of a broken authority would produce evidence that looks
 * valid while proving nothing.
 */

import { execFile } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { McpSession } from '../integration/mcp-client.js';
import { compose, dumpLogs, httpOk, pollUntil, resolveCelldImage, stageEsbuild, type StackConfig } from '../integration/stack.js';
import type { CanaryConfig } from './config.js';

const execFileAsync = promisify(execFile);

function toStackConfig(config: CanaryConfig): StackConfig {
  return {
    projectName: config.composeProject,
    hubPort: config.hubPort,
    celldAPort: config.celldAPort,
    celldBPort: config.celldBPort,
    repoRoot: config.repoRoot,
    evidenceDir: config.evidenceDir,
  };
}

function hubUrl(config: CanaryConfig): string {
  return `http://localhost:${config.hubPort}`;
}

function teardownCommand(config: CanaryConfig): string {
  return `docker compose -f docker-compose.celld.yml -p ${config.composeProject} down -v`;
}

async function resolveImageDigest(image: string): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync('docker', [
      'image',
      'inspect',
      image,
      '--format',
      '{{index .RepoDigests 0}}',
    ]);
    const digest = stdout.trim();
    return digest.length > 0 ? digest : undefined;
  } catch {
    return undefined;
  }
}

interface ProblemSpec {
  key: 'coordination' | 'contention' | 'schemaOwner' | 'apiConsumer';
  commandLabel: 'p-coord' | 'p-contention' | 'p-schema' | 'p-consumer';
  title: string;
  description: string;
}

const PROBLEM_SPECS: readonly ProblemSpec[] = [
  {
    key: 'coordination',
    commandLabel: 'p-coord',
    title: 'coordination channel',
    description: 'canary coordination problem; its channel is the coordination channel',
  },
  {
    key: 'contention',
    commandLabel: 'p-contention',
    title: 'contention problem',
    description: 'the native contention problem both agents race to claim',
  },
  {
    key: 'schemaOwner',
    commandLabel: 'p-schema',
    title: 'schema-owner problem',
    description: 'canary schema-owner problem',
  },
  {
    key: 'apiConsumer',
    commandLabel: 'p-consumer',
    title: 'api-consumer problem',
    description: 'canary api-consumer problem',
  },
];

export async function runSetup(config: CanaryConfig): Promise<number> {
  const stackConfig = toStackConfig(config);
  let celldImage: string | undefined;

  try {
    console.log(`[setup] runId=${config.runId} composeProject=${config.composeProject}`);

    await stageEsbuild(config.repoRoot);
    console.log('[setup] staged esbuild');

    celldImage = await resolveCelldImage(config.repoRoot);
    console.log(`[setup] resolved celld image: ${celldImage}`);

    await compose(stackConfig, celldImage, ['up', '-d', '--build']);
    console.log(`[setup] compose up -d --build: project=${config.composeProject}`);

    // ---------------------------------------------------------------------
    // VERIFY-BEFORE-SEED
    // ---------------------------------------------------------------------
    await pollUntil('celld-a /health', 120_000, 1_000, () => httpOk(`http://localhost:${config.celldAPort}/health`));
    console.log('[setup] celld-a /health ok');
    await pollUntil('celld-b /health', 120_000, 1_000, () => httpOk(`http://localhost:${config.celldBPort}/health`));
    console.log('[setup] celld-b /health ok');
    await pollUntil('hub /health', 120_000, 1_000, () => httpOk(`${hubUrl(config)}/health`));
    console.log('[setup] hub /health ok');

    const leader = new McpSession(hubUrl(config));
    await leader.initialize('celld-canary-setup');
    console.log('[setup] MCP initialize ok');

    const probeAgentId = (
      (await leader.hub('register', { name: `canary-${config.runId}-probe` })) as { agentId: string }
    ).agentId;
    console.log(`[setup] probe agent registered: agentId=${probeAgentId}`);

    const probeResult = (await leader.hub('createWorkspace', {
      agentId: probeAgentId,
      name: `celld-canary-probe-${config.runId}`,
      description: 'canary verify-before-seed probe workspace',
      backend: 'celld',
      command: { id: `canary-${config.runId}-probe-ws` },
    })) as { workspaceId: string; mainSessionId: string; coordination: { backend: string } };

    if (probeResult.coordination.backend !== 'celld') {
      throw new Error(
        `probe workspace coordination.backend was '${probeResult.coordination.backend}', expected 'celld'`,
      );
    }
    if (probeResult.mainSessionId !== `celld:${probeResult.workspaceId}`) {
      throw new Error(
        `probe workspace mainSessionId was '${probeResult.mainSessionId}', expected 'celld:${probeResult.workspaceId}'`,
      );
    }
    console.log(
      `[setup] probe authority marker ok: workspaceId=${probeResult.workspaceId} ` +
        `mainSessionId=${probeResult.mainSessionId} coordination.backend=${probeResult.coordination.backend}`,
    );

    // A missing workspaces dir is the strongest form of absence: no
    // filesystem workspace was ever created in this fresh stack.
    const { stdout: fsListing } = await compose(stackConfig, celldImage, [
      'exec',
      '-T',
      'team-hub',
      'sh',
      '-c',
      'ls /data/hub/workspaces 2>/dev/null || true',
    ]);
    if (fsListing.includes(probeResult.workspaceId)) {
      throw new Error(`probe workspaceId ${probeResult.workspaceId} unexpectedly present in filesystem storage`);
    }
    console.log('[setup] probe workspaceId confirmed absent from filesystem storage');

    // ---------------------------------------------------------------------
    // Seed
    // ---------------------------------------------------------------------
    const alphaName = `claim-alpha-${config.runId}`;
    const betaName = `claim-beta-${config.runId}`;
    const alphaAgentId = ((await leader.hub('register', { name: alphaName })) as { agentId: string }).agentId;
    const betaAgentId = ((await leader.hub('register', { name: betaName })) as { agentId: string }).agentId;
    console.log(`[setup] registered agents: alpha=${alphaAgentId} beta=${betaAgentId}`);

    const workspaceCommandId = `canary-${config.runId}-ws`;
    const workspace = (await leader.hub('createWorkspace', {
      agentId: alphaAgentId,
      name: `celld-canary-${config.runId}`,
      description: 'celld canary seeded workspace',
      backend: 'celld',
      command: { id: workspaceCommandId },
    })) as { workspaceId: string };
    const workspaceId = workspace.workspaceId;
    console.log(`[setup] created workspace: workspaceId=${workspaceId} commandId=${workspaceCommandId}`);

    const joinCommandId = `canary-${config.runId}-join-beta`;
    await leader.hub('joinWorkspace', { agentId: betaAgentId, workspaceId, command: { id: joinCommandId } });
    console.log(`[setup] joined beta to workspace: workspaceId=${workspaceId} commandId=${joinCommandId}`);

    const problems: Record<string, string> = {};
    const commandIds: Record<string, string> = {
      probeWorkspace: `canary-${config.runId}-probe-ws`,
      workspace: workspaceCommandId,
      joinBeta: joinCommandId,
    };
    for (const spec of PROBLEM_SPECS) {
      const commandId = `canary-${config.runId}-${spec.commandLabel}`;
      const created = (await leader.hub('createProblem', {
        agentId: alphaAgentId,
        workspaceId,
        title: spec.title,
        description: spec.description,
        command: { id: commandId },
      })) as { problem: { id: string } };
      problems[spec.key] = created.problem.id;
      commandIds[spec.key] = commandId;
      console.log(`[setup] created problem ${spec.key}: problemId=${created.problem.id} commandId=${commandId}`);
    }

    const imageDigest = await resolveImageDigest(celldImage);

    const setupRecord = {
      runId: config.runId,
      generatedAt: new Date().toISOString(),
      hubUrl: hubUrl(config),
      composeProject: config.composeProject,
      celldImage,
      imageDigests: imageDigest ?? null,
      workspaceId,
      agents: {
        alpha: { agentId: alphaAgentId, name: alphaName },
        beta: { agentId: betaAgentId, name: betaName },
      },
      problems,
      commandIds,
      ports: { hub: config.hubPort, celldA: config.celldAPort, celldB: config.celldBPort },
    };
    const setupPath = join(config.evidenceDir, 'setup.json');
    await writeFile(setupPath, JSON.stringify(setupRecord, null, 2));
    console.log(`[setup] wrote ${setupPath}`);

    console.log('[setup] summary');
    console.log(`[setup]   hubUrl=${hubUrl(config)}`);
    console.log(`[setup]   workspaceId=${workspaceId}`);
    console.log(`[setup]   teardown=${teardownCommand(config)}`);
    return 0;
  } catch (error) {
    console.error(`[setup] failed: ${error instanceof Error ? error.message : String(error)}`);
    await dumpLogs(stackConfig, celldImage ?? '', 'setup-failure');
    console.error(`[setup] stack left up; teardown with: ${teardownCommand(config)}`);
    return 1;
  }
}
