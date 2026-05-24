import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { InMemoryStore } from "./store-memory.ts";
import { createTask, transition } from "./api.ts";
import { assertTransition, canTransition, isTerminal } from "./lifecycle.ts";
import {
  InvalidTransitionError,
  RevisionMismatchError,
  type AgentTask,
  type AgentTaskStatus,
} from "./types.ts";

const ALL_STATUSES: AgentTaskStatus[] = [
  "queued",
  "running",
  "waiting",
  "blocked",
  "succeeded",
  "failed",
  "cancelled",
  "lost",
];

// Source of truth mirroring lifecycle.ts. If lifecycle.ts changes, this should change too.
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

describe("lifecycle: exhaustive transition matrix", () => {
  it("every forbidden arrow throws InvalidTransitionError", () => {
    for (const from of ALL_STATUSES) {
      for (const to of ALL_STATUSES) {
        const allowed = ALLOWED[from].includes(to);
        if (allowed) continue;
        assert.equal(
          canTransition(from, to),
          false,
          `${from} → ${to} should be forbidden`,
        );
        assert.throws(
          () => assertTransition(from, to),
          InvalidTransitionError,
          `${from} → ${to} should throw`,
        );
      }
    }
  });

  it("every allowed arrow is permitted", () => {
    for (const from of ALL_STATUSES) {
      for (const to of ALLOWED[from]) {
        assert.equal(canTransition(from, to), true, `${from} → ${to}`);
        assert.doesNotThrow(() => assertTransition(from, to));
      }
    }
  });

  it("self-transitions are forbidden for every status", () => {
    for (const s of ALL_STATUSES) {
      assert.equal(canTransition(s, s), false, `${s} → ${s} should be forbidden`);
    }
  });

  it("isTerminal matches the empty-allowed-set rule", () => {
    for (const s of ALL_STATUSES) {
      assert.equal(isTerminal(s), ALLOWED[s].length === 0, s);
    }
  });
});

describe("api.transition through store: terminal & forbidden", () => {
  it("transitioning a succeeded task throws InvalidTransitionError", async () => {
    const s = new InMemoryStore();
    const t = await createTask(s, { goal: "g", ownerKey: "o" });
    await transition(s, t.id, { to: "running", expectedRevision: 1 });
    const done = await transition(s, t.id, { to: "succeeded", expectedRevision: 2 });
    await assert.rejects(
      () => transition(s, t.id, { to: "running", expectedRevision: done.revision }),
      InvalidTransitionError,
    );
  });

  it("transitioning queued → succeeded (skipping running) is forbidden", async () => {
    const s = new InMemoryStore();
    const t = await createTask(s, { goal: "g", ownerKey: "o" });
    await assert.rejects(
      () => transition(s, t.id, { to: "succeeded", expectedRevision: 1 }),
      InvalidTransitionError,
    );
  });

  it("self-transition (running → running) is forbidden via api", async () => {
    const s = new InMemoryStore();
    const t = await createTask(s, { goal: "g", ownerKey: "o" });
    await transition(s, t.id, { to: "running", expectedRevision: 1 });
    await assert.rejects(
      () => transition(s, t.id, { to: "running", expectedRevision: 2 }),
      InvalidTransitionError,
    );
  });
});

describe("concurrency: optimistic locking", () => {
  it("two racing callers with same expectedRevision: second loses", async () => {
    const s = new InMemoryStore();
    const t = await createTask(s, { goal: "race", ownerKey: "o" });
    const results = await Promise.allSettled([
      transition(s, t.id, { to: "running", expectedRevision: 1 }),
      transition(s, t.id, { to: "cancelled", expectedRevision: 1 }),
    ]);
    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");
    assert.equal(fulfilled.length, 1, "exactly one should succeed");
    assert.equal(rejected.length, 1, "exactly one should fail");
    const rej = rejected[0] as PromiseRejectedResult;
    assert.ok(
      rej.reason instanceof RevisionMismatchError,
      "loser should get RevisionMismatchError",
    );
  });
});

