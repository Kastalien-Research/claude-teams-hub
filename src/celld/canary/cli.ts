#!/usr/bin/env node
/**
 * celld canary CLI (RFC 0001 §Verification gates).
 *
 * `pnpm canary:celld -- <setup|export|verify> --run-id <id> [--evidence-dir <path>]`
 *
 * npm and pnpm disagree about `--` in `<pm> run <script> -- <args>` (npm
 * swallows the separator; pnpm forwards it as argv[0] — see src/cli/args.ts
 * in the parent recruiter-sourcing repo for the probed cross-manager
 * behavior). One leading bare `--` is stripped here so the documented
 * invocation works under either package manager.
 */

import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { CanaryConfig } from './config.js';
import { runSetup } from './setup.js';
import { runExport } from './export.js';
import { runVerify } from './verify.js';

const SUBCOMMANDS = ['setup', 'export', 'verify'] as const;
type Subcommand = (typeof SUBCOMMANDS)[number];

function isSubcommand(value: string | undefined): value is Subcommand {
  return value !== undefined && (SUBCOMMANDS as readonly string[]).includes(value);
}

function normalizeArgv(argv: readonly string[]): readonly string[] {
  return argv[0] === '--' ? argv.slice(1) : argv;
}

interface ParsedArgs {
  subcommand: Subcommand;
  runId: string;
  evidenceDir?: string;
}

export function parseArgs(argv: readonly string[]): ParsedArgs {
  const [subcommand, ...rest] = argv;
  if (!isSubcommand(subcommand)) {
    throw new Error(`Unknown subcommand '${String(subcommand)}'. Expected one of: ${SUBCOMMANDS.join(', ')}.`);
  }
  let runId: string | undefined;
  let evidenceDir: string | undefined;
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (arg === '--run-id') {
      runId = rest[++i];
    } else if (arg === '--evidence-dir') {
      evidenceDir = rest[++i];
    } else {
      throw new Error(`Unknown argument '${String(arg)}'`);
    }
  }
  if (runId === undefined || runId.length === 0) {
    throw new Error('--run-id is required');
  }
  return evidenceDir === undefined ? { subcommand, runId } : { subcommand, runId, evidenceDir };
}

function envPort(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim().length === 0) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive number, got '${raw}'`);
  }
  return parsed;
}

export function buildConfig(runId: string, evidenceDirOverride: string | undefined): CanaryConfig {
  const repoRoot = process.cwd();
  const evidenceDir = evidenceDirOverride ?? join(repoRoot, '.tmp-hubdata', 'celld-canary', runId);
  return {
    runId,
    evidenceDir,
    repoRoot,
    composeProject: `celld-canary-${runId}`,
    hubPort: envPort('CANARY_HUB_PORT', 17321),
    celldAPort: envPort('CANARY_A_PORT', 18093),
    celldBPort: envPort('CANARY_B_PORT', 18094),
  };
}

async function main(): Promise<number> {
  const args = parseArgs(normalizeArgv(process.argv.slice(2)));
  const config = buildConfig(args.runId, args.evidenceDir);
  await mkdir(config.evidenceDir, { recursive: true });
  console.log(`[canary] subcommand=${args.subcommand} runId=${config.runId} evidenceDir=${config.evidenceDir}`);
  switch (args.subcommand) {
    case 'setup':
      return runSetup(config);
    case 'export':
      return runExport(config);
    case 'verify':
      return runVerify(config);
  }
}

main()
  .then(code => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    console.error(`[canary] fatal: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
    process.exitCode = 1;
  });

export type { CanaryConfig } from './config.js';
