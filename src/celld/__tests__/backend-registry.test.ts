/**
 * Workspace backend routing registry (RFC 0001: crash-safe routing index,
 * "a retry resumes the same workspace and command"). Real filesystem, per-
 * test temp dirs — mirrors src/hub/__tests__/storage.test.ts.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createBackendRegistry } from '../backend-registry.js';
import { CelldError } from '../errors.js';

describe('createBackendRegistry', () => {
  let dataDir: string;

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'celld-backend-registry-'));
  });

  afterEach(async () => {
    await rm(dataDir, { recursive: true, force: true });
  });

  it('fresh create: beginProvisioning writes a provisioning route to disk', async () => {
    const registry = createBackendRegistry(dataDir);

    const route = await registry.beginProvisioning('ws-1', 'cmd-1');

    expect(route).toMatchObject({
      workspaceId: 'ws-1',
      backend: 'celld',
      status: 'provisioning',
      commandId: 'cmd-1',
    });
    expect(typeof route.createdAt).toBe('string');
    expect(route.activatedAt).toBeUndefined();

    expect(await registry.get('ws-1')).toEqual(route);

    const filePath = join(dataDir, 'hub', 'workspace-backends.json');
    const onDisk = JSON.parse(await readFile(filePath, 'utf-8'));
    expect(onDisk).toEqual({ version: 1, routes: { 'ws-1': route } });
  });

  it('same-commandId resume returns the identical route after a simulated crash', async () => {
    const first = createBackendRegistry(dataDir);
    const original = await first.beginProvisioning('ws-1', 'cmd-1');

    // A fresh registry instance over the same data dir simulates the
    // process restarting after a crash — nothing is cached in memory.
    const second = createBackendRegistry(dataDir);
    const resumed = await second.beginProvisioning('ws-1', 'cmd-1');

    expect(resumed).toEqual(original);
  });

  it('a different commandId for an already-provisioning workspace is rejected VALIDATION_FAILED', async () => {
    const registry = createBackendRegistry(dataDir);
    await registry.beginProvisioning('ws-1', 'cmd-1');

    const err = await registry.beginProvisioning('ws-1', 'cmd-2').catch((e: unknown) => e);

    expect(err).toBeInstanceOf(CelldError);
    expect((err as CelldError).code).toBe('VALIDATION_FAILED');
    expect((err as CelldError).message).toContain('cmd-1');
    expect((err as CelldError).message).toContain('cmd-2');
    expect((err as CelldError).details).toMatchObject({ existingCommandId: 'cmd-1', requestedCommandId: 'cmd-2' });

    // The original route is untouched.
    expect(await registry.get('ws-1')).toMatchObject({ commandId: 'cmd-1', status: 'provisioning' });
  });

  it('markActive transitions provisioning -> active and is idempotent once active', async () => {
    const registry = createBackendRegistry(dataDir);
    await registry.beginProvisioning('ws-1', 'cmd-1');

    await registry.markActive('ws-1');
    const activated = await registry.get('ws-1');
    expect(activated?.status).toBe('active');
    expect(typeof activated?.activatedAt).toBe('string');

    // Idempotent no-op: calling again does not change activatedAt.
    await registry.markActive('ws-1');
    const activatedAgain = await registry.get('ws-1');
    expect(activatedAgain?.activatedAt).toBe(activated?.activatedAt);
  });

  it('markActive on a missing route throws NOT_FOUND', async () => {
    const registry = createBackendRegistry(dataDir);

    const err = await registry.markActive('ws-nope').catch((e: unknown) => e);

    expect(err).toBeInstanceOf(CelldError);
    expect((err as CelldError).code).toBe('NOT_FOUND');
    expect((err as CelldError).message).toContain('ws-nope');
  });

  it('a missing registry file reads as an empty registry', async () => {
    const registry = createBackendRegistry(dataDir);

    expect(await registry.get('ws-1')).toBeUndefined();
    expect(await registry.list()).toEqual([]);
    expect(await registry.findByCommandId('cmd-1')).toBeUndefined();
  });

  it('a corrupt registry file throws loudly, naming the file', async () => {
    const hubDir = join(dataDir, 'hub');
    await mkdir(hubDir, { recursive: true });
    const filePath = join(hubDir, 'workspace-backends.json');
    await writeFile(filePath, '{"version":1,"routes":{', 'utf-8');

    const registry = createBackendRegistry(dataDir);

    const err = await registry.get('ws-1').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain(filePath);
  });

  it('list() and findByCommandId() see routes created by beginProvisioning', async () => {
    const registry = createBackendRegistry(dataDir);
    await registry.beginProvisioning('ws-1', 'cmd-1');
    await registry.beginProvisioning('ws-2', 'cmd-2');

    const list = await registry.list();
    expect(list.map(r => r.workspaceId).sort()).toEqual(['ws-1', 'ws-2']);

    const found = await registry.findByCommandId('cmd-2');
    expect(found?.workspaceId).toBe('ws-2');
    expect(await registry.findByCommandId('cmd-missing')).toBeUndefined();
  });

  it('concurrent beginProvisioning for different workspaces both survive the serialization chain', async () => {
    const registry = createBackendRegistry(dataDir);

    const [routeA, routeB] = await Promise.all([
      registry.beginProvisioning('ws-a', 'cmd-a'),
      registry.beginProvisioning('ws-b', 'cmd-b'),
    ]);

    expect(routeA.workspaceId).toBe('ws-a');
    expect(routeB.workspaceId).toBe('ws-b');

    const list = await registry.list();
    expect(list.map(r => r.workspaceId).sort()).toEqual(['ws-a', 'ws-b']);
    expect(await registry.get('ws-a')).toEqual(routeA);
    expect(await registry.get('ws-b')).toEqual(routeB);
  });
});
