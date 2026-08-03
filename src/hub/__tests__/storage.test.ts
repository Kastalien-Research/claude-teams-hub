import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm, writeFile, mkdir, readdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { readFile } from 'node:fs/promises';
import { createFileSystemHubStorage } from '../hub-storage-fs.js';
import { createIdentityManager } from '../identity.js';
import { createWorkspaceManager } from '../workspace.js';
import { createProblemsManager } from '../problems.js';
import { createProposalsManager } from '../proposals.js';
import { createChannelsManager } from '../channels.js';
import { createInMemoryHubStorage, createInMemoryThoughtStore } from './test-helpers.js';

describe('Hub Storage — Filesystem Persistence', () => {
  let dataDir: string;
  let thoughtStore: ReturnType<typeof createInMemoryThoughtStore>;

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'hub-storage-'));
    thoughtStore = createInMemoryThoughtStore();
  });

  afterEach(async () => {
    await rm(dataDir, { recursive: true, force: true });
  });

  // T-STOR-1: Workspace persisted to filesystem
  it('workspace persisted to filesystem', async () => {
    const storage = createFileSystemHubStorage(dataDir);
    const identity = createIdentityManager(storage);
    const workspace = createWorkspaceManager(storage, thoughtStore);

    const reg = await identity.register({ name: 'alice' });
    const ws = await workspace.createWorkspace(reg.agentId, { name: 'test', description: '...' });

    const filePath = join(dataDir, 'hub', 'workspaces', ws.workspaceId, 'workspace.json');
    const content = JSON.parse(await readFile(filePath, 'utf-8'));
    expect(content.name).toBe('test');
    expect(content.id).toBe(ws.workspaceId);
  });

  // T-STOR-2: Problem persisted to filesystem
  it('problem persisted to filesystem', async () => {
    const storage = createFileSystemHubStorage(dataDir);
    const identity = createIdentityManager(storage);
    const workspace = createWorkspaceManager(storage, thoughtStore);
    const problems = createProblemsManager(storage, thoughtStore);

    const reg = await identity.register({ name: 'alice' });
    const ws = await workspace.createWorkspace(reg.agentId, { name: 'test', description: '...' });
    const prob = await problems.createProblem(reg.agentId, {
      workspaceId: ws.workspaceId,
      title: 'test problem',
      description: '...',
    });

    const filePath = join(dataDir, 'hub', 'workspaces', ws.workspaceId, 'problems', `${prob.problemId}.json`);
    const content = JSON.parse(await readFile(filePath, 'utf-8'));
    expect(content.title).toBe('test problem');
    expect(content.id).toBe(prob.problemId);
  });

  // T-STOR-3: Channel persisted to filesystem — messages land in the
  // crash-safe per-file directory, not a whole-file rewrite of the channel.
  it('channel message persisted as its own file under the channel directory', async () => {
    const storage = createFileSystemHubStorage(dataDir);
    const identity = createIdentityManager(storage);
    const workspace = createWorkspaceManager(storage, thoughtStore);
    const problems = createProblemsManager(storage, thoughtStore);
    const channels = createChannelsManager(storage);

    const reg = await identity.register({ name: 'alice' });
    const ws = await workspace.createWorkspace(reg.agentId, { name: 'test', description: '...' });
    const prob = await problems.createProblem(reg.agentId, {
      workspaceId: ws.workspaceId,
      title: 'test',
      description: '...',
    });
    await channels.postMessage(reg.agentId, {
      workspaceId: ws.workspaceId,
      problemId: prob.problemId,
      content: 'hello',
    });

    // The metadata file created at problem-creation time is untouched by the
    // append — it still holds the empty array it was saved with.
    const metaPath = join(dataDir, 'hub', 'workspaces', ws.workspaceId, 'channels', `${prob.problemId}.json`);
    const meta = JSON.parse(await readFile(metaPath, 'utf-8'));
    expect(meta.messages).toEqual([]);

    // The message itself is a standalone file under the channel's directory.
    const messagesDir = join(dataDir, 'hub', 'workspaces', ws.workspaceId, 'channels', prob.problemId);
    const files = await readdir(messagesDir);
    expect(files).toEqual(['000001.json']);
    const messageContent = JSON.parse(await readFile(join(messagesDir, files[0]), 'utf-8'));
    expect(messageContent.content).toBe('hello');

    // No temp files left behind after a successful write.
    expect(files.some(f => f.includes('.tmp'))).toBe(false);

    // The public API still reports one merged message.
    const channel = await storage.getChannel(ws.workspaceId, prob.problemId);
    expect(channel!.messages).toHaveLength(1);
    expect(channel!.messages[0].content).toBe('hello');
  });

  // Crash-safety contract: a channel written entirely by the pre-split code
  // path (embedded `messages` array, no per-file directory) must still read
  // correctly with no migration step.
  it('a legacy whole-file channel (embedded messages, no message directory) still reads', async () => {
    const storage = createFileSystemHubStorage(dataDir);
    const channelPath = join(dataDir, 'hub', 'workspaces', 'ws-legacy', 'channels', 'prob-legacy.json');
    await mkdir(dirname(channelPath), { recursive: true });
    await writeFile(
      channelPath,
      JSON.stringify({
        id: 'prob-legacy',
        workspaceId: 'ws-legacy',
        problemId: 'prob-legacy',
        messages: [
          { id: 'm1', agentId: 'agent-1', content: 'legacy msg 1', timestamp: '2026-01-01T00:00:00.000Z' },
          { id: 'm2', agentId: 'agent-2', content: 'legacy msg 2', timestamp: '2026-01-01T00:00:01.000Z' },
        ],
      }),
      'utf-8',
    );

    const channel = await storage.getChannel('ws-legacy', 'prob-legacy');
    expect(channel).not.toBeNull();
    expect(channel!.messages).toHaveLength(2);
    expect(channel!.messages.map(m => m.content)).toEqual(['legacy msg 1', 'legacy msg 2']);

    // Appending after the legacy read works and lands after the legacy history.
    const count = await storage.appendMessage('ws-legacy', 'prob-legacy', {
      id: 'm3',
      agentId: 'agent-1',
      content: 'new msg after legacy',
      timestamp: new Date().toISOString(),
    });
    expect(count).toBe(3);

    const reloaded = await storage.getChannel('ws-legacy', 'prob-legacy');
    expect(reloaded!.messages).toHaveLength(3);
    expect(reloaded!.messages.map(m => m.content)).toEqual([
      'legacy msg 1',
      'legacy msg 2',
      'new msg after legacy',
    ]);
  });

  // Known issue #4: channel read/write key symmetry, enforced at the storage boundary
  it('channel round-trips through the problemId key regardless of construction', async () => {
    const storage = createFileSystemHubStorage(dataDir);

    await storage.saveChannel({
      id: 'prob-1',
      workspaceId: 'ws-1',
      problemId: 'prob-1',
      messages: [],
    });

    const filePath = join(dataDir, 'hub', 'workspaces', 'ws-1', 'channels', 'prob-1.json');
    const content = JSON.parse(await readFile(filePath, 'utf-8'));
    expect(content.problemId).toBe('prob-1');

    const loaded = await storage.getChannel('ws-1', 'prob-1');
    expect(loaded).not.toBeNull();
    expect(loaded!.problemId).toBe('prob-1');

    // The write key comes from problemId, so appends find their own channel.
    const count = await storage.appendMessage('ws-1', 'prob-1', {
      id: 'msg-1',
      agentId: 'agent-1',
      content: 'hello',
      timestamp: new Date().toISOString(),
    });
    expect(count).toBe(1);
    expect((await storage.getChannel('ws-1', 'prob-1'))!.messages).toHaveLength(1);
  });

  it('saveChannel rejects a channel whose id does not match its problemId', async () => {
    const storage = createFileSystemHubStorage(dataDir);

    await expect(
      storage.saveChannel({
        id: 'minted-elsewhere',
        workspaceId: 'ws-1',
        problemId: 'prob-1',
        messages: [],
      }),
    ).rejects.toThrow('Channel id must equal its problemId');

    // Nothing was written under either key.
    expect(await storage.getChannel('ws-1', 'prob-1')).toBeNull();
    expect(await storage.getChannel('ws-1', 'minted-elsewhere')).toBeNull();
  });

  // T-STOR-4: Agents registry persisted
  it('agents registry persisted to filesystem', async () => {
    const storage = createFileSystemHubStorage(dataDir);
    const identity = createIdentityManager(storage);

    await identity.register({ name: 'alice' });

    const filePath = join(dataDir, 'hub', 'agents.json');
    const content = JSON.parse(await readFile(filePath, 'utf-8'));
    expect(Array.isArray(content)).toBe(true);
    expect(content.some((a: any) => a.name === 'alice')).toBe(true);
  });

  // T-STOR-5: Hub state survives reload
  it('hub state survives reload from a new storage instance', async () => {
    const storageA = createFileSystemHubStorage(dataDir);
    const identityA = createIdentityManager(storageA);
    const workspaceA = createWorkspaceManager(storageA, thoughtStore);
    const problemsA = createProblemsManager(storageA, thoughtStore);
    const proposalsA = createProposalsManager(storageA, thoughtStore);
    const channelsA = createChannelsManager(storageA);

    const alice = await identityA.register({ name: 'alice' });
    const bob = await identityA.register({ name: 'bob' });
    const ws = await workspaceA.createWorkspace(alice.agentId, { name: 'persistent', description: '...' });
    await workspaceA.joinWorkspace(bob.agentId, { workspaceId: ws.workspaceId });

    // Create problem (also creates channel)
    const prob = await problemsA.createProblem(alice.agentId, {
      workspaceId: ws.workspaceId,
      title: 'survive reload',
      description: '...',
    });

    // Post a message to the channel
    await channelsA.postMessage(alice.agentId, {
      workspaceId: ws.workspaceId,
      problemId: prob.problemId,
      content: 'persisted message',
    });

    // Create proposal
    await proposalsA.createProposal(bob.agentId, {
      workspaceId: ws.workspaceId,
      title: 'reload proposal',
      description: 'should survive',
      sourceBranch: 'test-branch',
      problemId: prob.problemId,
    });

    // Create new storage instance B pointing at same directory
    const storageB = createFileSystemHubStorage(dataDir);

    const loadedWorkspace = await storageB.getWorkspace(ws.workspaceId);
    expect(loadedWorkspace).not.toBeNull();
    expect(loadedWorkspace!.name).toBe('persistent');

    const loadedProblems = await storageB.listProblems(ws.workspaceId);
    expect(loadedProblems).toHaveLength(1);
    expect(loadedProblems[0].title).toBe('survive reload');

    const loadedProposals = await storageB.listProposals(ws.workspaceId);
    expect(loadedProposals).toHaveLength(1);
    expect(loadedProposals[0].title).toBe('reload proposal');
    expect(loadedProposals[0].sourceBranch).toBe('test-branch');

    const loadedChannel = await storageB.getChannel(ws.workspaceId, prob.problemId);
    expect(loadedChannel).not.toBeNull();
    expect(loadedChannel!.messages).toHaveLength(1);
    expect(loadedChannel!.messages[0].content).toBe('persisted message');
  });

  it('sequential channel messages persist as one file each, in append order', async () => {
    const storage = createFileSystemHubStorage(dataDir);
    const identity = createIdentityManager(storage);
    const workspace = createWorkspaceManager(storage, thoughtStore);
    const problems = createProblemsManager(storage, thoughtStore);
    const channels = createChannelsManager(storage);

    const reg = await identity.register({ name: 'alice' });
    const ws = await workspace.createWorkspace(reg.agentId, { name: 'test', description: '...' });
    const prob = await problems.createProblem(reg.agentId, {
      workspaceId: ws.workspaceId,
      title: 'test',
      description: '...',
    });

    for (const content of ['one', 'two', 'three']) {
      await channels.postMessage(reg.agentId, { workspaceId: ws.workspaceId, problemId: prob.problemId, content });
    }

    const messagesDir = join(dataDir, 'hub', 'workspaces', ws.workspaceId, 'channels', prob.problemId);
    const files = (await readdir(messagesDir)).sort();
    expect(files).toEqual(['000001.json', '000002.json', '000003.json']);

    const channel = await storage.getChannel(ws.workspaceId, prob.problemId);
    expect(channel!.messages.map(m => m.content)).toEqual(['one', 'two', 'three']);
  });
});

