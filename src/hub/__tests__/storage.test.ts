import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
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

  // T-STOR-3: Channel persisted to filesystem
  it('channel persisted to filesystem after message', async () => {
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

    const filePath = join(dataDir, 'hub', 'workspaces', ws.workspaceId, 'channels', `${prob.problemId}.json`);
    const content = JSON.parse(await readFile(filePath, 'utf-8'));
    expect(content.messages).toHaveLength(1);
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
