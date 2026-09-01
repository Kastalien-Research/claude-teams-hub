/**
 * celld canary `verify` (RFC 0001 §Verification gates).
 *
 * Pure deterministic checker: no network, no Docker. Recomputes everything
 * from the evidence bundle on disk and reports computed-vs-expected pairs —
 * never a bare boolean a producing agent could have asserted
 * (.claude/rules/no-self-graded-verification.md). `export.ts` also imports
 * the credential-scan and manifest-writer helpers from here, since they are
 * pure/deterministic operations too, not stack-dependent gathering.
 */

import { createHash } from 'node:crypto';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { hubEventV1Schema, type HubEventV1 } from '../contracts.js';
import { apply } from '../domain/reducer.js';
import type { CellWorkspaceState } from '../domain/state.js';
import type { CanaryConfig } from './config.js';

// =============================================================================
// Generic JSON deep-equal + first-divergence path
// =============================================================================

export function deepEqualJson(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (a === null || b === null) return a === b;
  if (typeof a !== 'object' || typeof b !== 'object') return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    return a.every((v, i) => deepEqualJson(v, b[i]));
  }
  const ao = a as Record<string, unknown>;
  const bo = b as Record<string, unknown>;
  const keysA = Object.keys(ao);
  const keysB = Object.keys(bo);
  if (keysA.length !== keysB.length) return false;
  return keysA.every(k => Object.prototype.hasOwnProperty.call(bo, k) && deepEqualJson(ao[k], bo[k]));
}

/** Walks two JSON values to the deepest key path where they first diverge. */
export function firstDivergence(a: unknown, b: unknown, path = ''): string {
  if (
    typeof a !== 'object' ||
    a === null ||
    typeof b !== 'object' ||
    b === null ||
    Array.isArray(a) !== Array.isArray(b)
  ) {
    return path.length === 0 ? '(root)' : path;
  }
  const keysA = Object.keys(a as Record<string, unknown>);
  const keysB = Object.keys(b as Record<string, unknown>);
  const keys = [...new Set([...keysA, ...keysB])].sort();
  for (const key of keys) {
    const av = (a as Record<string, unknown>)[key];
    const bv = (b as Record<string, unknown>)[key];
    if (!deepEqualJson(av, bv)) {
      return firstDivergence(av, bv, path.length === 0 ? key : `${path}.${key}`);
    }
  }
  return path.length === 0 ? '(root)' : path;
}

// =============================================================================
// Credential deny-list
// =============================================================================

export const DENIED_CREDENTIAL_STRINGS = ['celldcanary-local-1', 'AWS_SECRET', 'MINIO_ROOT'] as const;

/** Scans every regular file in `dir` for a denied credential substring; returns the first hit, if any. */
export async function findLeakedCredential(dir: string): Promise<{ file: string; matched: string } | undefined> {
  const entries = await readdir(dir, { withFileTypes: true });
  const names = entries
    .filter(entry => entry.isFile())
    .map(entry => entry.name)
    .sort();
  for (const name of names) {
    const content = await readFile(join(dir, name), 'utf8').catch(() => undefined);
    if (content === undefined) continue;
    for (const needle of DENIED_CREDENTIAL_STRINGS) {
      if (content.includes(needle)) return { file: name, matched: needle };
    }
  }
  return undefined;
}

// =============================================================================
// Manifest: write + check
// =============================================================================

export interface ManifestMeta {
  runId: string;
  teamHubGitSha: string;
  celldImage: string;
  imageDigests?: string;
  protocolVersion: string;
  routeAuthority: string;
  generatedAt: string;
}

export async function sha256File(path: string): Promise<string> {
  const buffer = await readFile(path);
  return createHash('sha256').update(buffer).digest('hex');
}

