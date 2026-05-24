import type {
  AgentTask,
  TaskListFilter,
  TaskStore,
} from "./types.ts";
import { RevisionMismatchError } from "./types.ts";

export class InMemoryStore implements TaskStore {
  private tasks = new Map<string, AgentTask>();
  private subscribers = new Set<{
    filter: TaskListFilter;
    handler: (t: AgentTask) => void;
  }>();

  async create(task: AgentTask): Promise<void> {
    if (this.tasks.has(task.id)) {
      throw new Error(`Task ${task.id} already exists`);
    }
    this.tasks.set(task.id, structuredClone(task));
    this.notify(task);
  }

  async get(id: string): Promise<AgentTask | null> {
    const t = this.tasks.get(id);
    return t ? structuredClone(t) : null;
  }

  async list(filter: TaskListFilter = {}): Promise<AgentTask[]> {
    const out: AgentTask[] = [];
    for (const t of this.tasks.values()) {
      if (!matches(t, filter)) continue;
      out.push(structuredClone(t));
    }
    out.sort((a, b) => a.updatedAt.localeCompare(b.updatedAt));
    if (filter.limit) out.length = Math.min(out.length, filter.limit);
    return out;
  }

  async update(
    id: string,
    expectedRevision: number,
    mutator: (t: AgentTask) => AgentTask,
  ): Promise<AgentTask> {
    const existing = this.tasks.get(id);
    if (!existing) throw new Error(`Task ${id} not found`);
    if (existing.revision !== expectedRevision) {
      throw new RevisionMismatchError(expectedRevision, existing.revision);
    }
    const next = mutator(structuredClone(existing));
    next.revision = existing.revision + 1;
    next.updatedAt = new Date().toISOString();
    this.tasks.set(id, structuredClone(next));
    this.notify(next);
    return structuredClone(next);
  }

  async delete(id: string): Promise<void> {
    this.tasks.delete(id);
  }

  subscribe(
    filter: TaskListFilter,
    handler: (t: AgentTask) => void,
  ): () => void {
    const sub = { filter, handler };
    this.subscribers.add(sub);
    return () => this.subscribers.delete(sub);
  }

  private notify(task: AgentTask) {
    for (const sub of this.subscribers) {
      if (matches(task, sub.filter)) sub.handler(structuredClone(task));
    }
  }
}

function matches(t: AgentTask, f: TaskListFilter): boolean {
  if (f.ownerKey && t.ownerKey !== f.ownerKey) return false;
  if (f.parentId !== undefined) {
    if (f.parentId === null && t.parentId !== undefined) return false;
    if (typeof f.parentId === "string" && t.parentId !== f.parentId) return false;
  }
  if (f.status) {
    const allowed = Array.isArray(f.status) ? f.status : [f.status];
    if (!allowed.includes(t.status)) return false;
  }
  if (f.updatedSince && t.updatedAt < f.updatedSince) return false;
  return true;
}