// A crash mid-write must leave either the old file or the new one — never a
// truncated hybrid. writeJson goes through a temp file + rename for exactly
// this reason; these tests check the observable trace of that discipline
// (no stray temp files, no interleaved content from concurrent writers)
// rather than injecting a real process kill, which vitest cannot do mid-await.
describe('Hub Storage — Atomic Writes Leave No Partial State', () => {
  let dataDir: string;

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'hub-atomic-'));
  });

  afterEach(async () => {
    await rm(dataDir, { recursive: true, force: true });
  });

  it('concurrent writes to the same workspace file never produce corrupt JSON', async () => {
    const storage = createFileSystemHubStorage(dataDir);
    const base = {
      id: 'ws-race',
      name: 'race',
      description: '...',
      createdBy: 'a',
      mainSessionId: 's',
      agents: [],
      createdAt: '',
      updatedAt: '',
    };

    // Ten concurrent writers racing on the same file. Without temp-file +
    // rename, an interleaved writeFile could leave the file with bytes from
    // two different JSON.stringify calls spliced together — unparseable.
    await Promise.all(
      Array.from({ length: 10 }, (_, i) => storage.saveWorkspace({ ...base, name: `race-${i}` } as any)),
    );

    const filePath = join(dataDir, 'hub', 'workspaces', 'ws-race', 'workspace.json');
    const raw = await readFile(filePath, 'utf-8');
    // Must parse cleanly and be exactly one of the ten writers' payloads —
    // a lost update under concurrency is the documented tradeoff (no
    // locking, single-process only); a corrupt splice is not.
    const parsed = JSON.parse(raw);
    expect(parsed.name).toMatch(/^race-\d$/);

    const dir = await readdir(join(dataDir, 'hub', 'workspaces', 'ws-race'));
    expect(dir.some(f => f.includes('.tmp'))).toBe(false);
  });

  it('a normal write leaves no temp file behind in the target directory', async () => {
    const storage = createFileSystemHubStorage(dataDir);
    await storage.saveWorkspace({
      id: 'ws-clean',
      name: 'clean',
      description: '...',
      createdBy: 'a',
      mainSessionId: 's',
      agents: [],
      createdAt: '',
      updatedAt: '',
    } as any);

    const dir = await readdir(join(dataDir, 'hub', 'workspaces', 'ws-clean'));
    expect(dir).toEqual(['workspace.json']);
  });
});

