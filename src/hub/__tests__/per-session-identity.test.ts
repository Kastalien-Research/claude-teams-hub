/**
 * M10: Per-Session Agent Identity — isolation tests
 *
 * Verifies that HubToolHandler correctly isolates agent identity per MCP session,
 * so multiple concurrent sessions sharing one handler instance cannot see each
 * other's registered identity.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { createHubToolHandler, type HubToolHandler } from '../hub-tool-handler.js';
import { createInMemoryHubStorage, createInMemoryThoughtStore } from './test-helpers.js';
import type { HubStorage } from '../hub-types.js';

describe('HubToolHandler — Per-Session Identity Isolation', () => {
  let hubStorage: HubStorage;
  let handler: HubToolHandler;

  beforeEach(() => {
    hubStorage = createInMemoryHubStorage();
    const thoughtStore = createInMemoryThoughtStore();
    handler = createHubToolHandler({
      hubStorage,
      thoughtStore,
      // No env vars — forces explicit registration per session
    });
  });

  it('two sessions registering different names get distinct agentIds', async () => {
    // Session A registers as "Alpha"
    const regA = await handler.handle(
      { operation: 'register', name: 'Alpha' },
      'session-aaa',
    );
    const dataA = JSON.parse(regA.content[0].text);
    expect(dataA.agentId).toBeDefined();
    expect(dataA.name).toBe('Alpha');

    // Session B registers as "Beta"
    const regB = await handler.handle(
      { operation: 'register', name: 'Beta' },
      'session-bbb',
    );
    const dataB = JSON.parse(regB.content[0].text);
    expect(dataB.agentId).toBeDefined();
    expect(dataB.name).toBe('Beta');

    // Distinct IDs
    expect(dataA.agentId).not.toBe(dataB.agentId);
  });

  it('whoami returns session-specific identity after registration', async () => {
    // Register in two sessions
    await handler.handle(
      { operation: 'register', name: 'Alpha' },
      'session-aaa',
    );
    await handler.handle(
      { operation: 'register', name: 'Beta' },
      'session-bbb',
    );

    // whoami in session A should return Alpha
    const whoamiA = await handler.handle(
      { operation: 'whoami' },
      'session-aaa',
    );
    const dataA = JSON.parse(whoamiA.content[0].text);
    expect(dataA.name).toBe('Alpha');

    // whoami in session B should return Beta
    const whoamiB = await handler.handle(
      { operation: 'whoami' },
      'session-bbb',
    );
    const dataB = JSON.parse(whoamiB.content[0].text);
    expect(dataB.name).toBe('Beta');

    // Verify distinct agent IDs
    expect(dataA.agentId).not.toBe(dataB.agentId);
  });

  it('session without registration returns register-required error', async () => {
    // Register only in session A
    await handler.handle(
      { operation: 'register', name: 'Alpha' },
      'session-aaa',
    );

    // Session B has not registered — whoami should fail
    const whoamiB = await handler.handle(
      { operation: 'whoami' },
      'session-bbb',
    );
    expect(whoamiB.isError).toBe(true);
    const errData = JSON.parse(whoamiB.content[0].text);
    expect(errData.error).toMatch(/register/i);
  });

  it('no session ID falls back to __default__ key', async () => {
    // Register without explicit session ID
    const reg = await handler.handle(
      { operation: 'register', name: 'Default' },
    );
    const data = JSON.parse(reg.content[0].text);
    expect(data.agentId).toBeDefined();

    // whoami without session ID uses same __default__ key
    const whoami = await handler.handle({ operation: 'whoami' });
    const whoamiData = JSON.parse(whoami.content[0].text);
    expect(whoamiData.agentId).toBe(data.agentId);
    expect(whoamiData.name).toBe('Default');
  });

  it('session identity does not leak to default key', async () => {
    // Register as Alpha in session-aaa
    await handler.handle(
      { operation: 'register', name: 'Alpha' },
      'session-aaa',
    );

    // whoami without session ID should fail (no default registration)
    const whoami = await handler.handle({ operation: 'whoami' });
    expect(whoami.isError).toBe(true);
  });

  it('three sessions collaborate with correct attribution', async () => {
    // Register three agents in three sessions
    const regAlpha = await handler.handle(
      { operation: 'register', name: 'Alpha' },
      'sess-1',
    );
    const regBeta = await handler.handle(
      { operation: 'register', name: 'Beta' },
      'sess-2',
    );
    const regGamma = await handler.handle(
      { operation: 'register', name: 'Gamma' },
      'sess-3',
    );

    const alphaId = JSON.parse(regAlpha.content[0].text).agentId;
    const betaId = JSON.parse(regBeta.content[0].text).agentId;
    const gammaId = JSON.parse(regGamma.content[0].text).agentId;

    // Alpha creates workspace
    const wsResult = await handler.handle(
      { operation: 'create_workspace', name: 'M10-test', description: 'Testing per-session isolation' },
      'sess-1',
    );
    const wsId = JSON.parse(wsResult.content[0].text).workspaceId;

    // Beta and Gamma join
    await handler.handle(
      { operation: 'join_workspace', workspaceId: wsId },
      'sess-2',
    );
    await handler.handle(
      { operation: 'join_workspace', workspaceId: wsId },
      'sess-3',
    );

    // Alpha creates a problem
    const probResult = await handler.handle(
      { operation: 'create_problem', workspaceId: wsId, title: 'Test attribution', description: 'Verify each agent message is attributed correctly' },
      'sess-1',
    );
    const probId = JSON.parse(probResult.content[0].text).problemId;

    // Each agent posts a message
    await handler.handle(
      { operation: 'post_message', workspaceId: wsId, problemId: probId, content: 'Message from Alpha' },
      'sess-1',
    );
    await handler.handle(
      { operation: 'post_message', workspaceId: wsId, problemId: probId, content: 'Message from Beta' },
      'sess-2',
    );
    await handler.handle(
      { operation: 'post_message', workspaceId: wsId, problemId: probId, content: 'Message from Gamma' },
      'sess-3',
    );

    // Read channel from any session — all messages should be attributed correctly
    const channelResult = await handler.handle(
      { operation: 'read_channel', workspaceId: wsId, problemId: probId },
      'sess-1',
    );
    const channelData = JSON.parse(channelResult.content[0].text);
    const messages = channelData.messages;

    expect(messages).toHaveLength(3);

    // Verify each message is attributed to the correct agent
    const alphaMsg = messages.find((m: any) => m.content === 'Message from Alpha');
    const betaMsg = messages.find((m: any) => m.content === 'Message from Beta');
    const gammaMsg = messages.find((m: any) => m.content === 'Message from Gamma');

    expect(alphaMsg.agentId).toBe(alphaId);
    expect(betaMsg.agentId).toBe(betaId);
    expect(gammaMsg.agentId).toBe(gammaId);

    // Verify workspace shows 3 members
    const wsStatus = await handler.handle(
      { operation: 'workspace_status', workspaceId: wsId },
      'sess-1',
    );
    const statusData = JSON.parse(wsStatus.content[0].text);
    expect(statusData.agents).toHaveLength(3);

    // Verify distinct agent IDs in agents list
    const memberIds = statusData.agents.map((m: any) => m.agentId);
    expect(new Set(memberIds).size).toBe(3);
    expect(memberIds).toContain(alphaId);
    expect(memberIds).toContain(betaId);
    expect(memberIds).toContain(gammaId);
  });

  // Known-issue #1: this is the exact defect layer — the tool handler passed
  // agentId null for every quick_join, so the hub handler could not see the
  // session's identity and registered a fresh agent each time. The session's
  // second quick_join must act as the session default, not as a new agent.
  it('a second quick_join in one session reuses the session identity, not an orphan', async () => {
    const coordReg = await handler.handle(
      { operation: 'register', name: 'Coordinator' },
      'sess-coord',
    );
    const coordId = JSON.parse(coordReg.content[0].text).agentId;
    const ws1 = await handler.handle(
      { operation: 'create_workspace', name: 'WS1', description: 'first' },
      'sess-coord',
    );
    const ws1Id = JSON.parse(ws1.content[0].text).workspaceId;
    const ws2 = await handler.handle(
      { operation: 'create_workspace', name: 'WS2', description: 'second' },
      'sess-coord',
    );
    const ws2Id = JSON.parse(ws2.content[0].text).workspaceId;
    expect(coordId).toBeDefined();

    const join1 = await handler.handle(
      { operation: 'quick_join', name: 'Bob', workspaceId: ws1Id },
      'sess-bob',
    );
    const bobId = JSON.parse(join1.content[0].text).agentId;

    const join2 = await handler.handle(
      { operation: 'quick_join', name: 'Bob', workspaceId: ws2Id },
      'sess-bob',
    );
    const rejoined = JSON.parse(join2.content[0].text);
    expect(rejoined.agentId).toBe(bobId);

    // whoami still resolves to the same agent, and bob can act in WS2.
    const who = await handler.handle({ operation: 'whoami' }, 'sess-bob');
    expect(JSON.parse(who.content[0].text).agentId).toBe(bobId);
    const listed = await handler.handle(
      { operation: 'list_proposals', workspaceId: ws2Id },
      'sess-bob',
    );
    expect(listed.isError ?? false).toBe(false);

    // Exactly one 'Bob' exists in the store — no orphan.
    const bobs = (await hubStorage.getAgents()).filter((a) => a.name === 'Bob');
    expect(bobs).toHaveLength(1);
  });

  // Known-issue #5: the resolve → register → capture window spans an await, so
  // two concurrent FIRST registrations in one session both saw a null default
  // and both minted an agent; only the first-completed became the implicit
  // identity and the other caller's implicit calls silently acted as it. The
  // fix serializes registration per sessionKey in the tool handler. Contract:
  // acquisition order is call order, so the FIRST-INITIATED registration is
  // the session default, and every later one observes it.
  describe('concurrent registration in one session', () => {
    let coordSession: string;
    let ws1Id: string;
    let ws2Id: string;

    beforeEach(async () => {
      coordSession = 'sess-coord';
      await handler.handle({ operation: 'register', name: 'Coordinator' }, coordSession);
      const ws1 = await handler.handle(
        { operation: 'create_workspace', name: 'WS1', description: 'first' },
        coordSession,
      );
      ws1Id = JSON.parse(ws1.content[0].text).workspaceId;
      const ws2 = await handler.handle(
        { operation: 'create_workspace', name: 'WS2', description: 'second' },
        coordSession,
      );
      ws2Id = JSON.parse(ws2.content[0].text).workspaceId;
    });

    it('two concurrent same-name quick_joins mint one agent, not two', async () => {
      const [first, second] = await Promise.all([
        handler.handle({ operation: 'quick_join', name: 'Bob', workspaceId: ws1Id }, 'sess-bob'),
        handler.handle({ operation: 'quick_join', name: 'Bob', workspaceId: ws2Id }, 'sess-bob'),
      ]);
      const firstData = JSON.parse(first.content[0].text);
      const secondData = JSON.parse(second.content[0].text);

      // Unfixed, these were two different agents and two 'Bob' rows.
      expect(secondData.agentId).toBe(firstData.agentId);
      expect((await hubStorage.getAgents()).filter((a) => a.name === 'Bob')).toHaveLength(1);

      // Exactly one session default, and it is the first-initiated call's agent.
      const who = await handler.handle({ operation: 'whoami' }, 'sess-bob');
      expect(JSON.parse(who.content[0].text).agentId).toBe(firstData.agentId);

      // The second call's workspace membership is real: an IMPLICIT call
      // scoped to WS2 succeeds, where before it failed 'Not a member'.
      const listed = await handler.handle(
        { operation: 'list_proposals', workspaceId: ws2Id },
        'sess-bob',
      );
      expect(listed.isError ?? false).toBe(false);
    });

    it('two concurrent registers both land, and the first-initiated is the default', async () => {
      const [first, second] = await Promise.all([
        handler.handle({ operation: 'register', name: 'First' }, 'sess-two'),
        handler.handle({ operation: 'register', name: 'Second' }, 'sess-two'),
      ]);
      const firstId = JSON.parse(first.content[0].text).agentId;
      const secondId = JSON.parse(second.content[0].text).agentId;
      expect(secondId).not.toBe(firstId);

      // register always mints, so both agents exist and both are usable via an
      // explicit agentId — only the implicit identity is singular.
      const who = await handler.handle({ operation: 'whoami' }, 'sess-two');
      expect(JSON.parse(who.content[0].text).name).toBe('First');
      const explicit = await handler.handle(
        { operation: 'whoami', agentId: secondId },
        'sess-two',
      );
      expect(JSON.parse(explicit.content[0].text).name).toBe('Second');
    });

    it('a concurrent different-name quick_join mints a sub-agent and says the default is unchanged', async () => {
      const [first, second] = await Promise.all([
        handler.handle({ operation: 'quick_join', name: 'Lead', workspaceId: ws1Id }, 'sess-team'),
        handler.handle({ operation: 'quick_join', name: 'Sub-1', workspaceId: ws2Id }, 'sess-team'),
      ]);
      const leadData = JSON.parse(first.content[0].text);
      const subData = JSON.parse(second.content[0].text);

      // The sanctioned multi-agent flow (T-HTW-14) survives serialization: the
      // second call still mints, but now SEES the default and warns about it —
      // unfixed it resolved null and returned no note at all.
      expect(subData.agentId).not.toBe(leadData.agentId);
      expect(subData.note).toMatch(/default identity remains 'Lead'/);
      const who = await handler.handle({ operation: 'whoami' }, 'sess-team');
      expect(JSON.parse(who.content[0].text).agentId).toBe(leadData.agentId);
    });

    it('serializes per session key, not globally — concurrent sessions keep distinct defaults', async () => {
      const [a, b] = await Promise.all([
        handler.handle({ operation: 'register', name: 'Alpha' }, 'sess-a'),
        handler.handle({ operation: 'register', name: 'Beta' }, 'sess-b'),
      ]);
      const alphaId = JSON.parse(a.content[0].text).agentId;
      const betaId = JSON.parse(b.content[0].text).agentId;

      const whoA = await handler.handle({ operation: 'whoami' }, 'sess-a');
      const whoB = await handler.handle({ operation: 'whoami' }, 'sess-b');
      expect(JSON.parse(whoA.content[0].text).agentId).toBe(alphaId);
      expect(JSON.parse(whoB.content[0].text).agentId).toBe(betaId);
    });
  });
});
