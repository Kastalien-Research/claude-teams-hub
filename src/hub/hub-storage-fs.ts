/**
 * Filesystem Hub Storage — Persists hub state to JSON files
 *
 * ADR-002 Section 10.17: Storage Persistence Tests
 */

import { readFile, writeFile, rename, unlink, mkdir, readdir } from 'node:fs/promises';
import { join, dirname, basename } from 'node:path';
import { randomUUID } from 'node:crypto';
import type {
  HubStorage,
  AgentIdentity,
  Workspace,
  Problem,
  Proposal,
  ConsensusMarker,
  Channel,
  ChannelMessage,
} from './hub-types.js';
import { statusAfterReview } from './hub-types.js';

/**
 * Single-writer storage: append operations below are read-modify-write on
 * JSON files and are only safe because local mode runs one server process.
 * Multi-tenant deployments use SupabaseHubStorage (row-level appends).
 *
 * Every write goes through `writeJson`, which writes to a sibling temp file
 * and `rename`s it into place — POSIX rename is atomic within a directory, so
 * a crash mid-write leaves either the old file or the new one, never a
 * truncated one. This makes individual records crash-safe; it does not make
 * concurrent writers safe (still one process, per the comment above), so no
 * locking is added.
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
 * Writes JSON to `path` via temp-file + atomic rename, so a crash mid-write
 * cannot leave a truncated or partially-written record on disk — the rename
 * either lands the full new content or doesn't happen at all.
 */
async function writeJson(path: string, data: unknown): Promise<void> {
  const dir = dirname(path);
  await ensureDir(dir);
  const tmpPath = join(dir, `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`);
  await writeFile(tmpPath, JSON.stringify(data, null, 2), 'utf-8');
  try {
    await rename(tmpPath, path);
  } catch (err) {
    // Best-effort cleanup so a failed rename doesn't leave the temp file
    // behind; the original error is what the caller needs to see.
    await unlink(tmpPath).catch(() => {});
    throw err;
  }
}

const MESSAGE_FILE_RE = /^(\d+)\.json$/;

/**
 * Extracts the numeric sequence from a channel message filename (`NNNN.json`),
 * or null for anything else in the directory (temp files, stray entries).
 */
function messageSeq(filename: string): number | null {
  const match = MESSAGE_FILE_RE.exec(filename);
  return match ? Number(match[1]) : null;
}

export function createFileSystemHubStorage(dataDir: string): HubStorage {
  const hubDir = join(dataDir, 'hub');
  const agentsPath = join(hubDir, 'agents.json');

  function workspaceDir(workspaceId: string): string {
    return join(hubDir, 'workspaces', workspaceId);
  }

  // Channel storage is split in two: `<problemId>.json` holds channel
  // metadata plus whatever messages were embedded by a legacy whole-file
  // write (saveChannel, or an appendMessage from before this split existed);
  // `<problemId>/NNNN.json` holds messages appended since the split, one
  // crash-safe file per message instead of a whole-file rewrite. getChannel
  // merges both — legacy messages first, then the per-file ones in filename
  // order — so a channel written entirely by the old code path still reads
  // correctly with no migration step.
  function channelMetaPath(workspaceId: string, problemId: string): string {
    return join(workspaceDir(workspaceId), 'channels', `${problemId}.json`);
  }

  function channelMessagesDir(workspaceId: string, problemId: string): string {
    return join(workspaceDir(workspaceId), 'channels', problemId);
  }

  async function readMessageFiles(workspaceId: string, problemId: string): Promise<ChannelMessage[]> {
    const dir = channelMessagesDir(workspaceId, problemId);
    const entries = await readdirOrWarn(dir);
    const seqAndFile = entries
      .map(name => ({ name, seq: messageSeq(name) }))
      .filter((e): e is { name: string; seq: number } => e.seq !== null)
      .sort((a, b) => a.seq - b.seq);

    const messages: ChannelMessage[] = [];
    for (const { name } of seqAndFile) {
      const message = await readJson<ChannelMessage>(join(dir, name));
      if (message) messages.push(message);
    }
    return messages;
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
      const meta = await readJson<Channel>(channelMetaPath(workspaceId, problemId));
      if (!meta) return null;
      const perFileMessages = await readMessageFiles(workspaceId, problemId);
      // `meta.messages` is whatever a legacy whole-file write left behind
      // (possibly empty, possibly a full history predating the per-file
      // split); per-file messages were appended after it, so they sort after.
      return { ...meta, messages: [...meta.messages, ...perFileMessages] };
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
      await writeJson(channelMetaPath(channel.workspaceId, channel.problemId), channel);
    },

    async appendMessage(workspaceId, problemId, message) {
      const meta = await readJson<Channel>(channelMetaPath(workspaceId, problemId));
      if (!meta) throw new Error(`Channel not found for problem: ${problemId}`);

      const dir = channelMessagesDir(workspaceId, problemId);
      const existing = await readdirOrWarn(dir);
      const maxSeq = existing.reduce((max, name) => {
        const seq = messageSeq(name);
        return seq !== null && seq > max ? seq : max;
      }, 0);
      const nextSeq = maxSeq + 1;
      const fileName = `${String(nextSeq).padStart(6, '0')}.json`;
      // One message per file — a crash mid-write can corrupt at most this
      // one message file, never the rest of the channel (writeJson itself
      // is atomic via temp-file + rename, on top of the one-file-per-message
      // split).
      await writeJson(join(dir, fileName), message);

      return meta.messages.length + existing.filter(name => messageSeq(name) !== null).length + 1;
    },
  };
}
