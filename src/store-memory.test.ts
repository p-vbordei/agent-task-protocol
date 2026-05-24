import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { InMemoryStore } from "./store-memory.ts";
import { createTask, transition } from "./api.ts";
import { RevisionMismatchError } from "./types.ts";

describe("InMemoryStore", () => {
  it("creates and gets a task", async () => {
    const s = new InMemoryStore();
    const t = await createTask(s, { goal: "test", ownerKey: "alice" });
    const got = await s.get(t.id);
    assert.equal(got?.id, t.id);
    assert.equal(got?.status, "queued");
    assert.equal(got?.revision, 1);
  });

  it("increments revision on update", async () => {
    const s = new InMemoryStore();
    const t = await createTask(s, { goal: "test", ownerKey: "alice" });
    const t2 = await transition(s, t.id, { to: "running", expectedRevision: 1 });
    assert.equal(t2.revision, 2);
    assert.equal(t2.status, "running");
  });

  it("rejects stale revision", async () => {
    const s = new InMemoryStore();
    const t = await createTask(s, { goal: "test", ownerKey: "alice" });
    await transition(s, t.id, { to: "running", expectedRevision: 1 });
    await assert.rejects(
      () => transition(s, t.id, { to: "waiting", expectedRevision: 1 }),
      RevisionMismatchError,
    );
  });

  it("filters by owner", async () => {
    const s = new InMemoryStore();
    await createTask(s, { goal: "a", ownerKey: "alice" });
    await createTask(s, { goal: "b", ownerKey: "bob" });
    const alice = await s.list({ ownerKey: "alice" });
    assert.equal(alice.length, 1);
    assert.equal(alice[0]!.goal, "a");
  });

  it("subscribes to changes", async () => {
    const s = new InMemoryStore();
    const seen: string[] = [];
    const unsub = s.subscribe({}, (t) => seen.push(`${t.status}@${t.revision}`));
    const t = await createTask(s, { goal: "test", ownerKey: "alice" });
    await transition(s, t.id, { to: "running", expectedRevision: 1 });
    unsub();
    assert.deepEqual(seen, ["queued@1", "running@2"]);
  });
});
