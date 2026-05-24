import type { AgentTaskStatus } from "./types.ts";
import { InvalidTransitionError } from "./types.ts";

const ALLOWED: Record<AgentTaskStatus, AgentTaskStatus[]> = {
  queued: ["running", "cancelled", "lost"],
  running: ["waiting", "blocked", "succeeded", "failed", "cancelled", "lost"],
  waiting: ["running", "cancelled", "lost"],
  blocked: ["running", "cancelled", "failed", "lost"],
  succeeded: [],
  failed: [],
  cancelled: [],
  lost: [],
};

export function isTerminal(status: AgentTaskStatus): boolean {
  return ALLOWED[status].length === 0;
}

export function assertTransition(
  from: AgentTaskStatus,
  to: AgentTaskStatus,
): void {
  if (!ALLOWED[from].includes(to)) {
    throw new InvalidTransitionError(from, to);
  }
}

export function canTransition(
  from: AgentTaskStatus,
  to: AgentTaskStatus,
): boolean {
  return ALLOWED[from].includes(to);
}
