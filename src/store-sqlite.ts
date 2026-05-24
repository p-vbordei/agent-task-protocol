/**
 * SQLite store using Node 22+ native `node:sqlite`.
 *
 * Falls back to clear instructions if the native module is not present
 * (Node < 22.5 without the experimental flag). For production deployments,
 * we recommend Node 24+.
 */
import type {
  AgentTask,
  TaskListFilter,
  TaskStore,
} from "./types.ts";
import { RevisionMismatchError } from "./types.ts";

// Node 22.5+: import { DatabaseSync } from "node:sqlite"
// We import dynamically so the rest of the package works without it.
interface DatabaseSync {
  prepare(sql: string): {
    run(...args: unknown[]): { changes: number };
    get(...args: unknown[]): unknown;
    all(...args: unknown[]): unknown[];
  };
  exec(sql: string): void;
  close(): void;
}

export class SqliteStore implements TaskStore {
  private db!: DatabaseSync;

  static async open(path: string): Promise<SqliteStore> {
    let mod: { DatabaseSync: new (path: string) => DatabaseSync };
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      mod = (await import("node:sqlite")) as any;
    } catch {
      throw new Error(
        "node:sqlite not available. Use Node 22.5+ with --experimental-sqlite, or 24+, or swap in better-sqlite3.",
      );
    }
    const store = new SqliteStore();
    store.db = new mod.DatabaseSync(path);
    store.db.exec(`
      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY,
        owner_key TEXT NOT NULL,
        parent_id TEXT,
        status TEXT NOT NULL,
        revision INTEGER NOT NULL,
        json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS tasks_owner ON tasks(owner_key);
      CREATE INDEX IF NOT EXISTS tasks_status ON tasks(status);
      CREATE INDEX IF NOT EXISTS tasks_parent ON tasks(parent_id);
      CREATE INDEX IF NOT EXISTS tasks_updated ON tasks(updated_at);
    `);
    return store;
  }

  async create(task: AgentTask): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO tasks(id, owner_key, parent_id, status, revision, json, updated_at)
         VALUES(?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        task.id,
        task.ownerKey,
        task.parentId ?? null,
        task.status,
        task.revision,
        JSON.stringify(task),
        task.updatedAt,
      );
  }

  async get(id: string): Promise<AgentTask | null> {
    const row = this.db.prepare(`SELECT json FROM tasks WHERE id = ?`).get(id) as
      | { json: string }
      | undefined;
    return row ? (JSON.parse(row.json) as AgentTask) : null;
  }

  async list(filter: TaskListFilter = {}): Promise<AgentTask[]> {
    const where: string[] = [];
    const args: unknown[] = [];
    if (filter.ownerKey) {
      where.push("owner_key = ?");
      args.push(filter.ownerKey);
    }
    if (filter.status) {
      const arr = Array.isArray(filter.status) ? filter.status : [filter.status];
      where.push(`status IN (${arr.map(() => "?").join(",")})`);
      args.push(...arr);
    }
    if (filter.parentId === null) where.push("parent_id IS NULL");
    else if (typeof filter.parentId === "string") {
      where.push("parent_id = ?");
      args.push(filter.parentId);
    }
    if (filter.updatedSince) {
      where.push("updated_at >= ?");
      args.push(filter.updatedSince);
    }
    const sql = `SELECT json FROM tasks ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY updated_at ${filter.limit ? `LIMIT ${Number(filter.limit)}` : ""}`;
    const rows = this.db.prepare(sql).all(...args) as { json: string }[];
    return rows.map((r) => JSON.parse(r.json) as AgentTask);
  }

  async update(
    id: string,
    expectedRevision: number,
    mutator: (t: AgentTask) => AgentTask,
  ): Promise<AgentTask> {
    const existing = await this.get(id);
    if (!existing) throw new Error(`Task ${id} not found`);
    if (existing.revision !== expectedRevision) {
      throw new RevisionMismatchError(expectedRevision, existing.revision);
    }
    const next = mutator(structuredClone(existing));
    next.revision = existing.revision + 1;
    next.updatedAt = new Date().toISOString();
    const res = this.db
      .prepare(
        `UPDATE tasks SET owner_key=?, parent_id=?, status=?, revision=?, json=?, updated_at=?
         WHERE id=? AND revision=?`,
      )
      .run(
        next.ownerKey,
        next.parentId ?? null,
        next.status,
        next.revision,
        JSON.stringify(next),
        next.updatedAt,
        id,
        expectedRevision,
      );
    if (res.changes !== 1) throw new RevisionMismatchError(expectedRevision, -1);
    return next;
  }

  async delete(id: string): Promise<void> {
    this.db.prepare(`DELETE FROM tasks WHERE id=?`).run(id);
  }

  close(): void {
    this.db.close();
  }
}