/** Hashes every OTHER file in `dir` (sorted), plus a trailing `# {meta}` line. */
export async function writeManifest(dir: string, meta: ManifestMeta): Promise<void> {
  const entries = await readdir(dir, { withFileTypes: true });
  const names = entries
    .filter(entry => entry.isFile() && entry.name !== 'manifest.sha256' && entry.name !== 'verification.json')
    .map(entry => entry.name)
    .sort();
  const lines: string[] = [];
  for (const name of names) {
    const hash = await sha256File(join(dir, name));
    lines.push(`${hash}  ${name}`);
  }
  lines.push(`# ${JSON.stringify(meta)}`);
  await writeFile(join(dir, 'manifest.sha256'), `${lines.join('\n')}\n`);
}

export interface ManifestEntryCheck {
  file: string;
  expected: string;
  computed: string;
  matches: boolean;
}

export interface ManifestCheckResult {
  entries: ManifestEntryCheck[];
  metaLine: string | undefined;
  allMatch: boolean;
}

export async function checkManifest(dir: string): Promise<ManifestCheckResult> {
  const text = await readFile(join(dir, 'manifest.sha256'), 'utf8');
  const lines = text.split('\n').filter(line => line.length > 0);
  const metaLine = lines.find(line => line.startsWith('# '));
  const fileLines = lines.filter(line => !line.startsWith('# '));
  const entries: ManifestEntryCheck[] = [];
  for (const line of fileLines) {
    const match = /^([0-9a-f]{64}) {2}(.+)$/.exec(line);
    if (match === null) {
      entries.push({ file: line, expected: '(unparseable manifest line)', computed: '', matches: false });
      continue;
    }
    const expected = match[1] as string;
    const file = match[2] as string;
    const filePath = join(dir, file);
    const computed = existsSync(filePath) ? await sha256File(filePath) : '(file missing)';
    entries.push({ file, expected, computed, matches: expected === computed });
  }
  return { entries, metaLine, allMatch: entries.length > 0 && entries.every(entry => entry.matches) };
}

// =============================================================================
// events.ndjson: parse + structural checks
// =============================================================================

export interface EventsCheckResult {
  events: HubEventV1[];
  count: number;
  allParsed: boolean;
  parseErrors: Array<{ line: number; message: string }>;
  sequenceGapFree: boolean;
  firstGap?: number;
  eventIdsValid: boolean;
  invalidEventIds: string[];
  aggregateRevisionNonDecreasing: boolean;
}

export function parseAndCheckEvents(ndjsonText: string): EventsCheckResult {
  const lines = ndjsonText.split('\n').filter(line => line.trim().length > 0);
  const events: HubEventV1[] = [];
  const parseErrors: Array<{ line: number; message: string }> = [];

  lines.forEach((line, index) => {
    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(line);
    } catch (error) {
      parseErrors.push({ line: index + 1, message: `invalid JSON: ${String(error)}` });
      return;
    }
    const result = hubEventV1Schema.safeParse(parsedJson);
    if (!result.success) {
      parseErrors.push({ line: index + 1, message: result.error.message });
      return;
    }
    events.push(result.data);
  });

  let sequenceGapFree = true;
  let firstGap: number | undefined;
  events.forEach((event, index) => {
    const expected = index + 1;
    if (event.sequence !== expected && firstGap === undefined) {
      sequenceGapFree = false;
      firstGap = expected;
    }
  });

  const invalidEventIds = events
    .filter(event => event.eventId !== `${event.workspaceId}:${event.sequence}`)
    .map(event => event.eventId);

  let aggregateRevisionNonDecreasing = true;
  for (let i = 1; i < events.length; i++) {
    if ((events[i] as HubEventV1).aggregateRevision < (events[i - 1] as HubEventV1).aggregateRevision) {
      aggregateRevisionNonDecreasing = false;
      break;
    }
  }

  const result: EventsCheckResult = {
    events,
    count: lines.length,
    allParsed: parseErrors.length === 0,
    parseErrors,
    sequenceGapFree,
    eventIdsValid: invalidEventIds.length === 0,
    invalidEventIds,
    aggregateRevisionNonDecreasing,
  };
  if (firstGap !== undefined) result.firstGap = firstGap;
  return result;
}

