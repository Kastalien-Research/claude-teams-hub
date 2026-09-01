/**
 * celld canary `export` (RFC 0001 §Verification gates).
 *
 * Reads the LIVE stack for one run and writes the evidence bundle `verify`
 * later checks offline. The snapshot/events endpoints are fetched directly
 * from a celld node's host port (not through the hub) because `verify` must
 * be able to recompute the replay invariant independently of the hub's own
 * read path.
 */

import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { compose, dumpLogs, httpOk, type StackConfig } from '../integration/stack.js';
import { COMMAND_SCHEMA_VERSION } from '../contracts.js';
import { findLeakedCredential, writeManifest, type ManifestMeta } from './verify.js';
import type { CanaryConfig } from './config.js';

const execFileAsync = promisify(execFile);

interface SetupRecord {
  workspaceId: string;
  celldImage: string;
  imageDigests: string | null;
  ports: { hub: number; celldA: number; celldB: number };
}

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

/** Tries each base in order; only a transport failure (fetch throwing) falls over to the next. */
async function fetchJson(bases: readonly string[], path: string): Promise<unknown> {
  let lastError: unknown;
  for (const base of bases) {
    let response: Response;
    try {
      response = await fetch(`${base}${path}`, { signal: AbortSignal.timeout(10_000) });
    } catch (error) {
      lastError = error;
      continue;
    }
    if (!response.ok) {
      throw new Error(`${base}${path} responded ${response.status}`);
    }
    return await response.json();
  }
  throw new Error(`All endpoints failed for ${path}: ${String(lastError)}`);
}

async function fetchAllEvents(bases: readonly string[], workspaceId: string): Promise<unknown[]> {
  const events: unknown[] = [];
  let after = 0;
  const limit = 200;
  for (;;) {
    const page = (await fetchJson(
      bases,
      `/v1/workspaces/${encodeURIComponent(workspaceId)}/events?after=${after}&limit=${limit}`,
    )) as { events: Array<{ sequence: number }> };
    if (page.events.length === 0) break;
    events.push(...page.events);
    after = (page.events[page.events.length - 1] as { sequence: number }).sequence;
  }
  return events;
}

async function writeStubIfAbsent(dir: string, name: string): Promise<void> {
  const path = join(dir, name);
  if (existsSync(path)) {
    console.log(`[export] ${name} already present, left untouched`);
    return;
  }
  await writeFile(path, JSON.stringify({ missing: true }, null, 2));
  console.log(`[export] wrote stub ${name}`);
}

export async function runExport(config: CanaryConfig): Promise<number> {
  const stackConfig = toStackConfig(config);
  try {
    const setup = JSON.parse(await readFile(join(config.evidenceDir, 'setup.json'), 'utf8')) as SetupRecord;
    const bases = [`http://localhost:${setup.ports.celldA}`, `http://localhost:${setup.ports.celldB}`];

    const snapshot = await fetchJson(bases, `/v1/workspaces/${encodeURIComponent(setup.workspaceId)}/snapshot`);
    await writeFile(join(config.evidenceDir, 'workspace-snapshot.json'), JSON.stringify(snapshot, null, 2));
    console.log('[export] wrote workspace-snapshot.json');

    const events = await fetchAllEvents(bases, setup.workspaceId);
    const ndjson = events.map(event => JSON.stringify(event)).join('\n') + (events.length > 0 ? '\n' : '');
    await writeFile(join(config.evidenceDir, 'events.ndjson'), ndjson);
    console.log(`[export] wrote events.ndjson: count=${events.length}`);

    await writeStubIfAbsent(config.evidenceDir, 'native-observations.json');
    await writeStubIfAbsent(config.evidenceDir, 'automated.json');

    const { stdout: composePs } = await compose(stackConfig, setup.celldImage, ['ps', '--all']);
    const health = {
      celldA: await httpOk(`http://localhost:${setup.ports.celldA}/health`),
      celldB: await httpOk(`http://localhost:${setup.ports.celldB}/health`),
      hub: await httpOk(`http://localhost:${setup.ports.hub}/health`),
    };
    await writeFile(
      join(config.evidenceDir, 'services.json'),
      JSON.stringify({ capturedAt: new Date().toISOString(), composePs, health }, null, 2),
    );
    console.log(`[export] wrote services.json: health=${JSON.stringify(health)}`);

    await dumpLogs(stackConfig, setup.celldImage, 'export');
    console.log('[export] dumped compose logs (tag=export)');

    const leak = await findLeakedCredential(config.evidenceDir);
    if (leak !== undefined) {
      console.error(`[export] credential deny-list tripped: file=${leak.file} matched='${leak.matched}'`);
      return 1;
    }
    console.log('[export] credential deny-list scan clean');

    const { stdout: gitShaRaw } = await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: config.repoRoot });
    const meta: ManifestMeta = {
      runId: config.runId,
      teamHubGitSha: gitShaRaw.trim(),
      celldImage: setup.celldImage,
      imageDigests: setup.imageDigests ?? undefined,
      protocolVersion: COMMAND_SCHEMA_VERSION,
      routeAuthority: 'workspace-backends.json',
      generatedAt: new Date().toISOString(),
    };
    await writeManifest(config.evidenceDir, meta);
    console.log('[export] wrote manifest.sha256');

    return 0;
  } catch (error) {
    console.error(`[export] failed: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}
