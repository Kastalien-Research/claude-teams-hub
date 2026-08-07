/**
 * Pure command-dedup decision (RFC 0001 §Cell command semantics, steps 2-4).
 *
 * Factored out of the Durable Object shell so the decision unit-tests in Node.
 */

export interface StoredReceipt {
  commandId: string;
  payloadHash: string;
  outcome: 'accepted' | 'rejected';
  revision: number;
  resultJson: string;
  firstEventSequence?: number;
  lastEventSequence?: number;
}

export type DedupDecision =
  | { kind: 'fresh' }
  | { kind: 'replay'; receipt: StoredReceipt }
  | { kind: 'conflict'; receipt: StoredReceipt };

export function decideDedup(existing: StoredReceipt | undefined, incomingHash: string): DedupDecision {
  if (existing === undefined) return { kind: 'fresh' };
  if (existing.payloadHash === incomingHash) return { kind: 'replay', receipt: existing };
  return { kind: 'conflict', receipt: existing };
}
