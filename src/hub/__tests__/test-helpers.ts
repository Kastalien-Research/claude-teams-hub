/**
 * Shared test helpers for hub tests.
 * Provides in-memory storage and common setup utilities.
 */

import type {
  HubStorage,
  AgentIdentity,
  Workspace,
  Problem,
  Proposal,
  ConsensusMarker,
  Channel,
} from '../hub-types.js';
import { statusAfterReview } from '../hub-types.js';
import type {
  AssumptionRecord,
  DecisionRecord,
  OutcomeRecord,
} from '../decision-types.js';
import type { ThoughtData } from '../../persistence/types.js';

/**
 * Creates an in-memory HubStorage implementation for tests.
 * All data lives in memory and resets between tests.
 */
export function createInMemoryHubStorage(): HubStorage {
  const agents: AgentIdentity[] = [];
  const workspaces: Map<string, Workspace> = new Map();
  const problems: Map<string, Map<string, Problem>> = new Map();
  const proposals: Map<string, Map<string, Proposal>> = new Map();
  const consensusMarkers: Map<string, Map<string, ConsensusMarker>> = new Map();
  const channels: Map<string, Map<string, Channel>> = new Map();

  // Decision-ledger collections hold SERIALIZED records, unlike the reference-
  // holding maps above. hub-storage-fs round-trips every decision record
  // through JSON, so a caller there can never mutate stored state by holding a
  // returned object; a shared-reference fake would let exactly that pass in
  // tests and throw in production — and it would quietly defeat the
  // append-only property test, whose whole subject is whether stored bytes
  // changed.
  const decisions: Map<string, string> = new Map();
  const assumptions: Map<string, string> = new Map();
  const outcomes: Map<string, string> = new Map();

  const parse = <T>(json: string | undefined): T | null =>
    json === undefined ? null : (JSON.parse(json) as T);

  return {
    // Agent operations
    async getAgents() { return [...agents]; },
    // Upsert, matching hub-storage-fs: a re-save of the same agentId replaces
    // the record. The old append left a stale first record that getAgent's
    // find() kept returning.
    async saveAgent(agent) {
      const idx = agents.findIndex(a => a.agentId === agent.agentId);
      if (idx >= 0) agents[idx] = agent;
      else agents.push(agent);
    },
    async getAgent(agentId) { return agents.find(a => a.agentId === agentId) ?? null; },

    // Workspace operations
    async getWorkspace(workspaceId) { return workspaces.get(workspaceId) ?? null; },
    async saveWorkspace(workspace) { workspaces.set(workspace.id, workspace); },
    async listWorkspaces() { return [...workspaces.values()]; },

    // Problem operations
    async getProblem(workspaceId, problemId) {
      return problems.get(workspaceId)?.get(problemId) ?? null;
    },
    async saveProblem(problem) {
      if (!problems.has(problem.workspaceId)) problems.set(problem.workspaceId, new Map());
      problems.get(problem.workspaceId)!.set(problem.id, problem);
    },
    async listProblems(workspaceId) {
      return [...(problems.get(workspaceId)?.values() ?? [])];
    },

    // Proposal operations
    async getProposal(workspaceId, proposalId) {
      return proposals.get(workspaceId)?.get(proposalId) ?? null;
    },
    async saveProposal(proposal) {
      if (!proposals.has(proposal.workspaceId)) proposals.set(proposal.workspaceId, new Map());
      proposals.get(proposal.workspaceId)!.set(proposal.id, proposal);
    },
    async listProposals(workspaceId) {
      return [...(proposals.get(workspaceId)?.values() ?? [])];
    },

    // Consensus operations
    async getConsensusMarker(workspaceId, markerId) {
      return consensusMarkers.get(workspaceId)?.get(markerId) ?? null;
    },
    async saveConsensusMarker(marker) {
      if (!consensusMarkers.has(marker.workspaceId)) consensusMarkers.set(marker.workspaceId, new Map());
      consensusMarkers.get(marker.workspaceId)!.set(marker.id, marker);
    },
    async listConsensusMarkers(workspaceId) {
      return [...(consensusMarkers.get(workspaceId)?.values() ?? [])];
    },

    // Channel operations
    async getChannel(workspaceId, problemId) {
      return channels.get(workspaceId)?.get(problemId) ?? null;
    },
    async saveChannel(channel) {
      // Same rejection as hub-storage-fs: the key is problemId on every read
      // path, so a channel whose id disagrees with its address is refused here
      // too — otherwise tests would pass behavior that throws in production.
      if (channel.id !== channel.problemId) {
        throw new Error(
          `Channel id must equal its problemId: ${channel.id} !== ${channel.problemId}`,
        );
      }
      if (!channels.has(channel.workspaceId)) channels.set(channel.workspaceId, new Map());
      channels.get(channel.workspaceId)!.set(channel.problemId, channel);
    },

    // Append operations (concurrency-safe contracts; trivial in-memory)
    async appendReview(workspaceId, proposalId, review) {
      const proposal = proposals.get(workspaceId)?.get(proposalId);
      if (!proposal) throw new Error(`Proposal not found: ${proposalId}`);
      if (!proposal.reviews.some(r => r.id === review.id)) {
        proposal.reviews.push(review);
      }
      proposal.status = statusAfterReview(proposal.reviews);
      proposal.updatedAt = new Date().toISOString();
    },
    async appendEndorsement(workspaceId, markerId, agentId) {
      const marker = consensusMarkers.get(workspaceId)?.get(markerId);
      if (!marker) throw new Error(`Consensus marker not found: ${markerId}`);
      if (!marker.agreedBy.includes(agentId)) {
        marker.agreedBy.push(agentId);
      }
    },
    async appendMessage(workspaceId, problemId, message) {
      const channel = channels.get(workspaceId)?.get(problemId);
      if (!channel) throw new Error(`Channel not found for problem: ${problemId}`);
      channel.messages.push(message);
      return channel.messages.length;
    },

    // Decision ledger operations (hub-global — no workspace key)
    async getDecision(decisionId) {
      return parse<DecisionRecord>(decisions.get(decisionId));
    },
    async saveDecision(decision) {
      decisions.set(decision.id, JSON.stringify(decision));
    },
    async listDecisions() {
      return [...decisions.values()].map(json => JSON.parse(json) as DecisionRecord);
    },
    async getAssumption(assumptionId) {
      return parse<AssumptionRecord>(assumptions.get(assumptionId));
    },
    async saveAssumption(assumption) {
      assumptions.set(assumption.id, JSON.stringify(assumption));
    },
    async listAssumptions() {
      return [...assumptions.values()].map(json => JSON.parse(json) as AssumptionRecord);
    },
    async appendAssumptionChallenge(assumptionId, challenge) {
      const assumption = parse<AssumptionRecord>(assumptions.get(assumptionId));
      if (!assumption) throw new Error(`Assumption not found: ${assumptionId}`);
      if (!assumption.challenges.some(c => c.id === challenge.id)) {
        assumption.challenges.push(challenge);
        assumptions.set(assumptionId, JSON.stringify(assumption));
      }
    },
    async saveOutcome(outcome) {
      outcomes.set(outcome.id, JSON.stringify(outcome));
    },
    async listOutcomes() {
      return [...outcomes.values()].map(json => JSON.parse(json) as OutcomeRecord);
    },
  };
}

