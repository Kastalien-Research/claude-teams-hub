/**
 * Error-code propagation through the hub tool transport (RFC 0001 §Error codes).
 *
 * Two things are pinned here:
 * 1. Existing behavior — an error with no `code` property serializes to the
 *    exact current shape, byte-identical. This must never regress: it is
 *    what every filesystem-workspace error looks like today.
 * 2. New behavior — an error carrying `code` (plain object or CelldError)
 *    additively serializes `code`/`retryable`/`details` alongside `error`,
 *    and the `hubHandler` injection seam lets a test substitute the handler
 *    without touching hub-handler.ts.
 */

import { describe, it, expect } from 'vitest';
import { createHubToolHandler } from '../hub-tool-handler.js';
import { createInMemoryHubStorage, createInMemoryThoughtStore } from './test-helpers.js';
import { AGENT_ID_REQUIRED_ERROR } from '../identity-resolver.js';
import type { HubStorage } from '../hub-types.js';
import type { HubHandler } from '../hub-handler.js';
import { CelldError } from '../../celld/errors.js';

describe('hub-tool-handler error propagation', () => {
  describe('existing behavior pin (no code)', () => {
    it('serializes a plain Error to exactly {"error": message} with isError true', async () => {
      const hubStorage: HubStorage = createInMemoryHubStorage();
      const thoughtStore = createInMemoryThoughtStore();
      const handler = createHubToolHandler({ hubStorage, thoughtStore });

      // create_workspace with no agentId and no env identity configured is a
      // real, naturally-thrown plain Error (SPEC-HUB-003 c5) — not a mock.
      const result = await handler.handle({
        operation: 'create_workspace',
        name: 'ws',
        description: 'test',
      });

      expect(result.isError).toBe(true);
      expect(result.content).toHaveLength(1);
      expect(result.content[0]).toEqual({
        type: 'text',
        text: JSON.stringify({ error: AGENT_ID_REQUIRED_ERROR }, null, 2),
      });

      // Byte-identical to the exact current shape: only one key, "error".
      const parsed = JSON.parse(result.content[0].text as string);
      expect(Object.keys(parsed)).toEqual(['error']);
    });
  });

  describe('new behavior (code present)', () => {
    // Every non-stage-0 operation resolves an explicit agentId against a
    // durable record before the call ever reaches hubHandler.handle — so a
    // throwing-handler test must pre-register that record directly, or
    // identity resolution throws first and the injected handler is never
    // exercised.
    async function harnessWithThrowingHandler(thrown: unknown) {
      const hubStorage: HubStorage = createInMemoryHubStorage();
      const thoughtStore = createInMemoryThoughtStore();
      await hubStorage.saveAgent({
        agentId: 'a-1',
        name: 'test-agent',
        role: 'contributor',
        registeredAt: new Date().toISOString(),
      });
      const throwingHandler: HubHandler = {
        async handle() {
          throw thrown;
        },
      };
      return createHubToolHandler({ hubStorage, thoughtStore, hubHandler: throwingHandler });
    }

    it('serializes a plain Object.assign-ed error with code/retryable/details, key order error/code/retryable/details', async () => {
      const err = Object.assign(new Error('claim race lost'), {
        code: 'PROBLEM_ALREADY_CLAIMED',
        retryable: false,
        details: { problemId: 'prob-1' },
      });
      const handler = await harnessWithThrowingHandler(err);

      const result = await handler.handle({ operation: 'claim_problem', agentId: 'a-1' });

      expect(result.isError).toBe(true);
      const text = result.content[0].text as string;
      expect(text).toBe(
        JSON.stringify(
          {
            error: 'claim race lost',
            code: 'PROBLEM_ALREADY_CLAIMED',
            retryable: false,
            details: { problemId: 'prob-1' },
          },
          null,
          2,
        ),
      );
      // Explicit key-order assertion (JSON.stringify preserves insertion order).
      expect(Object.keys(JSON.parse(text))).toEqual(['error', 'code', 'retryable', 'details']);
    });

    it('serializes a CelldError with code/retryable, no details when absent', async () => {
      const err = new CelldError({
        code: 'REVISION_CONFLICT',
        message: 'stale revision',
        retryable: false,
      });
      const handler = await harnessWithThrowingHandler(err);

      const result = await handler.handle({ operation: 'update_problem', agentId: 'a-1' });

      expect(result.isError).toBe(true);
      const parsed = JSON.parse(result.content[0].text as string);
      expect(parsed).toEqual({
        error: '[REVISION_CONFLICT] stale revision',
        code: 'REVISION_CONFLICT',
        retryable: false,
      });
      expect(Object.keys(parsed)).toEqual(['error', 'code', 'retryable']);
    });

    it('omits retryable when the caught error does not carry a boolean retryable', async () => {
      const err = Object.assign(new Error('no retry info'), { code: 'NOT_FOUND' });
      const handler = await harnessWithThrowingHandler(err);

      const result = await handler.handle({ operation: 'get_problem', agentId: 'a-1' });

      const parsed = JSON.parse(result.content[0].text as string);
      expect(parsed).toEqual({ error: 'no retry info', code: 'NOT_FOUND' });
    });
  });

  describe('hubHandler injection seam', () => {
    it('uses the injected hubHandler instead of constructing one from hubStorage', async () => {
      const hubStorage: HubStorage = createInMemoryHubStorage();
      const thoughtStore = createInMemoryThoughtStore();
      await hubStorage.saveAgent({
        agentId: 'a-1',
        name: 'test-agent',
        role: 'contributor',
        registeredAt: new Date().toISOString(),
      });
      let calledWith: { agentId: string | null; operation: string } | undefined;
      const injected: HubHandler = {
        async handle(agentId, operation) {
          calledWith = { agentId, operation };
          return { injected: true };
        },
      };

      const handler = createHubToolHandler({ hubStorage, thoughtStore, hubHandler: injected });
      const result = await handler.handle({ operation: 'whoami', agentId: 'a-1' });

      expect(calledWith).toEqual({ agentId: 'a-1', operation: 'whoami' });
      expect(JSON.parse(result.content[0].text as string)).toEqual({ injected: true });
    });

    it('falls back to constructing its own handler when hubHandler is absent (unchanged)', async () => {
      const hubStorage: HubStorage = createInMemoryHubStorage();
      const thoughtStore = createInMemoryThoughtStore();
      const handler = createHubToolHandler({ hubStorage, thoughtStore });

      const result = await handler.handle({ operation: 'register', name: 'alice' });

      expect(result.isError).toBeFalsy();
      const parsed = JSON.parse(result.content[0].text as string);
      expect(parsed.name).toBe('alice');
    });
  });
});
