import { v7 as uuidv7 } from "uuid";
import type {
  AgentTask,
  AgentTaskStatus,
  NotifyPolicy,
  TaskStore,
} from "./types.ts";
import { assertTransition } from "./lifecycle.ts";

export interface CreateTaskInput {
  goal: string;
  ownerKey: string;
  parentId?: string;
  notifyPolicy?: NotifyPolicy;
  costBudget?: AgentTask["costBudget"];
  tokenBudget?: AgentTask["tokenBudget"];
  timeBudget?: AgentTask["timeBudget"];
  retryPolicy?: AgentTask["retryPolicy"];
  humanCheckpoints?: AgentTask["humanCheckpoints"];
  requesterOrigin?: AgentTask["requesterOrigin"];
}

export async function createTask(
  store: TaskStore,
  input: CreateTaskInput,
): Promise<AgentTask> {
  const now = new Date().toISOString();
  const task: AgentTask = {
    id: uuidv7(),
    protocolVersion: "0.1",
    ownerKey: input.ownerKey,
    parentId: input.parentId,
    status: "queued",
    revision: 1,
    goal: input.goal,
    notifyPolicy: input.notifyPolicy ?? "state_changes",
    costBudget: input.costBudget,
    tokenBudget: input.tokenBudget,
    timeBudget: input.timeBudget,
    retryPolicy: input.retryPolicy,
    humanCheckpoints: input.humanCheckpoints,
    requesterOrigin: input.requesterOrigin,
    createdAt: now,
    updatedAt: now,
  };
  await store.create(task);
  return task;
}

export interface TransitionInput {
  to: AgentTaskStatus;
  expectedRevision: number;
  currentStep?: string;
  stateJson?: AgentTask["stateJson"];
  waitJson?: AgentTask["waitJson"];
  blockedReason?: string;
  result?: AgentTask["result"];
  error?: string;
}

export async function transition(
  store: TaskStore,
  id: string,
  input: TransitionInput,
): Promise<AgentTask> {
  return store.update(id, input.expectedRevision, (t) => {
    assertTransition(t.status, input.to);
    t.status = input.to;
    if (input.currentStep !== undefined) t.currentStep = input.currentStep;
    if (input.stateJson !== undefined) t.stateJson = input.stateJson;
    if (input.waitJson !== undefined) t.waitJson = input.waitJson;
    if (input.blockedReason !== undefined) t.blockedReason = input.blockedReason;
    if (input.result !== undefined) t.result = input.result;
    if (input.error !== undefined) t.error = input.error;
    if (input.to === "succeeded" || input.to === "failed" || input.to === "cancelled" || input.to === "lost") {
      t.endedAt = new Date().toISOString();
    }
    return t;
  });
}
