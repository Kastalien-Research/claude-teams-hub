/**
 * Shared test builders for the celld domain suite (RFC 0001).
 *
 * Not itself a test file — colocated under __tests__/ so it is picked up by
 * neither the app's tsc build (excluded via **\/*.test.ts is NOT enough, but
 * this file has no `.test.ts` suffix so vitest's include glob also skips it)
 * nor vitest, only imported by the sibling suites.
 */

import { reduce, type ReducerCommand, type ReducerOutcome } from '../domain/reducer.js';
import type { CellEventDraft, CellWorkspaceState } from '../domain/state.js';
import type { JsonValue } from '../canonical-json.js';

const BASE_TIME_MS = Date.parse('2026-08-06T00:00:00.000Z');
let tick = 0;

/** Monotonically increasing ISO timestamp, one second apart per call. */
export function nextIssuedAt(): string {
  tick += 1;
  return new Date(BASE_TIME_MS + tick * 1000).toISOString();
}

let commandCounter = 0;
export function nextCommandId(prefix = 'cmd'): string {
  commandCounter += 1;
  return `${prefix}-${commandCounter}`;
}

export interface BuildCommandInput {
  operation: string;
  actorId: string;
  payload: Record<string, JsonValue>;
  workspaceId?: string;
  commandId?: string;
  issuedAt?: string;
  expectedRevision?: number;
  context?: { teamRunId?: string; nativeTaskId?: string; processRunId?: string };
}

/** Builds a ReducerCommand with sensible, deterministic-but-unique defaults. */
export function buildCommand(input: BuildCommandInput): ReducerCommand {
  const command: ReducerCommand = {
    commandId: input.commandId ?? nextCommandId(),
    operation: input.operation,
    workspaceId: input.workspaceId ?? 'ws-1',
    actorId: input.actorId,
    issuedAt: input.issuedAt ?? nextIssuedAt(),
    context: input.context ?? {},
    payload: input.payload,
  };
  if (input.expectedRevision !== undefined) {
    return { ...command, expectedRevision: input.expectedRevision };
  }
  return command;
}

export type AcceptedOutcome = Extract<ReducerOutcome, { ok: true }>;
export type RejectedOutcome = Extract<ReducerOutcome, { ok: false }>;

/**
 * Drives a sequence of commands against one aggregate the way a real caller
 * would: each accepted command advances `revision` by exactly one, mirroring
 * "aggregateRevision advances once per accepted command" (RFC 0001).
 */
export function createTestCell() {
  let state: CellWorkspaceState | null = null;
  let revision = 0;
  const acceptedEvents: CellEventDraft[] = [];
  const acceptedCommands: ReducerCommand[] = [];

  return {
    state(): CellWorkspaceState | null {
      return state;
    },
    revision(): number {
      return revision;
    },
    /** All event drafts emitted by every accepted command so far, in order. */
    events(): CellEventDraft[] {
      return acceptedEvents;
    },
    /** All commands accepted so far, in order — the replay-invariant fixture. */
    commands(): ReducerCommand[] {
      return acceptedCommands;
    },
    /** Calls reduce without committing, regardless of outcome. */
    probe(command: ReducerCommand): ReducerOutcome {
      return reduce(state, command, revision);
    },
    /** Calls reduce and asserts acceptance; commits state/revision/events. */
    accept(command: ReducerCommand): AcceptedOutcome {
      const outcome = reduce(state, command, revision);
      if (!outcome.ok) {
        throw new Error(
          `expected command '${command.operation}' to be accepted, got rejection ${outcome.rejection.code}: ${outcome.rejection.message}`,
        );
      }
      state = outcome.state;
      revision += 1;
      acceptedEvents.push(...outcome.events);
      acceptedCommands.push(command);
      return outcome;
    },
    /** Calls reduce and asserts rejection; never commits. */
    reject(command: ReducerCommand): RejectedOutcome {
      const outcome = reduce(state, command, revision);
      if (outcome.ok) {
        throw new Error(`expected command '${command.operation}' to be rejected, but it was accepted`);
      }
      return outcome;
    },
  };
}

export function isAccepted(outcome: ReducerOutcome): outcome is AcceptedOutcome {
  return outcome.ok;
}

export function isRejected(outcome: ReducerOutcome): outcome is RejectedOutcome {
  return !outcome.ok;
}
