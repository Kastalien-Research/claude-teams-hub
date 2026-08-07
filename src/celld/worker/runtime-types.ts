/**
 * Minimal typings for the celld Durable Object runtime surface this Worker
 * uses. Deliberately hand-written against probed celld v0.1.0 behavior rather
 * than pinning @cloudflare/workers-types, whose fidelity to celld v0.1.0 is
 * unproven (RFC 0001; probe 0.2 pinned the cursor shape: toArray/one/raw/
 * columnNames, iterable, rowsRead/rowsWritten).
 */

export type CellSqlBind = string | number | null | Uint8Array;
export type CellSqlRow = Record<string, string | number | null | Uint8Array>;

export interface CellSqlCursor extends Iterable<CellSqlRow> {
  toArray(): CellSqlRow[];
  one(): CellSqlRow;
  raw(): Iterable<unknown[]>;
  columnNames: string[];
  rowsRead: number;
  rowsWritten: number;
}

export interface CellSqlStorage {
  exec(query: string, ...binds: CellSqlBind[]): CellSqlCursor;
  databaseSize: number;
}

export interface CellStorage {
  sql: CellSqlStorage;
  transactionSync<T>(fn: () => T): T;
  get(key: string): Promise<unknown>;
  put(key: string, value: unknown): Promise<void>;
}

export interface CellState {
  storage: CellStorage;
}

export interface DurableObjectNamespaceLike {
  idFromName(name: string): unknown;
  get(id: unknown): { fetch(request: Request): Promise<Response> };
}

export interface WorkerEnv {
  WORKSPACES: DurableObjectNamespaceLike;
}
