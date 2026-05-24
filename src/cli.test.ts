import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

// Walk up from this test file to the package root, then to dist/cli.js.
// import.meta.url -> .../src/cli.test.ts
const here = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.resolve(here, "..", "dist", "cli.js");

function run(
  args: string[],
  env: NodeJS.ProcessEnv = {},
): { stdout: string; stderr: string; code: number | null } {
  const res = spawnSync("node", [CLI, ...args], {
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
  return { stdout: res.stdout, stderr: res.stderr, code: res.status };
}

describe("CLI smoke", () => {
  it("prints help with no args", () => {
    const r = run([]);
    assert.equal(r.code, 0);
    assert.match(r.stdout, /atp — agent-task-protocol CLI/);
    assert.match(r.stdout, /Usage:/);
    assert.match(r.stdout, /atp create/);
  });

  it("prints help with --help", () => {
    const r = run(["--help"]);
    assert.equal(r.code, 0);
    assert.match(r.stdout, /Usage:/);
  });

  it("exits non-zero on unknown command", () => {
    const r = run(["bogus"]);
    assert.notEqual(r.code, 0);
    assert.match(r.stderr, /Unknown command: bogus/);
  });

  it("exits non-zero when create is missing --goal/--owner", () => {
    const r = run(["create"]);
    assert.notEqual(r.code, 0);
    assert.match(r.stderr, /--goal and --owner are required/);
  });

  it("create then list (persisted via SQLite)", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "atp-cli-test-"));
    const db = path.join(dir, "tasks.sqlite");
    try {
      const c = run(
        ["create", "--goal", "smoke", "--owner", "alice"],
        { ATP_DB: db },
      );
      assert.equal(c.code, 0, c.stderr);
      const created = JSON.parse(c.stdout) as { id: string; status: string };
      assert.equal(created.status, "queued");

      const l = run(["list", "--owner", "alice"], { ATP_DB: db });
      assert.equal(l.code, 0, l.stderr);
      const tasks = JSON.parse(l.stdout) as Array<{ id: string }>;
      assert.equal(tasks.length, 1);
      assert.equal(tasks[0]!.id, created.id);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("full lifecycle: create → start → wait → resume → finish", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "atp-cli-test-"));
    const db = path.join(dir, "tasks.sqlite");
    try {
      const c = run(
        ["create", "--goal", "lifecycle", "--owner", "bob"],
        { ATP_DB: db },
      );
      const id = (JSON.parse(c.stdout) as { id: string }).id;

      const s1 = run(["start", id], { ATP_DB: db });
      assert.equal(s1.code, 0, s1.stderr);
      assert.equal(JSON.parse(s1.stdout).status, "running");

      const s2 = run(["wait", id, "--reason", "needs human"], { ATP_DB: db });
      assert.equal(s2.code, 0, s2.stderr);
      assert.equal(JSON.parse(s2.stdout).status, "waiting");

      const s3 = run(["resume", id], { ATP_DB: db });
      assert.equal(s3.code, 0, s3.stderr);
      assert.equal(JSON.parse(s3.stdout).status, "running");

      const s4 = run(
        ["finish", id, "--result", '{"ok":true,"count":3}'],
        { ATP_DB: db },
      );
      assert.equal(s4.code, 0, s4.stderr);
      const fin = JSON.parse(s4.stdout);
      assert.equal(fin.status, "succeeded");
      assert.deepEqual(fin.result, { ok: true, count: 3 });
      assert.ok(typeof fin.endedAt === "string");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("cancel from queued", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "atp-cli-test-"));
    const db = path.join(dir, "tasks.sqlite");
    try {
      const c = run(
        ["create", "--goal", "cancel-me", "--owner", "carol"],
        { ATP_DB: db },
      );
      const id = (JSON.parse(c.stdout) as { id: string }).id;
      const r = run(["cancel", id], { ATP_DB: db });
      assert.equal(r.code, 0, r.stderr);
      assert.equal(JSON.parse(r.stdout).status, "cancelled");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("fail with --error after start", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "atp-cli-test-"));
    const db = path.join(dir, "tasks.sqlite");
    try {
      const c = run(
        ["create", "--goal", "fail-me", "--owner", "dave"],
        { ATP_DB: db },
      );
      const id = (JSON.parse(c.stdout) as { id: string }).id;
      run(["start", id], { ATP_DB: db });
      const r = run(["fail", id, "--error", "boom"], { ATP_DB: db });
      assert.equal(r.code, 0, r.stderr);
      const out = JSON.parse(r.stdout);
      assert.equal(out.status, "failed");
      assert.equal(out.error, "boom");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("transitioning a terminal task exits non-zero with sensible error", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "atp-cli-test-"));
    const db = path.join(dir, "tasks.sqlite");
    try {
      const c = run(
        ["create", "--goal", "terminal", "--owner", "erin"],
        { ATP_DB: db },
      );
      const id = (JSON.parse(c.stdout) as { id: string }).id;
      run(["cancel", id], { ATP_DB: db });
      const r = run(["start", id], { ATP_DB: db });
      assert.notEqual(r.code, 0);
      assert.match(r.stderr, /Invalid transition/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("get on a missing id prints (not found) and exits 0", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "atp-cli-test-"));
    const db = path.join(dir, "tasks.sqlite");
    try {
      const r = run(["get", "00000000-0000-0000-0000-000000000000"], {
        ATP_DB: db,
      });
      assert.equal(r.code, 0);
      assert.match(r.stdout, /\(not found\)/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
