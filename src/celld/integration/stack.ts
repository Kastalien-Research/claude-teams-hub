/**
 * Compose-stack control for the celld integration tier. One unique compose
 * project per run, isolated volumes, poll-with-deadline everywhere (no fixed
 * sleeps), logs dumped BEFORE any teardown.
 */

import { execFile } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export interface StackConfig {
  projectName: string;
  hubPort: number;
  celldAPort: number;
  celldBPort: number;
  repoRoot: string;
  evidenceDir: string;
}

export function stackEnv(config: StackConfig, celldImage: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    CELLD_IMAGE: celldImage,
    HUB_PORT: String(config.hubPort),
    CELLD_A_PORT: String(config.celldAPort),
    CELLD_B_PORT: String(config.celldBPort),
  };
}

export async function resolveCelldImage(repoRoot: string): Promise<string> {
  const { stdout } = await execFileAsync(join(repoRoot, 'scripts/celld-image.sh'));
  return stdout.trim();
}

export async function stageEsbuild(repoRoot: string): Promise<void> {
  await execFileAsync(join(repoRoot, 'scripts/stage-esbuild.sh'));
}

export async function compose(
  config: StackConfig,
  celldImage: string,
  args: string[],
  timeoutMs = 300_000,
): Promise<{ stdout: string; stderr: string }> {
  return execFileAsync(
    'docker',
    ['compose', '-f', 'docker-compose.celld.yml', '-p', config.projectName, ...args],
    { cwd: config.repoRoot, env: stackEnv(config, celldImage), timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024 },
  );
}

export async function pollUntil(
  label: string,
  deadlineMs: number,
  intervalMs: number,
  probe: () => Promise<boolean>,
): Promise<void> {
  const deadline = Date.now() + deadlineMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      if (await probe()) return;
    } catch (error) {
      lastError = error;
    }
    await new Promise(resolve => setTimeout(resolve, intervalMs));
  }
  throw new Error(`Deadline (${deadlineMs}ms) waiting for ${label}: ${String(lastError ?? 'probe returned false')}`);
}

export async function httpOk(url: string, timeoutMs = 3_000): Promise<boolean> {
  const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  return response.ok;
}

/** Dump service logs + ps into the evidence dir. Never throws. */
export async function dumpLogs(config: StackConfig, celldImage: string, tag: string): Promise<void> {
  try {
    mkdirSync(config.evidenceDir, { recursive: true });
    const logs = await compose(config, celldImage, ['logs', '--no-color']);
    writeFileSync(join(config.evidenceDir, `compose-logs-${tag}.txt`), logs.stdout + logs.stderr);
    const ps = await compose(config, celldImage, ['ps', '--all']);
    writeFileSync(join(config.evidenceDir, `compose-ps-${tag}.txt`), ps.stdout);
  } catch (error) {
    console.error(`[stack] log dump failed (${tag}):`, error);
  }
}