/**
 * Creates a minimal in-memory thought store for tests.
 * Used when tests need to verify thought persistence alongside hub operations.
 */
export function createInMemoryThoughtStore() {
  const thoughts: Map<string, Map<number, ThoughtData>> = new Map();
  const branches: Map<string, Map<string, Map<number, ThoughtData>>> = new Map();

  return {
    async createSession(sessionId: string) {
      thoughts.set(sessionId, new Map());
      branches.set(sessionId, new Map());
    },
    async saveThought(sessionId: string, thought: ThoughtData) {
      if (!thoughts.has(sessionId)) thoughts.set(sessionId, new Map());
      thoughts.get(sessionId)!.set(thought.thoughtNumber, { ...thought });
    },
    async getThought(sessionId: string, thoughtNumber: number) {
      return thoughts.get(sessionId)?.get(thoughtNumber) ?? null;
    },
    async getThoughts(sessionId: string) {
      const session = thoughts.get(sessionId);
      if (!session) return [];
      return [...session.values()].sort((a, b) => a.thoughtNumber - b.thoughtNumber);
    },
    async saveBranchThought(sessionId: string, branchId: string, thought: ThoughtData) {
      if (!branches.has(sessionId)) branches.set(sessionId, new Map());
      const sessionBranches = branches.get(sessionId)!;
      if (!sessionBranches.has(branchId)) sessionBranches.set(branchId, new Map());
      sessionBranches.get(branchId)!.set(thought.thoughtNumber, { ...thought });
    },
    async getBranch(sessionId: string, branchId: string) {
      const branch = branches.get(sessionId)?.get(branchId);
      if (!branch) return [];
      return [...branch.values()].sort((a, b) => a.thoughtNumber - b.thoughtNumber);
    },
    async getThoughtCount(sessionId: string) {
      return thoughts.get(sessionId)?.size ?? 0;
    },
  };
}
