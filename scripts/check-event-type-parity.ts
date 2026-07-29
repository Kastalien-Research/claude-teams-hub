#!/usr/bin/env tsx
/**
 * Code ↔ code invariant check for the hub event vocabulary.
 *
 * The bug this guards against: hub-handler.ts starts emitting a new event
 * type, but `HubEventType` in the shared vocabulary is never extended — so the
 * SSE stream carries a type no consumer has a case for, and nothing fails
 * until a dashboard silently drops the event.
 *
 * Upstream (Thoughtbox) this same check ran against a live Postgres CHECK
 * constraint on `protocol_history.event_type`. Team Hub has no database and no
 * protocol table; the authority is now src/events/types.ts, so the check is
 * purely static and needs no credentials.
 *
 * Invariants:
 *   1. hub-handler.ts's local `HubEvent['type']` union === `HubEventType`.
 *   2. Every literal emitted via `emit({ type: '...' })` is in that union.
 *   3. `ThoughtEventType` members are NOT hub events — thought_recorded rides
 *      the same stream under source 'thought' and must not leak into the hub
 *      union, which would let it bypass the hub source filter.
 */

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import process from 'node:process';

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TYPES_PATH = path.join(PROJECT_ROOT, 'src/events/types.ts');
const HANDLER_PATH = path.join(PROJECT_ROOT, 'src/hub/hub-handler.ts');

/** Collect every single-quoted literal in a source slice. */
function literalsIn(slice: string): Set<string> {
  const found = new Set<string>();
  const pattern = /'([^']+)'/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(slice)) !== null) {
    found.add(match[1]!);
  }
  return found;
}

/** Extract the members of `export type <name> = 'a' | 'b';`. */
function extractTypeAlias(source: string, name: string, file: string): Set<string> {
  const start = source.indexOf(`export type ${name} =`);
  if (start === -1) {
    fail(`could not find 'export type ${name}' in ${file}`);
  }
  const end = source.indexOf(';', start);
  if (end === -1) {
    fail(`unterminated 'export type ${name}' declaration in ${file}`);
  }
  return literalsIn(source.slice(start, end));
}

/**
 * Extract the `type:` union from `export interface HubEvent { ... }`.
 * Returns both the union members and the interface slice, so the caller can
 * exclude the declaration when scanning for emitted literals.
 */
function extractHubEventUnion(source: string): { members: Set<string>; declEnd: number } {
  const start = source.indexOf('export interface HubEvent {');
  if (start === -1) {
    fail(`could not find 'export interface HubEvent' in ${HANDLER_PATH}`);
  }
  const typeStart = source.indexOf('type:', start);
  const typeEnd = source.indexOf(';', typeStart);
  if (typeStart === -1 || typeEnd === -1) {
    fail(`could not parse the 'type:' union of HubEvent in ${HANDLER_PATH}`);
  }
  return { members: literalsIn(source.slice(typeStart, typeEnd)), declEnd: typeEnd };
}

/** Extract literals from `emit({ type: '...' })` call sites. */
function extractEmittedLiterals(source: string, afterOffset: number): Set<string> {
  const emitted = new Set<string>();
  const pattern = /emit\(\{\s*type:\s*'([^']+)'/g;
  const body = source.slice(afterOffset);
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(body)) !== null) {
    emitted.add(match[1]!);
  }
  return emitted;
}

function fail(message: string): never {
  console.error(`error: ${message}`);
  process.exit(2);
}

function sorted(values: Iterable<string>): string[] {
  return [...values].sort();
}

async function main(): Promise<void> {
  const typesSource = await readFile(TYPES_PATH, 'utf8');
  const handlerSource = await readFile(HANDLER_PATH, 'utf8');

  const vocabulary = extractTypeAlias(typesSource, 'HubEventType', TYPES_PATH);
  const thoughtVocabulary = extractTypeAlias(typesSource, 'ThoughtEventType', TYPES_PATH);
  const { members: handlerUnion, declEnd } = extractHubEventUnion(handlerSource);
  const emitted = extractEmittedLiterals(handlerSource, declEnd);

  if (vocabulary.size === 0) fail(`HubEventType in ${TYPES_PATH} has no members`);
  if (handlerUnion.size === 0) fail(`HubEvent['type'] in ${HANDLER_PATH} has no members`);
  if (emitted.size === 0) fail(`no emit({ type: '...' }) call sites found in ${HANDLER_PATH}`);

  console.log(`HubEventType (src/events/types.ts):     ${sorted(vocabulary).join(', ')}`);
  console.log(`HubEvent['type'] (src/hub/hub-handler): ${sorted(handlerUnion).join(', ')}`);
  console.log(`Emitted by hub-handler:                 ${sorted(emitted).join(', ')}`);

  let failed = false;

  const missingFromVocabulary = sorted(handlerUnion).filter((v) => !vocabulary.has(v));
  if (missingFromVocabulary.length > 0) {
    failed = true;
    console.error(`\nFAIL: HubEvent declares types absent from HubEventType:`);
    for (const v of missingFromVocabulary) console.error(`  - ${v}`);
    console.error(`Fix: add them to HubEventType in ${TYPES_PATH}.`);
  }

  const missingFromHandler = sorted(vocabulary).filter((v) => !handlerUnion.has(v));
  if (missingFromHandler.length > 0) {
    failed = true;
    console.error(`\nFAIL: HubEventType declares types absent from HubEvent:`);
    for (const v of missingFromHandler) console.error(`  - ${v}`);
    console.error(`Fix: extend the HubEvent union in ${HANDLER_PATH}.`);
  }

  const unemittable = sorted(emitted).filter((v) => !handlerUnion.has(v));
  if (unemittable.length > 0) {
    failed = true;
    console.error(`\nFAIL: hub-handler emits types its own HubEvent union does not allow:`);
    for (const v of unemittable) console.error(`  - ${v}`);
  }

  const leaked = sorted(thoughtVocabulary).filter((v) => handlerUnion.has(v) || vocabulary.has(v));
  if (leaked.length > 0) {
    failed = true;
    console.error(`\nFAIL: thought event types leaked into the hub vocabulary:`);
    for (const v of leaked) console.error(`  - ${v}`);
    console.error(`Thought events travel under source 'thought'; a hub-source`);
    console.error(`client must not receive them via the hub filter.`);
  }

  if (failed) process.exit(1);

  const declaredNotEmitted = sorted(vocabulary).filter((v) => !emitted.has(v));
  if (declaredNotEmitted.length > 0) {
    console.log(`\nNote: declared but not emitted by hub-handler: ${declaredNotEmitted.join(', ')}`);
    console.log('(Not a failure — may be emitted by another source.)');
  }

  console.log('\nOK: hub event vocabulary is in parity across types.ts and hub-handler.ts.');
}

main().catch((err) => {
  console.error('check-event-type-parity failed:', err);
  process.exit(2);
});