describe("budgets and checkpoints round-trip", () => {
  it("persists costBudget, tokenBudget, timeBudget, retryPolicy", async () => {
    const s = new InMemoryStore();
    const t = await createTask(s, {
      goal: "g",
      ownerKey: "o",
      costBudget: { currency: "USD", cents: 1500 },
      tokenBudget: { input: 8000, output: 2000 },
      timeBudget: { deadline: "2026-12-31T23:59:59Z" },
      retryPolicy: {
        maxAttempts: 5,
        initialBackoffMs: 100,
        maxBackoffMs: 60_000,
        jitter: "full",
      },
    });
    const got = await s.get(t.id);
    assert.deepEqual(got?.costBudget, { currency: "USD", cents: 1500 });
    assert.deepEqual(got?.tokenBudget, { input: 8000, output: 2000 });
    assert.deepEqual(got?.timeBudget, { deadline: "2026-12-31T23:59:59Z" });
    assert.deepEqual(got?.retryPolicy, {
      maxAttempts: 5,
      initialBackoffMs: 100,
      maxBackoffMs: 60_000,
      jitter: "full",
    });
  });

  it("persists humanCheckpoints", async () => {
    const s = new InMemoryStore();
    const t = await createTask(s, {
      goal: "g",
      ownerKey: "o",
      humanCheckpoints: [
        { id: "c1", prompt: "approve plan?", requiredAt: "before_start" },
        { id: "c2", prompt: "ok to ship?", requiredAt: "before_finalize" },
      ],
    });
    const got = await s.get(t.id);
    assert.equal(got?.humanCheckpoints?.length, 2);
    assert.equal(got?.humanCheckpoints?.[0]?.id, "c1");
    assert.equal(got?.humanCheckpoints?.[1]?.requiredAt, "before_finalize");
  });
});

describe("parentId: child tasks", () => {
  it("filters by parentId string", async () => {
    const s = new InMemoryStore();
    const parent = await createTask(s, { goal: "parent", ownerKey: "o" });
    await createTask(s, { goal: "c1", ownerKey: "o", parentId: parent.id });
    await createTask(s, { goal: "c2", ownerKey: "o", parentId: parent.id });
    await createTask(s, { goal: "other", ownerKey: "o" });
    const kids = await s.list({ parentId: parent.id });
    assert.equal(kids.length, 2);
    assert.ok(kids.every((t) => t.parentId === parent.id));
  });

  it("filters by parentId: null for orphans", async () => {
    const s = new InMemoryStore();
    const parent = await createTask(s, { goal: "parent", ownerKey: "o" });
    await createTask(s, { goal: "child", ownerKey: "o", parentId: parent.id });
    const orphans = await s.list({ parentId: null });
    assert.equal(orphans.length, 1);
    assert.equal(orphans[0]!.goal, "parent");
  });
});

describe("requesterOrigin round-trip", () => {
  it("preserves all DeliveryContext fields", async () => {
    const s = new InMemoryStore();
    const t = await createTask(s, {
      goal: "g",
      ownerKey: "o",
      requesterOrigin: {
        channel: "slack",
        thread: "T123",
        account: "acme",
        peer: "U456",
      },
    });
    const got = await s.get(t.id);
    assert.deepEqual(got?.requesterOrigin, {
      channel: "slack",
      thread: "T123",
      account: "acme",
      peer: "U456",
    });
  });
});

