/**
 * Filesystem Hub Storage — Persists hub state to JSON files
 *
 * ADR-002 Section 10.17: Storage Persistence Tests
 */

import { readFile, open, rename, link, unlink, mkdir, readdir } from 'node:fs/promises';
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
 * Every write goes through `writeJson`, which writes to a sibling temp file,
 * `fsync`s its content, and `rename`s it into place — POSIX rename is atomic
 * within a directory, so a crash mid-write leaves either the old file or the
 * new one, never a truncated one. The fsync matters because rename alone is
 * not a durability barrier: without it, the written bytes can still be
 * sitting in the page cache, and a power loss or kernel crash (as opposed to
 * just this process crashing) can lose them even though the rename
 * "completed" from this process's point of view. This makes individual
 * writes crash-safe; it does not make concurrent writers safe (still one
 * process, per the comment above), so no locking is added — channel message
 * appends are the one exception that needs collision-safety despite that,
 * handled separately below via `link`'s exclusive-create semantics.
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
 * fsyncs a directory so that a preceding rename/link (a directory-entry
 * change, not a file-content change) is itself durable, not just the
 * content of the file it points at. Best-effort: some platforms/filesystems
 * don't support fsync-ing a directory handle, and a failure here does not
 * mean the write itself failed, so it is swallowed rather than thrown.
 */
async function fsyncDir(dir: string): Promise<void> {
  try {
    const handle = await open(dir, 'r');
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  } catch {
    // best-effort — see doc comment above
  }
}

/**
 * Writes content to a fresh temp file and fsyncs it before returning the
 * path, so every caller composing further steps (rename, link) on top is
 * composing on top of content that is already durable on disk — a crash
 * after this point can only lose the directory-entry step, never truncate
 * the content itself.
 */
async function writeTempFile(dir: string, prefix: string, content: string): Promise<string> {
  await ensureDir(dir);
  const tmpPath = join(dir, `.${prefix}.${process.pid}.${randomUUID()}.tmp`);
  const handle = await open(tmpPath, 'w');
  try {
    await handle.writeFile(content, 'utf-8');
    await handle.sync(); // fsync — flushes page-cache content to disk
  } finally {
    await handle.close();
  }
  return tmpPath;
}

/**
 * Writes JSON to `path` via fsynced-temp-file + atomic rename, then fsyncs
 * the containing directory so the rename itself is durable. A crash
 * mid-write cannot leave a truncated or partially-written record on disk —
 * every step that reaches the destination path is already fsynced content.
 */
async function writeJson(path: string, data: unknown): Promise<void> {
  const dir = dirname(path);
  const tmpPath = await writeTempFile(dir, basename(path), JSON.stringify(data, null, 2));
  try {
    await rename(tmpPath, path);
    await fsyncDir(dir);
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

/**
 * Claims the next free sequence number in `dir` for `message` and returns
 * the seq it landed at.
 *
 * Two concurrent callers can both list the directory, compute the same
 * "next" seq, and both attempt to land at the same filename — a plain
 * `rename` would let the second one silently replace the first's
 * already-acknowledged message, since rename overwrites its destination
 * unconditionally. `link` does not: it is atomic AND exclusive, failing
 * with EEXIST if the destination already exists. So the message content is
 * written and fsynced to a uniquely-named temp file first (content is
 * final and durable before any seq is even attempted), then `link`ed into
 * candidate seq slots, bumping and retrying on EEXIST until one succeeds.
 * No seq attempt can ever overwrite another writer's file — the loser
 * always finds out via EEXIST and moves on, never clobbers.
 */
async function claimMessageSeq(dir: string, message: ChannelMessage): Promise<number> {
  const tmpPath = await writeTempFile(dir, 'msg', JSON.stringify(message, null, 2));
  try {
    let seq = (await maxMessageSeq(dir)) + 1;
    for (;;) {
      const path = join(dir, `${String(seq).padStart(6, '0')}.json`);
      try {
        await link(tmpPath, path);
        await fsyncDir(dir);
        return seq;
      } catch (err) {
        if ((err as NodeJS.ErrnoException)?.code === 'EEXIST') {
          seq += 1;
          continue;
        }
        throw err;
      }
    }
  } finally {
    // The temp file is a second hard link to the same inode as whichever
    // seq slot won; removing this name never touches the content the
    // winning link points at.
    await unlink(tmpPath).catch(() => {});
  }
}

async function maxMessageSeq(dir: string): Promise<number> {
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') return 0;
    throw err;
  }
  return entries.reduce((max, name) => {
    const seq = messageSeq(name);
    return seq !== null && seq > max ? seq : max;
  }, 0);
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
      // claimMessageSeq is exclusive (link, not rename) — a concurrent
      // appendMessage racing on the same directory listing cannot land on
      // the same seq as this one, so it cannot overwrite this message.
      await claimMessageSeq(dir, message);

      // Recount from disk rather than trusting a value computed before the
      // claim: a concurrent writer may have claimed a seq in between, and
      // the count this call returns must reflect what is actually on disk
      // now, not a stale prediction.
      const files = await readdirOrWarn(dir);
      const perFileCount = files.filter(name => messageSeq(name) !== null).length;
      return meta.messages.length + perFileCount;
    },
  };
}
