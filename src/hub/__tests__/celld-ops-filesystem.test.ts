/**
 * The five coordination operations (RFC 0001, docs/rfcs/0001-celld-workspace-canary.md)
 * exist only on celld-backed workspaces. This filesystem HubHandler has no
 * cell, so every one of them must be rejected with OPERATION_REQUIRES_CELLD_BACKEND
 * BEFORE any storage or manager call runs — there is no record-level adapter
 * to fall back to (the RFC's rejected-alternatives rationale).
 *
 * Each test asserts three things: the error message names the code, the
 * error carries `code`/`retryable` as plain properties (src/hub must not
 * import src/celld, so this is a local convention, not a shared class), and
 * the operation branch itself invoked no storage method beyond what stage-2
 * membership gating already calls (getAgent, getWorkspace) BEFORE reaching
 * the switch statement.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { createHubHandler } from '../hub-handler.js';
import type { HubStorage } from '../hub-types.js';
import { createInMemoryHubStorage, createInMemoryThoughtStore } from './test-helpers.js';

/** Wraps every HubStorage method with a call recorder. */
function recordingStorage(base: HubStorage): { storage: HubStorage; calls: string[] } {
  const calls: string[] = [];
  const storage = {} as HubStorage;
  for (const key of Object.keys(base) as Array<keyof HubStorage>) {
    const fn = base[key] as (...args: unknown[]) => unknown;
    (storage[key] as unknown) = (...args: unknown[]) => {
      calls.push(key as string);
      return fn(...args);
    };
  }
  return { storage, calls };
}

const COORDINATION_OPS: Array<[string, Record<string, unknown>]> = [
  ['declare_work_intent', { problemId: 'prob-1', leaseUntil: '2026-08-06T18:00:00.000Z' }],
  ['record_work_change', { kind: 'interface-rename', summary: 'renamed X to Y', severity: 'blocking' }],
  ['list_impacts', {}],
  ['acknowledge_impact', { impactId: 'impact-1', disposition: 'accepted' }],
  ['read_workspace_events', {}],
];

describe('Coordination operations on a filesystem workspace (RFC 0001)', () => {
  let handler: ReturnType<typeof createHubHandler>;
  let calls: string[];
  let agentId: string;
  let workspaceId: string;

  beforeEach(async () => {
    const base = createInMemoryHubStorage();
    const recording = recordingStorage(base);
    calls = recording.calls;
    handler = createHubHandler(recording.storage, createInMemoryThoughtStore());

    const reg = (await handler.handle(null, 'register', { name: 'coordinator' })) as {
      agentId: string;
    };
    agentId = reg.agentId;
    const ws = (await handler.handle(agentId, 'create_workspace', {
      name: 'ws',
      description: 'filesystem workspace, no backend opt-in',
    })) as { workspaceId: string };
    workspaceId = ws.workspaceId;

    // Registration + workspace creation/membership are setup, not the
    // operation under test — start each test's assertion from a clean slate.
    calls.length = 0;
  });

  for (const [operation, payload] of COORDINATION_OPS) {
    it(`${operation} rejects with OPERATION_REQUIRES_CELLD_BACKEND before any storage call beyond stage gating`, async () => {
      const args = { workspaceId, ...payload };

      let caught: unknown;
      try {
        await handler.handle(agentId, operation, args);
      } catch (err) {
        caught = err;
      }

      expect(caught).toBeInstanceOf(Error);
      const err = caught as Error & { code?: string; retryable?: boolean };
      expect(err.message).toContain('OPERATION_REQUIRES_CELLD_BACKEND');
      expect(err.code).toBe('OPERATION_REQUIRES_CELLD_BACKEND');
      expect(err.retryable).toBe(false);

      // Stage-2 membership gating (identity.getAgent, then
      // workspace.isAgentInWorkspace -> storage.getWorkspace) runs before the
      // switch statement for every stage-2 operation and is not what this
      // test is about — only the operation BRANCH itself must have called
      // nothing further.
      const beyondGating = calls.filter((c) => c !== 'getAgent' && c !== 'getWorkspace');
      expect(beyondGating).toEqual([]);
    });
  }
});