// The in-memory double is what most hub tests run against, so it has to reject
// the same illegal channels the filesystem implementation does — otherwise a
// test can pass behavior that throws in production.
describe('Hub Storage — In-Memory Double Honors The saveChannel Contract', () => {
  it('saveChannel rejects a channel whose id does not match its problemId', async () => {
    const storage = createInMemoryHubStorage();

    await expect(
      storage.saveChannel({
        id: 'minted-elsewhere',
        workspaceId: 'ws-1',
        problemId: 'prob-1',
        messages: [],
      }),
    ).rejects.toThrow('Channel id must equal its problemId');

    // Nothing was stored under either key.
    expect(await storage.getChannel('ws-1', 'prob-1')).toBeNull();
    expect(await storage.getChannel('ws-1', 'minted-elsewhere')).toBeNull();
  });

  it('saveChannel round-trips a channel whose id equals its problemId', async () => {
    const storage = createInMemoryHubStorage();

    await storage.saveChannel({
      id: 'prob-1',
      workspaceId: 'ws-1',
      problemId: 'prob-1',
      messages: [],
    });

    const loaded = await storage.getChannel('ws-1', 'prob-1');
    expect(loaded).not.toBeNull();
    expect(loaded!.id).toBe('prob-1');
  });
});

// A file that exists but cannot be parsed is a different event from a file
// that is absent, and only the first one means data is being dropped. The
// list* readers discard nulls, so without a log line a corrupt problem or
// proposal disappears from list_problems and workspace_digest in silence.
describe('Hub Storage — Unreadable Files Are Reported, Not Swallowed', () => {
  let dataDir: string;
  let warn: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'hub-corrupt-'));
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(async () => {
    warn.mockRestore();
    await rm(dataDir, { recursive: true, force: true });
  });

  it('listProblems warns with the file path when a problem file is corrupt', async () => {
    const storage = createFileSystemHubStorage(dataDir);
    const problemsDir = join(dataDir, 'hub', 'workspaces', 'ws-1', 'problems');
    await mkdir(problemsDir, { recursive: true });

    const goodPath = join(problemsDir, 'prob-good.json');
    const badPath = join(problemsDir, 'prob-bad.json');
    await writeFile(goodPath, JSON.stringify({
      id: 'prob-good', workspaceId: 'ws-1', title: 'readable', description: '',
      createdBy: 'a', status: 'open', comments: [], createdAt: '', updatedAt: '',
    }), 'utf-8');
    // Truncated mid-object — exactly what a crashed write leaves behind.
    await writeFile(badPath, '{"id":"prob-bad","workspaceId":"ws-1","tit', 'utf-8');

    const problems = await storage.listProblems('ws-1');

    // The corrupt record is still dropped from the list — the fix is that the
    // drop is now audible.
    expect(problems.map(p => p.id)).toEqual(['prob-good']);
    expect(warn).toHaveBeenCalled();
    const logged = warn.mock.calls.map(c => c.map(String).join(' ')).join('\n');
    expect(logged).toContain(badPath);
    expect(logged).not.toContain(goodPath);
  });

  it('a missing file stays silent — absence is a normal read outcome', async () => {
    const storage = createFileSystemHubStorage(dataDir);

    expect(await storage.getProblem('ws-nope', 'prob-nope')).toBeNull();
    expect(await storage.getWorkspace('ws-nope')).toBeNull();
    expect(await storage.getAgents()).toEqual([]);

    expect(warn).not.toHaveBeenCalled();
  });

  it('getProposal warns when the file exists but is unreadable', async () => {
    const storage = createFileSystemHubStorage(dataDir);
    const proposalsDir = join(dataDir, 'hub', 'workspaces', 'ws-1', 'proposals');
    await mkdir(proposalsDir, { recursive: true });
    const path = join(proposalsDir, 'prop-1.json');
    await writeFile(path, 'not json at all', 'utf-8');

    expect(await storage.getProposal('ws-1', 'prop-1')).toBeNull();
    const logged = warn.mock.calls.map(c => c.map(String).join(' ')).join('\n');
    expect(logged).toContain(path);
  });

  // An unreadable-for-any-other-reason record. EISDIR is used rather than a
  // chmod-based EACCES because chmod is a no-op for root, which would make
  // this pass locally and vanish silently in a root container.
  it('an unreadable (non-corrupt) record warns rather than reporting absence', async () => {
    const storage = createFileSystemHubStorage(dataDir);
    const path = join(dataDir, 'hub', 'workspaces', 'ws-odd', 'workspace.json');
    await mkdir(path, { recursive: true });

    expect(await storage.getWorkspace('ws-odd')).toBeNull();
    const logged = warn.mock.calls.map(c => c.map(String).join(' ')).join('\n');
    expect(logged).toContain(path);
  });
});

