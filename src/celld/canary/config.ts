/**
 * Shared canary run configuration. Leaf module — cli.ts and the three
 * subcommand modules all import from here, so the CLI can import the
 * subcommands without a cycle.
 */

export interface CanaryConfig {
  runId: string;
  evidenceDir: string;
  repoRoot: string;
  composeProject: string;
  hubPort: number;
  celldAPort: number;
  celldBPort: number;
}