// =============================================================================
// Replay: fold `apply` over events, compare to the live snapshot's state
// =============================================================================

export interface ReplayCheckResult {
  matches: boolean;
  firstDivergingKey?: string;
}

export function checkReplay(events: HubEventV1[], snapshotState: unknown): ReplayCheckResult {
  let state: CellWorkspaceState | null = null;
  for (const event of events) {
    state = apply(state, { type: event.type, data: event.data });
  }
  if (deepEqualJson(state, snapshotState)) return { matches: true };
  return { matches: false, firstDivergingKey: firstDivergence(state, snapshotState) };
}

// =============================================================================
// Field-level computed-vs-expected reporting
// =============================================================================

export interface FieldCheck<T> {
  expected: T;
  computed: T | null;
  /** false when the claimed fact cannot be independently recomputed from the event journal alone. */
  checkable: boolean;
  matches: boolean;
}

function fieldCheck<T>(expected: T, computed: T | null, checkable: boolean): FieldCheck<T> {
  return { expected, computed, checkable, matches: checkable ? deepEqualJson(expected, computed) : true };
}

// =============================================================================
// Race gate (RFC 0001 §Verification gates 1)
// =============================================================================

export interface RaceGateClaim {
  winnerCommandId: string;
  loserCode: string;
  replayedCoordination: boolean;
  alteredReuseCode: string;
  eventCountStable: boolean;
}

export interface RaceGateReport {
  winnerCommandId: FieldCheck<string>;
  eventCountStable: FieldCheck<boolean>;
  loserCode: FieldCheck<string>;
  replayedCoordination: FieldCheck<boolean>;
  alteredReuseCode: FieldCheck<string>;
  allMatch: boolean;
}

/**
 * Rejections (loserCode / replayedCoordination / alteredReuseCode) are never
 * persisted as events (RFC 0001 §Cell command semantics) — they cannot be
 * recomputed from events.ndjson alone, so those fields are reported as
 * non-checkable rather than silently trusted or spuriously failed.
 */
export function checkRaceGate(events: HubEventV1[], claim: RaceGateClaim): RaceGateReport {
  // Scope the uniqueness check to the CONTENDED problem: a workspace
  // legitimately carries one problem_claimed event per problem (the native
  // proof claims three different problems), but the problem the claimed
  // winner command touched must have exactly ONE claim event — the loser's
  // rejection left no trace in the journal.
  const claimedEvents = events.filter(event => event.type === 'problem_claimed');
  const winnerEvent = claimedEvents.find(event => event.commandId === claim.winnerCommandId);
  const contendedProblemId = winnerEvent === undefined ? null : (winnerEvent.data.problemId as string | undefined);
  const contentionClaims =
    contendedProblemId === undefined || contendedProblemId === null
      ? []
      : claimedEvents.filter(event => event.data.problemId === contendedProblemId);
  const computedWinnerCommandId = contentionClaims.length === 1 ? (contentionClaims[0] as HubEventV1).commandId : null;
  const computedEventCountStable = contentionClaims.length === 1;

  const winnerCommandId = fieldCheck(claim.winnerCommandId, computedWinnerCommandId, true);
  const eventCountStable = fieldCheck(claim.eventCountStable, computedEventCountStable, true);
  const loserCode = fieldCheck(claim.loserCode, null, false);
  const replayedCoordination = fieldCheck(claim.replayedCoordination, null, false);
  const alteredReuseCode = fieldCheck(claim.alteredReuseCode, null, false);

  return {
    winnerCommandId,
    eventCountStable,
    loserCode,
    replayedCoordination,
    alteredReuseCode,
    allMatch: winnerCommandId.matches && eventCountStable.matches,
  };
}

// =============================================================================
// Impact gate (RFC 0001 §Verification gates 2)
// =============================================================================

export interface ImpactClaim {
  impactId: string;
  targetAgentId: string;
  [key: string]: unknown;
}