describe("list filter combinations", () => {
  it("filters by status array", async () => {
    const s = new InMemoryStore();
    const a = await createTask(s, { goal: "a", ownerKey: "o" });
    const b = await createTask(s, { goal: "b", ownerKey: "o" });
    const c = await createTask(s, { goal: "c", ownerKey: "o" });
    await transition(s, b.id, { to: "running", expectedRevision: 1 });
    await transition(s, b.id, { to: "succeeded", expectedRevision: 2 });
    await transition(s, c.id, { to: "cancelled", expectedRevision: 1 });
    void a;
    const terminal = await s.list({ status: ["succeeded", "cancelled"] });
    assert.equal(terminal.length, 2);
    const queued = await s.list({ status: ["queued"] });
    assert.equal(queued.length, 1);
  });

  it("filters by updatedSince", async () => {
    const s = new InMemoryStore();
    const a = await createTask(s, { goal: "old", ownerKey: "o" });
    // Advance the clock so updatedAt differs even when system clock has ms granularity.
    await new Promise((r) => setTimeout(r, 5));
    const cutoff = new Date().toISOString();
    await new Promise((r) => setTimeout(r, 5));
    const b = await createTask(s, { goal: "new", ownerKey: "o" });
    void a;
    void b;
    const recent = await s.list({ updatedSince: cutoff });
    assert.equal(recent.length, 1);
    assert.equal(recent[0]!.goal, "new");
  });

  it("respects limit and sorts before truncating", async () => {
    const s = new InMemoryStore();
    // Create 5 tasks; each transition bumps updatedAt.
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) {
      const t = await createTask(s, { goal: `g${i}`, ownerKey: "o" });
      ids.push(t.id);
      // tiny delay to ensure updatedAt order matches creation order
      await new Promise((r) => setTimeout(r, 2));
    }
    const limited = await s.list({ limit: 3 });
    assert.equal(limited.length, 3);
    // Should be the earliest three (sorted ascending by updatedAt).
    assert.deepEqual(
      limited.map((t) => t.id),
      ids.slice(0, 3),
    );
  });

  it("limit applies AFTER sorting by updatedAt (not raw insertion order)", async () => {
    const s = new InMemoryStore();
    // Insert in order 0..4
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) {
      const t = await createTask(s, { goal: `g${i}`, ownerKey: "o" });
      ids.push(t.id);
      await new Promise((r) => setTimeout(r, 2));
    }
    // Now touch the *first* task so its updatedAt becomes the largest.
    await new Promise((r) => setTimeout(r, 5));
    await transition(s, ids[0]!, { to: "running", expectedRevision: 1 });
    // List sorted ascending by updatedAt: ids[1], ids[2], ids[3], ids[4], ids[0]
    const limited = await s.list({ limit: 2 });
    assert.equal(limited.length, 2);
    // The limit should apply AFTER sort, so we should get the two oldest:
    // ids[1] and ids[2]. If limit were applied before sort, we'd get
    // ids[0] (still in map first) and ids[1].
    assert.deepEqual(
      limited.map((t) => t.id),
      [ids[1], ids[2]],
      "limit must apply after sorting, not before",
    );
  });
});

describe("subscribe semantics", () => {
  it("fires on create and on each update; unsubscribe stops it", async () => {
    const s = new InMemoryStore();
    const events: Array<{ status: string; rev: number }> = [];
    const unsub = s.subscribe({}, (t) =>
      events.push({ status: t.status, rev: t.revision }),
    );
    const t = await createTask(s, { goal: "g", ownerKey: "o" });
    await transition(s, t.id, { to: "running", expectedRevision: 1 });
    await transition(s, t.id, { to: "waiting", expectedRevision: 2 });
    unsub();
    await transition(s, t.id, { to: "running", expectedRevision: 3 });
    assert.deepEqual(events, [
      { status: "queued", rev: 1 },
      { status: "running", rev: 2 },
      { status: "waiting", rev: 3 },
    ]);
  });

  it("only fires for tasks matching the filter", async () => {
    const s = new InMemoryStore();
    const seen: string[] = [];
    const unsub = s.subscribe({ ownerKey: "alice" }, (t) => seen.push(t.ownerKey));
    await createTask(s, { goal: "a", ownerKey: "alice" });
    await createTask(s, { goal: "b", ownerKey: "bob" });
    unsub();
    assert.deepEqual(seen, ["alice"]);
  });

  // Documenting current behavior: subscribe does NOT fire on delete.
  // The store has no `deleted` task to deliver, and notify() is not called.
  // If you need delete notifications, layer them on top of the store.
  it("does NOT fire on delete (documented behavior)", async () => {
    const s = new InMemoryStore();
    const t = await createTask(s, { goal: "g", ownerKey: "o" });
    const events: AgentTask[] = [];
    const unsub = s.subscribe({}, (x) => events.push(x));
    await s.delete(t.id);
    unsub();
    assert.equal(events.length, 0);
  });
});

