import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { assertTransition, canTransition, isTerminal } from "./lifecycle.ts";

describe("lifecycle", () => {
  it("allows queued → running", () => {
    assert.equal(canTransition("queued", "running"), true);
  });

  it("rejects queued → waiting", () => {
    assert.equal(canTransition("queued", "waiting"), false);
    assert.throws(() => assertTransition("queued", "waiting"));
  });

  it("terminal states stay terminal", () => {
    assert.equal(isTerminal("succeeded"), true);
    assert.equal(isTerminal("failed"), true);
    assert.equal(isTerminal("cancelled"), true);
    assert.equal(isTerminal("lost"), true);
    assert.equal(canTransition("succeeded", "running"), false);
  });

  it("running can go to all non-queued states", () => {
    for (const s of ["waiting", "blocked", "succeeded", "failed", "cancelled", "lost"] as const) {
      assert.equal(canTransition("running", s), true, `running → ${s}`);
    }
  });
});
