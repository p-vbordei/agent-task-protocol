# Architecture — agent-task-protocol

## Core type

```ts
export type AgentTaskStatus =
  | "queued" | "running" | "waiting" | "blocked"
  | "succeeded" | "failed" | "cancelled" | "lost";

export interface AgentTask {
  // Identity
  id: string;                       // UUIDv7 recommended (time-ordered)
  parentId?: string;                // Hierarchical tasks
  protocolVersion: "0.1";

  // Ownership & delivery
  ownerKey: string;                 // e.g. "user:alice@example.com" or "agent:claude-opus-4-7"
  requesterOrigin?: DeliveryContext;// Where to deliver completion/progress

  // State machine
  status: AgentTaskStatus;
  revision: number;                 // Monotonic; resume requires match
  currentStep?: string;

  // Goal & state bag
  goal: string;                     // Human-readable intent
  stateJson?: Json;                 // Opaque per-runtime state

  // Wait/block context
  waitJson?: Json;                  // Why waiting, what we expect
  blockedReason?: string;

  // Budgets & policy
  notifyPolicy: "done_only" | "state_changes" | "silent";
  costBudget?: { currency: string; cents: number };
  tokenBudget?: { input?: number; output?: number };
  timeBudget?: { deadline: string };// ISO 8601
  retryPolicy?: RetryPolicy;
  humanCheckpoints?: HumanCheckpoint[];

  // Cancel & lifecycle
  cancelRequestedAt?: string;
  createdAt: string;
  updatedAt: string;
  endedAt?: string;
}

export interface DeliveryContext {
  channel: string;                  // "slack" | "imessage" | "stdout" | ...
  thread?: string;
  account?: string;
  peer?: string;
}

export interface RetryPolicy {
  maxAttempts: number;
  initialBackoffMs: number;
  maxBackoffMs: number;
  jitter: "none" | "full" | "equal";
}

export interface HumanCheckpoint {
  id: string;
  prompt: string;
  requiredAt: "before_start" | "before_each_step" | "before_finalize" | "on_failure";
}
```

## Lifecycle

```
                 ┌───── cancel ─────┐
                 ▼                  │
queued ─► running ─► waiting ─► running ─► succeeded
   │         │           │           │
   │         ▼           ▼           ▼
   │      failed     blocked     cancelled
   └─── lost (heartbeat timeout) ───┘
```

- `queued → running`: `start()` — increments `revision`.
- `running → waiting`: `wait({ reason, expect })` — sets `waitJson`.
- `waiting → running`: `resume({ expectedRevision })` — fails if revision mismatch.
- `running → blocked`: `block({ reason })` — terminal-until-human-resume.
- Terminal states: `succeeded | failed | cancelled | lost`.

## Persistence contract

The `TaskStore` interface defines a minimal CRUD + transition surface:

```ts
export interface TaskStore {
  create(task: AgentTask): Promise<void>;
  get(id: string): Promise<AgentTask | null>;
  list(filter?: TaskListFilter): Promise<AgentTask[]>;
  update(id: string, expectedRevision: number, mutator: (t: AgentTask) => AgentTask): Promise<AgentTask>;
  delete(id: string): Promise<void>;
  subscribe?(filter: TaskListFilter, handler: (t: AgentTask) => void): () => void;
}
```

Two reference implementations:

- `InMemoryStore` — for tests and dev.
- `SqliteStore` — for production. Uses Node's native `sqlite` module (or `better-sqlite3` fallback). One table `tasks`, indices on `(ownerKey)`, `(status)`, `(parentId)`.

## Why this shape

- **Revision-checked updates** prevent lost updates across concurrent resumers (a common pattern in mature open-source durable-task registries).
- **`requesterOrigin` + `notifyPolicy`** make completion delivery routable without a separate routing system — the same model can carry a task across channels.
- **Budgets are first-class** — most frameworks treat cost/token/time as instrumentation; here they are policy.
- **`HumanCheckpoint`** standardizes the "approval gate" pattern instead of leaving it to skill code.
- **`stateJson` opaque** keeps the protocol portable; runtimes can put whatever they need.

## Adapter pattern

Frameworks already implement task models. ATP doesn't ask them to throw those away — it asks for an adapter that produces ATP snapshots:

```ts
export interface AtpAdapter {
  toAtp(nativeTask: unknown): AgentTask;
  fromAtp(task: AgentTask): unknown;
  subscribe?(handler: (t: AgentTask) => void): () => void;
}
```

The win: any agent runtime that ships an adapter immediately benefits from portable inspectors, dashboards, exporters, and cross-runtime memory.

## Non-goals

- ATP does **not** prescribe how tasks are executed.
- It does **not** define a workflow language.
- It does **not** define the agent loop.

ATP is the *task substrate*. Workflow languages, agent loops, and orchestrators live on top.
