/**
 * Unified Thoughtbox event types.
 *
 * Carries Hub coordination events and thought-ledger events through a single
 * SSE stream at /events.
 */

export type HubEventType =
  | 'problem_created'
  | 'problem_status_changed'
  | 'message_posted'
  | 'proposal_created'
  | 'proposal_merged'
  | 'consensus_marked'
  | 'workspace_created'
  | 'agent_registered'
  | 'workspace_joined'
  | 'problem_claimed'
  | 'proposal_reviewed'
  | 'decision_recorded'
  | 'decision_superseded'
  | 'assumption_recorded'
  | 'assumption_challenged'
  | 'outcome_recorded';

/**
 * Events bridged from the in-process ThoughtEmitter. One type covers all three
 * emitter shapes (added / revised / branched); the variant travels in
 * `data.kind` so a dashboard can render the stream without a type switch.
 */
export type ThoughtEventType = 'thought_recorded';

export interface ThoughtboxEvent {
  source: 'hub' | 'thought';
  type: HubEventType | ThoughtEventType;
  /**
   * The workspace this event belongs to.
   *
   * Convention: `'*'` marks an event that PRECEDES workspace membership —
   * `agent_registered` is emitted before the agent has joined anything, so it
   * has no workspace to be scoped to. The event stream delivers `'*'` events
   * to every client regardless of that client's workspace filter.
   */
  workspaceId: string;
  timestamp: string;
  data: Record<string, unknown>;
}

export type OnThoughtboxEvent = (event: ThoughtboxEvent) => void;
