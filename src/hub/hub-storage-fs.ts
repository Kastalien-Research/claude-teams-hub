/**
 * Filesystem Hub Storage — Persists hub state to JSON files
 *
 * ADR-002 Section 10.17: Storage Persistence Tests
 */

import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import type {
  HubStorage,
  AgentIdentity,
  Workspace,
  Problem,
  Proposal,
  ConsensusMarker,
  Channel,
} from './hub-types.js';
import { statusAfterReview } from './hub-types.js';
import type {
  AssumptionRecord,
  DecisionRecord,
  OutcomeRecord,
} from './decision-types.js';

/**
 * Single-writer storage: append operations below are read-modify-write on
 * JSON files and are only safe because local mode runs one server process.
 * Multi-tenant deployments use SupabaseHubStorage (row-level appends).
 */

async function ensureDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true });
}

/**
 * Reads one JSON record, or null if it cannot be produced.
 *
 * The list* readers below discard nulls, so a record that fails to read
 * disappears from list_problems, list_proposals, and workspace_digest. An
 * absent file is a normal outcome and stays silent; anything else — corrupt
 * JSON, a truncated write, EACCES, EISDIR — means state that exists on disk
 * is being dropped, and that has to leave a trace naming the file.
 */
async function readJson<T>(path: string): Promise<T | null> {
  try {
    const content = await readFile(path, 'utf-8');
    return JSON.parse(content) as T;
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code !== 'ENOENT') {
      const message = err instanceof Error ? err.message : String(err);
      console.warn(`[hub-storage] unreadable record dropped: ${path} — ${message}`);
    }
    return null;
  }
}

/**
 * Lists the entries of a collection directory, or [] if it cannot be listed.
 *
 * The record-level twin of `readJson`, and the more dangerous of the two: an
 * unreadable record drops one item, an unlistable directory drops the whole
 * collection, so `list_problems` returning [] would mean either "none" or
 * "all of them, invisibly". A directory that does not exist yet is normal on a
 * first run and stays silent; every other failure names the directory.
 */
async function readdirOrWarn(dir: string): Promise<string[]> {
  try {
    return await readdir(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code !== 'ENOENT') {
      const message = err instanceof Error ? err.message : String(err);
      console.warn(`[hub-storage] unlistable directory, collection dropped: ${dir} — ${message}`);
    }
    return [];
  }
}

/**
 * Reads every `.json` record in a collection directory, dropping the ones that
 * fail — the loop the workspace-scoped list* readers write inline, factored out
 * because the decision ledger has three collections shaped identically.
 */
async function listRecords<T>(dir: string): Promise<T[]> {
  const files = await readdirOrWarn(dir);
  const results: T[] = [];
  for (const file of files) {
    if (!file.endsWith('.json')) continue;
    const record = await readJson<T>(join(dir, file));
    if (record) results.push(record);
  }
  return results;
}

async function writeJson(path: string, data: unknown): Promise<void> {
  const dir = dirname(path);
  await ensureDir(dir);
  await writeFile(path, JSON.stringify(data, null, 2), 'utf-8');
}