describe("delete", () => {
  it("removes from list and get returns null", async () => {
    const s = new InMemoryStore();
    const t = await createTask(s, { goal: "g", ownerKey: "o" });
    assert.ok(await s.get(t.id));
    await s.delete(t.id);
    assert.equal(await s.get(t.id), null);
    const list = await s.list({});
    assert.equal(list.length, 0);
  });

  it("deleting a missing id is a no-op", async () => {
    const s = new InMemoryStore();
    await assert.doesNotReject(() => s.delete("does-not-exist"));
  });
});

describe("transition: no-op mutator behavior", () => {
  // The current API always requires `input.to`. Setting to == current status
  // hits assertTransition(s, s) which is forbidden. We confirm this so callers
  // know they should not "transition" to the same status as a way of patching.
  it("transitioning to the same status fails", async () => {
    const s = new InMemoryStore();
    const t = await createTask(s, { goal: "g", ownerKey: "o" });
    await assert.rejects(
      () => transition(s, t.id, { to: "queued", expectedRevision: 1 }),
      InvalidTransitionError,
    );
  });
});

describe("createTask defaults", () => {
  it("defaults notifyPolicy to state_changes and revision to 1", async () => {
    const s = new InMemoryStore();
    const t = await createTask(s, { goal: "g", ownerKey: "o" });
    assert.equal(t.notifyPolicy, "state_changes");
    assert.equal(t.revision, 1);
    assert.equal(t.status, "queued");
    assert.equal(t.protocolVersion, "0.1");
    assert.equal(t.createdAt, t.updatedAt);
  });

  it("respects explicit notifyPolicy", async () => {
    const s = new InMemoryStore();
    const t = await createTask(s, {
      goal: "g",
      ownerKey: "o",
      notifyPolicy: "silent",
    });
    assert.equal(t.notifyPolicy, "silent");
  });
});

describe("UUIDv7 monotonic ordering", () => {
  it("two consecutive createTask calls produce sortable IDs", async () => {
    const s = new InMemoryStore();
    const a = await createTask(s, { goal: "a", ownerKey: "o" });
    const b = await createTask(s, { goal: "b", ownerKey: "o" });
    assert.ok(
      a.id < b.id,
      `expected ${a.id} < ${b.id} (uuidv7 should be time-sorted)`,
    );
  });

  it("a batch of 20 created in a tight loop sorts in creation order", async () => {
    const s = new InMemoryStore();
    const ids: string[] = [];
    for (let i = 0; i < 20; i++) {
      const t = await createTask(s, { goal: `g${i}`, ownerKey: "o" });
      ids.push(t.id);
    }
    const sorted = [...ids].sort();
    assert.deepEqual(sorted, ids);
  });
});

describe("update revision mismatch error details", () => {
  it("carries expected and actual revisions", async () => {
    const s = new InMemoryStore();
    const t = await createTask(s, { goal: "g", ownerKey: "o" });
    await transition(s, t.id, { to: "running", expectedRevision: 1 });
    try {
      await transition(s, t.id, { to: "waiting", expectedRevision: 1 });
      assert.fail("should have thrown");
    } catch (e) {
      assert.ok(e instanceof RevisionMismatchError);
      assert.equal((e as RevisionMismatchError).expected, 1);
      assert.equal((e as RevisionMismatchError).actual, 2);
    }
  });
});

describe("updates bump revision and updatedAt", () => {
  it("each update increments revision by 1 and refreshes updatedAt", async () => {
    const s = new InMemoryStore();
    const t = await createTask(s, { goal: "g", ownerKey: "o" });
    const created = await s.get(t.id);
    await new Promise((r) => setTimeout(r, 5));
    const r2 = await transition(s, t.id, { to: "running", expectedRevision: 1 });
    assert.equal(r2.revision, 2);
    assert.ok(r2.updatedAt >= created!.updatedAt);
    assert.equal(r2.createdAt, created!.createdAt);
    assert.ok(r2.endedAt === undefined);
    const r3 = await transition(s, t.id, { to: "succeeded", expectedRevision: 2 });
    assert.equal(r3.revision, 3);
    assert.ok(typeof r3.endedAt === "string", "endedAt set on terminal");
  });
});