// The directory-level twin of the above. A record that cannot be read drops
// one item; a directory that cannot be listed drops the entire collection, so
// list_problems returning [] can mean "none" or "all of them, invisibly".
describe('Hub Storage — Unlistable Directories Are Reported, Not Swallowed', () => {
  let dataDir: string;
  let warn: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'hub-unlistable-'));
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(async () => {
    warn.mockRestore();
    await rm(dataDir, { recursive: true, force: true });
  });

  // A plain file where a directory belongs makes readdir fail ENOTDIR on
  // every platform and for every user, unlike a chmod-based EACCES.
  async function blockDir(...segments: string[]): Promise<string> {
    const path = join(dataDir, 'hub', ...segments);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, 'not a directory', 'utf-8');
    return path;
  }

  const logged = () => warn.mock.calls.map(c => c.map(String).join(' ')).join('\n');

  it('listProblems warns when the problems directory cannot be listed', async () => {
    const path = await blockDir('workspaces', 'ws-1', 'problems');
    const storage = createFileSystemHubStorage(dataDir);

    expect(await storage.listProblems('ws-1')).toEqual([]);
    expect(logged()).toContain(path);
  });

  it('listProposals warns when the proposals directory cannot be listed', async () => {
    const path = await blockDir('workspaces', 'ws-1', 'proposals');
    const storage = createFileSystemHubStorage(dataDir);

    expect(await storage.listProposals('ws-1')).toEqual([]);
    expect(logged()).toContain(path);
  });

  it('listConsensusMarkers warns when the consensus directory cannot be listed', async () => {
    const path = await blockDir('workspaces', 'ws-1', 'consensus');
    const storage = createFileSystemHubStorage(dataDir);

    expect(await storage.listConsensusMarkers('ws-1')).toEqual([]);
    expect(logged()).toContain(path);
  });

  it('listWorkspaces warns when the workspaces root cannot be listed', async () => {
    const path = await blockDir('workspaces');
    const storage = createFileSystemHubStorage(dataDir);

    expect(await storage.listWorkspaces()).toEqual([]);
    expect(logged()).toContain(path);
  });

  it('an absent directory stays silent — a first run has none of these', async () => {
    const storage = createFileSystemHubStorage(dataDir);

    expect(await storage.listProblems('ws-none')).toEqual([]);
    expect(await storage.listProposals('ws-none')).toEqual([]);
    expect(await storage.listConsensusMarkers('ws-none')).toEqual([]);
    expect(await storage.listWorkspaces()).toEqual([]);

    expect(warn).not.toHaveBeenCalled();
  });
});