export interface ImpactGateGates {
  revisionConflictObserved: boolean;
  blockingUnackObserved: boolean;
  ackPrecedesCompletion: boolean;
  finalOutputCitesImpactId: boolean;
}

export interface ImpactGateClaim {
  impacts: ImpactClaim[];
  gates: ImpactGateGates;
}

export interface ImpactGateReport {
  perImpact: Array<{
    impactId: string;
    claimedTargetAgentId: string;
    computedTargetAgentId: string | null;
    matches: boolean;
  }>;
  impactsTargetBetaOnly: FieldCheck<boolean>;
  ackPrecedesCompletion: FieldCheck<boolean>;
  finalOutputCitesImpactId: FieldCheck<boolean>;
  revisionConflictObserved: FieldCheck<boolean>;
  blockingUnackObserved: FieldCheck<boolean>;
  allMatch: boolean;
}

/**
 * revisionConflictObserved / blockingUnackObserved are rejections, never
 * events — same non-checkable treatment as the race gate's loser codes.
 */
export function checkImpactGate(events: HubEventV1[], claim: ImpactGateClaim, betaAgentId: string): ImpactGateReport {
  const detected = events.filter(event => event.type === 'impact_detected');
  const acknowledged = events.filter(event => event.type === 'impact_acknowledged');
  const resolved = events.filter(
    event => event.type === 'problem_status_changed' && event.data.status === 'resolved',
  );

  const perImpact = claim.impacts.map(claimed => {
    const found = detected.find(
      event => (event.data.impact as { impactId?: string } | undefined)?.impactId === claimed.impactId,
    );
    const computedTargetAgentId =
      found === undefined ? null : ((found.data.impact as { targetAgentId?: string }).targetAgentId ?? null);
    return {
      impactId: claimed.impactId,
      claimedTargetAgentId: claimed.targetAgentId,
      computedTargetAgentId,
      matches: computedTargetAgentId === claimed.targetAgentId,
    };
  });

  const allDetectedTargetBeta = detected.every(
    event => (event.data.impact as { targetAgentId?: string }).targetAgentId === betaAgentId,
  );
  const impactsTargetBetaOnly = fieldCheck(true, allDetectedTargetBeta, true);

  const lastResolvedSeq = resolved.length > 0 ? Math.max(...resolved.map(event => event.sequence)) : null;
  const computedAckPrecedes =
    lastResolvedSeq !== null && acknowledged.length > 0 && acknowledged.every(event => event.sequence < lastResolvedSeq);
  const ackPrecedesCompletion = fieldCheck(claim.gates.ackPrecedesCompletion, computedAckPrecedes, true);

  const lastResolved = resolved.length > 0 ? resolved[resolved.length - 1] : undefined;
  const citedImpactId =
    lastResolved === undefined
      ? null
      : ((lastResolved.data.output as { sourceImpactId?: string } | undefined)?.sourceImpactId ?? null);
  const computedCites =
    citedImpactId !== null &&
    detected.some(event => (event.data.impact as { impactId?: string }).impactId === citedImpactId);
  const finalOutputCitesImpactId = fieldCheck(claim.gates.finalOutputCitesImpactId, computedCites, true);

  const revisionConflictObserved = fieldCheck(claim.gates.revisionConflictObserved, null, false);
  const blockingUnackObserved = fieldCheck(claim.gates.blockingUnackObserved, null, false);

  return {
    perImpact,
    impactsTargetBetaOnly,
    ackPrecedesCompletion,
    finalOutputCitesImpactId,
    revisionConflictObserved,
    blockingUnackObserved,
    allMatch:
      perImpact.every(entry => entry.matches) &&
      impactsTargetBetaOnly.matches &&
      ackPrecedesCompletion.matches &&
      finalOutputCitesImpactId.matches,
  };
}

// =============================================================================
// Orchestrator
// =============================================================================

interface SetupRecordForVerify {
  agents: { alpha: { agentId: string }; beta: { agentId: string } };
}

function gateMatches(gate: { present: boolean; allMatch?: boolean }): boolean {
  return gate.present ? gate.allMatch === true : true;
}

