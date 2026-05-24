import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import { SqliteStore } from "./store-sqlite.ts";
import { createTask, transition } from "./api.ts";
import { RevisionMismatchError } from "./types.ts";

// Probe whether node:sqlite is available. Newer Node ships it; older Node will
// throw on the dynamic import inside SqliteStore.open.
let sqliteAvailable = false;
try {
  await import("node:sqlite");
  sqliteAvailable = true;
} catch {
  sqliteAvailable = false;
}

const maybe = sqliteAvailable ? describe : describe.skip;

maybe("SqliteStore", () => {
  let dbPath: string;
  let store: SqliteStore;

  before(async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "atp-sqlite-test-"));
    dbPath = path.join(dir, "tasks.sqlite");
    store = await SqliteStore.open(dbPath);
  });

  after(async () => {
    try {
      store.close();
    } catch {
      // ignore
    }
    try {
      await fs.rm(path.dirname(dbPath), { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  it("creates and gets a task", async () => {
    const t = await createTask(store, { goal: "sql", ownerKey: "alice" });
    const got = await store.get(t.id);
    assert.equal(got?.id, t.id);
    assert.equal(got?.status, "queued");
    assert.equal(got?.revision, 1);
    assert.equal(got?.goal, "sql");
  });

  it("returns null for missing id", async () => {
    const got = await store.get("00000000-0000-0000-0000-000000000000");
    assert.equal(got, null);
  });

  it("lists with filters (status array + ownerKey)", async () => {
    const a = await createTask(store, { goal: "a", ownerKey: "bob" });
    await createTask(store, { goal: "b", ownerKey: "bob" });
    await transition(store, a.id, { to: "running", expectedRevision: 1 });
    const running = await store.list({ ownerKey: "bob", status: ["running"] });
    assert.equal(running.length, 1);
    assert.equal(running[0]!.id, a.id);
    const both = await store.list({
      ownerKey: "bob",
      status: ["running", "queued"],
    });
    assert.equal(both.length, 2);
  });

  it("filters by parentId IS NULL", async () => {
    // Use a unique owner so we don't collide with other tests.
    const parent = await createTask(store, {
      goal: "p",
      ownerKey: "parent-owner",
    });
    await createTask(store, {
      goal: "c",
      ownerKey: "parent-owner",
      parentId: parent.id,
    });
    const orphans = await store.list({
      ownerKey: "parent-owner",
      parentId: null,
    });
    assert.equal(orphans.length, 1);
    assert.equal(orphans[0]!.id, parent.id);
    const kids = await store.list({
      ownerKey: "parent-owner",
      parentId: parent.id,
    });
    assert.equal(kids.length, 1);
  });

  it("updates and bumps revision; reads back", async () => {
    const t = await createTask(store, { goal: "u", ownerKey: "carol" });
    const t2 = await transition(store, t.id, {
      to: "running",
      expectedRevision: 1,
    });
    assert.equal(t2.revision, 2);
    assert.equal(t2.status, "running");
    const got = await store.get(t.id);
    assert.equal(got?.revision, 2);
    assert.equal(got?.status, "running");
  });

  it("rejects stale expectedRevision (RevisionMismatchError)", async () => {
    const t = await createTask(store, { goal: "rev", ownerKey: "dave" });
    await transition(store, t.id, { to: "running", expectedRevision: 1 });
    await assert.rejects(
      () => transition(store, t.id, { to: "waiting", expectedRevision: 1 }),
      RevisionMismatchError,
    );
  });

  it("delete removes the row; get returns null after", async () => {
    const t = await createTask(store, { goal: "del", ownerKey: "erin" });
    assert.ok(await store.get(t.id));
    await store.delete(t.id);
    assert.equal(await store.get(t.id), null);
  });

  it("respects limit (returns at most N rows)", async () => {
    for (let i = 0; i < 5; i++) {
      await createTask(store, { goal: `lim-${i}`, ownerKey: "limit-owner" });
    }
    const limited = await store.list({ ownerKey: "limit-owner", limit: 2 });
    assert.equal(limited.length, 2);
  });

  it("persists complex fields (budgets, checkpoints, requesterOrigin) round-trip", async () => {
    const t = await createTask(store, {
      goal: "complex",
      ownerKey: "frank",
      costBudget: { currency: "EUR", cents: 999 },
      tokenBudget: { input: 100, output: 50 },
      timeBudget: { deadline: "2030-01-01T00:00:00Z" },
      humanCheckpoints: [
        { id: "h1", prompt: "ok?", requiredAt: "before_finalize" },
      ],
      requesterOrigin: {
        channel: "discord",
        thread: "t9",
        account: "acct",
        peer: "peer-x",
      },
    });
    const got = await store.get(t.id);
    assert.deepEqual(got?.costBudget, { currency: "EUR", cents: 999 });
    assert.deepEqual(got?.tokenBudget, { input: 100, output: 50 });
    assert.deepEqual(got?.timeBudget, { deadline: "2030-01-01T00:00:00Z" });
    assert.equal(got?.humanCheckpoints?.[0]?.id, "h1");
    assert.deepEqual(got?.requesterOrigin, {
      channel: "discord",
      thread: "t9",
      account: "acct",
      peer: "peer-x",
    });
  });
});
