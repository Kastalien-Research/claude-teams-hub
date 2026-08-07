/**
 * Unit tests for celld canary `verify`'s pure check functions (RFC 0001
 * §Verification gates). No Docker, no network — synthetic fixtures in temp
 * dirs and hand-stamped HubEventV1 objects (mirroring how workspace-cell.ts
 * stamps sequence/eventId/aggregateRevision onto reducer event drafts).
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { HubEventV1 } from '../contracts.js';
import { reduce, type ReducerCommand } from '../domain/reducer.js';
import {
  checkManifest,
  checkReplay,
  findLeakedCredential,
  parseAndCheckEvents,
  writeManifest,
  type ManifestMeta,
} from '../canary/verify.js';

function stampEvent(input: {
  workspaceId: string;
  sequence: number;
  aggregateRevision: number;
  type: string;
  commandId: string;
  agentId: string;
  occurredAt: string;
  data: Record<string, unknown>;
}): HubEventV1 {
  return {
    schemaVersion: 'hub-event-v1',
    eventId: `${input.workspaceId}:${input.sequence}`,
    workspaceId: input.workspaceId,
    sequence: input.sequence,
    aggregateRevision: input.aggregateRevision,
    type: input.type,
    commandId: input.commandId,
    actor: { agentId: input.agentId },
    occurredAt: input.occurredAt,
    data: input.data as HubEventV1['data'],
  };
}

describe('parseAndCheckEvents', () => {
  it('reports a gap-free sequence as valid with no firstGap', () => {
    const events = [1, 2, 3].map(sequence =>
      stampEvent({
        workspaceId: 'ws-gapfree',
        sequence,
        aggregateRevision: sequence,
        type: 'problem_created',
        commandId: `cmd-${sequence}`,
        agentId: 'alice',
        occurredAt: '2026-08-06T00:00:00.000Z',
        data: {},
      }),
    );
    const text = events.map(event => JSON.stringify(event)).join('\n');
    const result = parseAndCheckEvents(text);

    expect(result.allParsed).toBe(true);
    expect(result.count).toBe(3);
    expect(result.sequenceGapFree).toBe(true);
    expect(result.firstGap).toBeUndefined();
    expect(result.eventIdsValid).toBe(true);
    expect(result.aggregateRevisionNonDecreasing).toBe(true);
  });

  it('reports a gapped sequence with the missing sequence number as firstGap', () => {
    const sequences = [1, 2, 4];
    const events = sequences.map(sequence =>
      stampEvent({
        workspaceId: 'ws-gapped',
        sequence,
        aggregateRevision: sequence,
        type: 'problem_created',
        commandId: `cmd-${sequence}`,
        agentId: 'alice',
        occurredAt: '2026-08-06T00:00:00.000Z',
        data: {},
      }),
    );
    const text = events.map(event => JSON.stringify(event)).join('\n');
    const result = parseAndCheckEvents(text);

    expect(result.sequenceGapFree).toBe(false);
    expect(result.firstGap).toBe(3);
  });
});

describe('checkReplay', () => {
  function buildTwoStepScenario() {
    const issuedAt = '2026-08-06T00:00:00.000Z';
    const createCommand: ReducerCommand = {
      commandId: 'c1',
      operation: 'create_workspace',
      workspaceId: 'ws-replay',
      actorId: 'alice',
      issuedAt,
      context: {},
      payload: { name: 'W', description: 'd' },
    };
    const createOutcome = reduce(null, createCommand, 0);
    if (!createOutcome.ok) throw new Error('expected create_workspace to be accepted');
    const event1 = stampEvent({
      workspaceId: 'ws-replay',
      sequence: 1,
      aggregateRevision: 1,
      type: createOutcome.events[0]!.type,
      commandId: 'c1',
      agentId: 'alice',
      occurredAt: issuedAt,
      data: createOutcome.events[0]!.data,
    });

    const problemCommand: ReducerCommand = {
      commandId: 'c2',
      operation: 'create_problem',
      workspaceId: 'ws-replay',
      actorId: 'alice',
      issuedAt,
      context: {},
      payload: { title: 'T', description: 'D' },
    };
    const problemOutcome = reduce(createOutcome.state, problemCommand, 1);
    if (!problemOutcome.ok) throw new Error('expected create_problem to be accepted');
    const event2 = stampEvent({
      workspaceId: 'ws-replay',
      sequence: 2,
      aggregateRevision: 2,
      type: problemOutcome.events[0]!.type,
      commandId: 'c2',
      agentId: 'alice',
      occurredAt: issuedAt,
      data: problemOutcome.events[0]!.data,
    });

    return { event1, event2, correctState: problemOutcome.state };
  }

  it('matches when folding apply() over the events reproduces the snapshot state', () => {
    const { event1, event2, correctState } = buildTwoStepScenario();
    const result = checkReplay([event1, event2], correctState);
    expect(result.matches).toBe(true);
    expect(result.firstDivergingKey).toBeUndefined();
  });

  it('detects divergence when one event is mutated before replay', () => {
    const { event1, event2, correctState } = buildTwoStepScenario();
    const mutatedEvent2: HubEventV1 = {
      ...event2,
      data: {
        ...event2.data,
        problem: {
          ...(event2.data.problem as Record<string, unknown>),
          title: 'MUTATED',
        },
      },
    };
    const result = checkReplay([event1, mutatedEvent2], correctState);
    expect(result.matches).toBe(false);
    expect(result.firstDivergingKey).toBeDefined();
    expect(result.firstDivergingKey).toContain('problems');
  });
});

describe('manifest write + check', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'celld-canary-manifest-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const meta: ManifestMeta = {
    runId: 'test-run',
    teamHubGitSha: 'deadbeef',
    celldImage: 'ghcr.io/denoland/celld:test',
    protocolVersion: 'hub-command-v1',
    routeAuthority: 'workspace-backends.json',
    generatedAt: '2026-08-06T00:00:00.000Z',
  };

  it('reports all entries matching immediately after writeManifest', async () => {
    await writeFile(join(dir, 'a.txt'), 'hello');
    await writeFile(join(dir, 'b.txt'), 'world');
    await writeManifest(dir, meta);

    const result = await checkManifest(dir);
    expect(result.entries).toHaveLength(2);
    expect(result.allMatch).toBe(true);
    expect(result.entries.every(entry => entry.matches)).toBe(true);
  });

  it('detects a mismatch when a manifested file is modified after writeManifest', async () => {
    await writeFile(join(dir, 'a.txt'), 'hello');
    await writeFile(join(dir, 'b.txt'), 'world');
    await writeManifest(dir, meta);

    await writeFile(join(dir, 'a.txt'), 'tampered');

    const result = await checkManifest(dir);
    expect(result.allMatch).toBe(false);
    const aEntry = result.entries.find(entry => entry.file === 'a.txt');
    const bEntry = result.entries.find(entry => entry.file === 'b.txt');
    expect(aEntry?.matches).toBe(false);
    expect(bEntry?.matches).toBe(true);
  });
});

describe('findLeakedCredential', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'celld-canary-creds-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('trips on a planted MinIO credential string', async () => {
    await writeFile(join(dir, 'clean.json'), JSON.stringify({ ok: true }));
    await writeFile(join(dir, 'leaky.json'), JSON.stringify({ note: 'password is celldcanary-local-1' }));

    const leak = await findLeakedCredential(dir);
    expect(leak).toEqual({ file: 'leaky.json', matched: 'celldcanary-local-1' });
  });

  it('finds nothing when no evidence file contains a denied string', async () => {
    await writeFile(join(dir, 'clean.json'), JSON.stringify({ ok: true }));
    const leak = await findLeakedCredential(dir);
    expect(leak).toBeUndefined();
  });
});