export async function runVerify(config: CanaryConfig): Promise<number> {
  const dir = config.evidenceDir;

  const manifest = await checkManifest(dir);
  console.log(`[verify] manifest: entries=${manifest.entries.length} allMatch=${manifest.allMatch}`);

  const eventsText = await readFile(join(dir, 'events.ndjson'), 'utf8');
  const eventsCheck = parseAndCheckEvents(eventsText);
  console.log(
    `[verify] events: count=${eventsCheck.count} allParsed=${eventsCheck.allParsed} ` +
      `sequenceGapFree=${eventsCheck.sequenceGapFree} eventIdsValid=${eventsCheck.eventIdsValid} ` +
      `aggregateRevisionNonDecreasing=${eventsCheck.aggregateRevisionNonDecreasing}` +
      (eventsCheck.firstGap !== undefined ? ` firstGap=${eventsCheck.firstGap}` : ''),
  );

  const snapshotRaw = JSON.parse(await readFile(join(dir, 'workspace-snapshot.json'), 'utf8')) as {
    state: unknown;
  };
  const replay = checkReplay(eventsCheck.events, snapshotRaw.state);
  console.log(
    `[verify] replay: matches=${replay.matches}` +
      (replay.firstDivergingKey !== undefined ? ` firstDivergingKey=${replay.firstDivergingKey}` : ''),
  );

  let raceGate: { present: boolean } & Partial<RaceGateReport> & { reason?: string } = { present: false };
  const automatedPath = join(dir, 'automated.json');
  if (existsSync(automatedPath)) {
    const automated = JSON.parse(await readFile(automatedPath, 'utf8')) as {
      raceGate?: RaceGateClaim;
      missing?: boolean;
    };
    if (automated.raceGate !== undefined) {
      raceGate = { present: true, ...checkRaceGate(eventsCheck.events, automated.raceGate) };
    } else {
      raceGate = { present: false, reason: automated.missing === true ? 'stub (missing: true)' : 'no raceGate field' };
    }
  }
  console.log(`[verify] raceGate: present=${raceGate.present} allMatch=${raceGate.allMatch ?? 'n/a'}`);

  let impactGate: { present: boolean } & Partial<ImpactGateReport> & { reason?: string } = { present: false };
  const nativePath = join(dir, 'native-observations.json');
  if (existsSync(nativePath)) {
    const native = JSON.parse(await readFile(nativePath, 'utf8')) as {
      impacts?: ImpactClaim[];
      gates?: ImpactGateGates;
      missing?: boolean;
    };
    if (native.impacts !== undefined && native.gates !== undefined) {
      const setup = JSON.parse(await readFile(join(dir, 'setup.json'), 'utf8')) as SetupRecordForVerify;
      impactGate = {
        present: true,
        ...checkImpactGate(eventsCheck.events, { impacts: native.impacts, gates: native.gates }, setup.agents.beta.agentId),
      };
    } else {
      impactGate = { present: false, reason: native.missing === true ? 'stub (missing: true)' : 'incomplete shape' };
    }
  }
  console.log(`[verify] impactGate: present=${impactGate.present} allMatch=${impactGate.allMatch ?? 'n/a'}`);

  const overallMatches =
    manifest.allMatch &&
    eventsCheck.allParsed &&
    eventsCheck.sequenceGapFree &&
    eventsCheck.eventIdsValid &&
    eventsCheck.aggregateRevisionNonDecreasing &&
    replay.matches &&
    gateMatches(raceGate) &&
    gateMatches(impactGate);

  const verification = {
    runId: config.runId,
    generatedAt: new Date().toISOString(),
    manifest,
    events: eventsCheck,
    replay,
    raceGate,
    impactGate,
    overallMatches,
  };
  await writeFile(join(dir, 'verification.json'), JSON.stringify(verification, null, 2));
  console.log(`[verify] wrote verification.json overallMatches=${overallMatches}`);

  return overallMatches ? 0 : 1;
}
