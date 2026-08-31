/**
 * Workspace backend routing registry (RFC 0001: "`$HUB_DATA_DIR/hub/
 * workspace-backends.json` is a crash-safe routing/provisioning index only —
 * never workspace-state authority").
 *
 * Entries move provisioning → active, keyed by the creating caller's command
 * ID, so a crashed `create_workspace` retry resumes the same workspace and
 * command rather than racing a second creator into stealing it. This module
 * owns only that routing index; it has no opinion about cell state.
 *
 * Every write mirrors the fsynced-temp-file + atomic-rename pattern in
 * src/hub/hub-storage-fs.ts (`writeJson`): rename alone is not a durability
 * barrier, so the temp file's content is fsynced before the rename, and the
 * containing directory is best-effort fsynced after it so the rename itself
 * survives a crash.
 */

import { readFile, open, rename, unlink, mkdir } from 'node:fs/promises';
import { join, dirname, basename } from 'node:path';
import { randomUUID } from 'node:crypto';
import { CelldError, rejection } from './errors.js';

export interface WorkspaceRoute {
  workspaceId: string;
  backend: 'celld';
  status: 'provisioning' | 'active';
  commandId: string;
  createdAt: string;
  activatedAt?: string;
}

export interface BackendRegistry {
  get(workspaceId: string): Promise<WorkspaceRoute | undefined>;
  list(): Promise<WorkspaceRoute[]>;
  findByCommandId(commandId: string): Promise<WorkspaceRoute | undefined>;
  /**
   * Atomic find-or-create keyed by the creating command's ID. The command-ID
   * lookup and the route write happen inside ONE serialized section: two
   * concurrent first attempts with the same command ID resolve to the SAME
   * route even though each caller minted its own candidate workspace ID —
   * looking up outside the serialized section is exactly the race that
   * produced two active workspaces for one idempotency key.
   */
  findOrBeginProvisioning(commandId: string, candidateWorkspaceId: string): Promise<WorkspaceRoute>;
  markActive(workspaceId: string): Promise<void>;
}

interface RegistryDocument {
  version: 1;
  routes: Record<string, WorkspaceRoute>;
}

// =============================================================================
// Crash-safe file I/O (mirrors hub-storage-fs.ts writeJson)
// =============================================================================

async function ensureDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true });
}

async function fsyncDir(dir: string): Promise<void> {
  try {
    const handle = await open(dir, 'r');
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  } catch {
    // best-effort — some platforms/filesystems don't support fsync-ing a
    // directory handle; that does not mean the write itself failed.
  }
}

async function writeTempFile(dir: string, prefix: string, content: string): Promise<string> {
  await ensureDir(dir);
  const tmpPath = join(dir, `.${prefix}.${process.pid}.${randomUUID()}.tmp`);
  const handle = await open(tmpPath, 'w');
  try {
    await handle.writeFile(content, 'utf-8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  return tmpPath;
}

async function writeRegistryDocument(path: string, doc: RegistryDocument): Promise<void> {
  const dir = dirname(path);
  const tmpPath = await writeTempFile(dir, basename(path), JSON.stringify(doc, null, 2));
  try {
    await rename(tmpPath, path);
    await fsyncDir(dir);
  } catch (err) {
    await unlink(tmpPath).catch(() => {});
    throw err;
  }
}

/**
 * A missing file is a normal first-run outcome (empty registry). Any other
 * read failure — most importantly corrupt/truncated JSON, exactly what a
 * crashed write leaves behind if it landed outside the rename barrier above
 * — throws loudly naming the file, rather than silently returning an empty
 * registry that would let a second creator steal an already-provisioning
 * workspace.
 */
async function readRegistryDocument(path: string): Promise<RegistryDocument> {
  let content: string;
  try {
    content = await readFile(path, 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') {
      return { version: 1, routes: {} };
    }
    throw err;
  }
  try {
    return JSON.parse(content) as RegistryDocument;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`celld backend registry file is corrupt: ${path} — ${message}`);
  }
}

// =============================================================================
// Registry
// =============================================================================

export function createBackendRegistry(dataDir: string): BackendRegistry {
  const filePath = join(dataDir, 'hub', 'workspace-backends.json');

  /**
   * Every mutation runs to completion before the next one starts. Each op is
   * a read-modify-write of the WHOLE document (one file holds every route),
   * so serialization must be total across all workspaceIds, not keyed per
   * workspace — two concurrent beginProvisioning calls for DIFFERENT
   * workspaces still race on the same underlying file (mirrors the
   * `serialized` chain in src/hub/decisions.ts). Reads stay concurrent: a
   * completed rename is atomic, so a concurrent read sees either the prior
   * complete document or the new one, never a torn write.
   */
  let lastWrite: Promise<unknown> = Promise.resolve();
  function serialized<T>(op: () => Promise<T>): Promise<T> {
    const run = lastWrite.then(op, op);
    lastWrite = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  async function get(workspaceId: string): Promise<WorkspaceRoute | undefined> {
    const doc = await readRegistryDocument(filePath);
    return doc.routes[workspaceId];
  }

  async function list(): Promise<WorkspaceRoute[]> {
    const doc = await readRegistryDocument(filePath);
    return Object.values(doc.routes);
  }

  async function findByCommandId(commandId: string): Promise<WorkspaceRoute | undefined> {
    const doc = await readRegistryDocument(filePath);
    return Object.values(doc.routes).find(route => route.commandId === commandId);
  }

  function findOrBeginProvisioning(commandId: string, candidateWorkspaceId: string): Promise<WorkspaceRoute> {
    return serialized(async () => {
      const doc = await readRegistryDocument(filePath);
      // Same command retrying (crash resume, or a concurrent duplicate that
      // lost the serialization race) resumes the SAME route unchanged; the
      // caller's freshly-minted candidate ID is discarded — this is the
      // crash-resume path the RFC names.
      const resumed = Object.values(doc.routes).find(route => route.commandId === commandId);
      if (resumed !== undefined) return resumed;
      const collision = doc.routes[candidateWorkspaceId];
      if (collision !== undefined) {
        throw new CelldError(
          rejection(
            'VALIDATION_FAILED',
            `workspace ${candidateWorkspaceId} is already being provisioned by command ${collision.commandId}; cannot start provisioning with command ${commandId}`,
            { workspaceId: candidateWorkspaceId, existingCommandId: collision.commandId, requestedCommandId: commandId },
          ),
        );
      }
      const route: WorkspaceRoute = {
        workspaceId: candidateWorkspaceId,
        backend: 'celld',
        status: 'provisioning',
        commandId,
        createdAt: new Date().toISOString(),
      };
      doc.routes[candidateWorkspaceId] = route;
      await writeRegistryDocument(filePath, doc);
      return route;
    });
  }

  function markActive(workspaceId: string): Promise<void> {
    return serialized(async () => {
      const doc = await readRegistryDocument(filePath);
      const existing = doc.routes[workspaceId];
      if (existing === undefined) {
        throw new CelldError(
          rejection('NOT_FOUND', `no backend route for workspace ${workspaceId}`, { workspaceId }),
        );
      }
      if (existing.status === 'active') return; // idempotent no-op
      doc.routes[workspaceId] = {
        ...existing,
        status: 'active',
        activatedAt: new Date().toISOString(),
      };
      await writeRegistryDocument(filePath, doc);
    });
  }

  return { get, list, findByCommandId, findOrBeginProvisioning, markActive };
}
