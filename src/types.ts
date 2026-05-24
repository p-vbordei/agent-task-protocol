export type Json =
  | string | number | boolean | null
  | { [k: string]: Json }
  | Json[];

export type AgentTaskStatus =
  | "queued"
  | "running"
  | "waiting"
  | "blocked"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "lost";

export type NotifyPolicy = "done_only" | "state_changes" | "silent";

export interface DeliveryContext {
  channel: string;
  thread?: string;
  account?: string;
  peer?: string;
}

export interface CostBudget {
  currency: string;
  cents: number;
}

export interface TokenBudget {
  input?: number;
  output?: number;
}

export interface TimeBudget {
  deadline: string; // ISO 8601
}

export type Jitter = "none" | "full" | "equal";

export interface RetryPolicy {
  maxAttempts: number;
  initialBackoffMs: number;
  maxBackoffMs: number;
  jitter: Jitter;
}

export type HumanCheckpointTrigger =
  | "before_start"
  | "before_each_step"
  | "before_finalize"
  | "on_failure";

export interface HumanCheckpoint {
  id: string;
  prompt: string;
  requiredAt: HumanCheckpointTrigger;
}

export interface AgentTask {
  id: string;
  parentId?: string;
  protocolVersion: "0.1";

  ownerKey: string;
  requesterOrigin?: DeliveryContext;

  status: AgentTaskStatus;
  revision: number;
  currentStep?: string;

  goal: string;
  stateJson?: Json;

  waitJson?: Json;
  blockedReason?: string;

  notifyPolicy: NotifyPolicy;
  costBudget?: CostBudget;
  tokenBudget?: TokenBudget;
  timeBudget?: TimeBudget;
  retryPolicy?: RetryPolicy;
  humanCheckpoints?: HumanCheckpoint[];

  cancelRequestedAt?: string;
  createdAt: string;
  updatedAt: string;
  endedAt?: string;

  result?: Json;
  error?: string;
}

export interface TaskListFilter {
  ownerKey?: string;
  status?: AgentTaskStatus | AgentTaskStatus[];
  parentId?: string | null;
  updatedSince?: string;
  limit?: number;
}

export interface TaskStore {
  create(task: AgentTask): Promise<void>;
  get(id: string): Promise<AgentTask | null>;
  list(filter?: TaskListFilter): Promise<AgentTask[]>;
  update(
    id: string,
    expectedRevision: number,
    mutator: (t: AgentTask) => AgentTask,
  ): Promise<AgentTask>;
  delete(id: string): Promise<void>;
  subscribe?(
    filter: TaskListFilter,
    handler: (t: AgentTask) => void,
  ): () => void;
}

export class RevisionMismatchError extends Error {
  constructor(public expected: number, public actual: number) {
    super(`Revision mismatch: expected ${expected}, got ${actual}`);
    this.name = "RevisionMismatchError";
  }
}

export class InvalidTransitionError extends Error {
  constructor(public from: AgentTaskStatus, public to: AgentTaskStatus) {
    super(`Invalid transition: ${from} → ${to}`);
    this.name = "InvalidTransitionError";
  }
}
