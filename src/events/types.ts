/**
 * Unified Thoughtbox event types.
 *
 * Carries both Hub coordination events and Protocol lifecycle events
 * through a single SSE stream at /events.
 */

export type HubEventType =
  | 'problem_created'
  | 'problem_status_changed'
  | 'message_posted'
  | 'proposal_created'
  | 'proposal_merged'
  | 'consensus_marked'
  | 'workspace_created';

export type ProtocolEventType =
  | 'theseus_init'
  | 'theseus_visa'
  | 'theseus_checkpoint'
  | 'theseus_outcome'
  | 'theseus_complete'
  | 'ulysses_init'
  | 'ulysses_outcome'
  | 'ulysses_reflect'
  | 'ulysses_complete';

export interface ThoughtboxEvent {
  source: 'hub' | 'protocol';
  type: HubEventType | ProtocolEventType;
  workspaceId: string;
  timestamp: string;
  data: Record<string, unknown>;
}

export type OnThoughtboxEvent = (event: ThoughtboxEvent) => void;