export function createFileSystemHubStorage(dataDir: string): HubStorage {
  const hubDir = join(dataDir, 'hub');
  const agentsPath = join(hubDir, 'agents.json');
  const decisionsDir = join(hubDir, 'decisions');

  function workspaceDir(workspaceId: string): string {
    return join(hubDir, 'workspaces', workspaceId);
  }

  return {
    // Agent registry
    async getAgents() {
      const agents = await readJson<AgentIdentity[]>(agentsPath);
      return agents ?? [];
    },

    async saveAgent(agent) {
      const agents = await this.getAgents();
      const idx = agents.findIndex(a => a.agentId === agent.agentId);
      if (idx >= 0) {
        agents[idx] = agent;
      } else {
        agents.push(agent);
      }
      await writeJson(agentsPath, agents);
    },

    async getAgent(agentId) {
      const agents = await this.getAgents();
      return agents.find(a => a.agentId === agentId) ?? null;
    },

    // Workspace operations
    async getWorkspace(workspaceId) {
      return readJson<Workspace>(join(workspaceDir(workspaceId), 'workspace.json'));
    },

    async saveWorkspace(workspace) {
      await writeJson(join(workspaceDir(workspace.id), 'workspace.json'), workspace);
    },

    async listWorkspaces() {
      const wsRoot = join(hubDir, 'workspaces');
      const dirs = await readdirOrWarn(wsRoot);
      const results: Workspace[] = [];
      for (const dir of dirs) {
        const ws = await readJson<Workspace>(join(wsRoot, dir, 'workspace.json'));
        if (ws) results.push(ws);
      }
      return results;
    },

    // Problem operations
    async getProblem(workspaceId, problemId) {
      return readJson<Problem>(join(workspaceDir(workspaceId), 'problems', `${problemId}.json`));
    },

    async saveProblem(problem) {
      await writeJson(
        join(workspaceDir(problem.workspaceId), 'problems', `${problem.id}.json`),
        problem,
      );
    },

    async listProblems(workspaceId) {
      const dir = join(workspaceDir(workspaceId), 'problems');
      const files = await readdirOrWarn(dir);
      const results: Problem[] = [];
      for (const file of files) {
        if (file.endsWith('.json')) {
          const prob = await readJson<Problem>(join(dir, file));
          if (prob) results.push(prob);
        }
      }
      return results;
    },

    // Proposal operations
    async getProposal(workspaceId, proposalId) {
      return readJson<Proposal>(join(workspaceDir(workspaceId), 'proposals', `${proposalId}.json`));
    },

    async saveProposal(proposal) {
      await writeJson(
        join(workspaceDir(proposal.workspaceId), 'proposals', `${proposal.id}.json`),
        proposal,
      );
    },

    async listProposals(workspaceId) {
      const dir = join(workspaceDir(workspaceId), 'proposals');
      const files = await readdirOrWarn(dir);
      const results: Proposal[] = [];
      for (const file of files) {
        if (file.endsWith('.json')) {
          const prop = await readJson<Proposal>(join(dir, file));
          if (prop) results.push(prop);
        }
      }
      return results;
    },

    async appendReview(workspaceId, proposalId, review) {
      const proposal = await this.getProposal(workspaceId, proposalId);
      if (!proposal) throw new Error(`Proposal not found: ${proposalId}`);
      if (!proposal.reviews.some(r => r.id === review.id)) {
        proposal.reviews.push(review);
      }
      proposal.status = statusAfterReview(proposal.reviews);
      proposal.updatedAt = new Date().toISOString();
      await this.saveProposal(proposal);
    },

    // Consensus operations
    async getConsensusMarker(workspaceId, markerId) {
      return readJson<ConsensusMarker>(join(workspaceDir(workspaceId), 'consensus', `${markerId}.json`));
    },

    async saveConsensusMarker(marker) {
      await writeJson(
        join(workspaceDir(marker.workspaceId), 'consensus', `${marker.id}.json`),
        marker,
      );
    },

    async listConsensusMarkers(workspaceId) {
      const dir = join(workspaceDir(workspaceId), 'consensus');
      const files = await readdirOrWarn(dir);
      const results: ConsensusMarker[] = [];
      for (const file of files) {
        if (file.endsWith('.json')) {
          const marker = await readJson<ConsensusMarker>(join(dir, file));
          if (marker) results.push(marker);
        }
      }
      return results;
    },

    async appendEndorsement(workspaceId, markerId, agentId) {
      const marker = await this.getConsensusMarker(workspaceId, markerId);
      if (!marker) throw new Error(`Consensus marker not found: ${markerId}`);
      if (!marker.agreedBy.includes(agentId)) {
        marker.agreedBy.push(agentId);
        await this.saveConsensusMarker(marker);
      }
    },

    // Channel operations
    async getChannel(workspaceId, problemId) {
      return readJson<Channel>(join(workspaceDir(workspaceId), 'channels', `${problemId}.json`));
    },

    async saveChannel(channel) {
      // Channels are addressed by problemId on every read path (getChannel,
      // appendMessage, resource URIs), so the write key is problemId too and
      // a mismatched id is rejected rather than persisted at an address that
      // disagrees with it.
      if (channel.id !== channel.problemId) {
        throw new Error(
          `Channel id must equal its problemId: ${channel.id} !== ${channel.problemId}`,
        );
      }
      await writeJson(
        join(workspaceDir(channel.workspaceId), 'channels', `${channel.problemId}.json`),
        channel,
      );
    },

    async appendMessage(workspaceId, problemId, message) {
      const channel = await this.getChannel(workspaceId, problemId);
      if (!channel) throw new Error(`Channel not found for problem: ${problemId}`);
      channel.messages.push(message);
      await this.saveChannel(channel);
      return channel.messages.length;
    },

    // Decision ledger operations
    //
    // Flat one-JSON-doc-per-record under the hub root, NOT under workspaces/:
    // the ledger is hub-global, and the layout is deliberately something a
    // consultation hook can read with a glob and a json.load, with no server
    // in the path.
    async getDecision(decisionId) {
      return readJson<DecisionRecord>(join(decisionsDir, 'records', `${decisionId}.json`));
    },

    async saveDecision(decision) {
      await writeJson(join(decisionsDir, 'records', `${decision.id}.json`), decision);
    },

    async listDecisions() {
      return listRecords<DecisionRecord>(join(decisionsDir, 'records'));
    },

    async getAssumption(assumptionId) {
      return readJson<AssumptionRecord>(join(decisionsDir, 'assumptions', `${assumptionId}.json`));
    },

    async saveAssumption(assumption) {
      await writeJson(join(decisionsDir, 'assumptions', `${assumption.id}.json`), assumption);
    },

    async listAssumptions() {
      return listRecords<AssumptionRecord>(join(decisionsDir, 'assumptions'));
    },

    async appendAssumptionChallenge(assumptionId, challenge) {
      const assumption = await this.getAssumption(assumptionId);
      if (!assumption) throw new Error(`Assumption not found: ${assumptionId}`);
      if (!assumption.challenges.some(c => c.id === challenge.id)) {
        assumption.challenges.push(challenge);
        await this.saveAssumption(assumption);
      }
    },

    async saveOutcome(outcome) {
      await writeJson(join(decisionsDir, 'outcomes', `${outcome.id}.json`), outcome);
    },

    async listOutcomes() {
      return listRecords<OutcomeRecord>(join(decisionsDir, 'outcomes'));
    },
  };
}
