#!/usr/bin/env node
import process from "node:process";
import { InMemoryStore } from "./store-memory.ts";
import { SqliteStore } from "./store-sqlite.ts";
import { createTask, transition } from "./api.ts";
import type { TaskStore } from "./types.ts";

async function openStore(): Promise<TaskStore> {
  const dbPath = process.env.ATP_DB;
  if (!dbPath) return new InMemoryStore();
  return SqliteStore.open(dbPath);
}

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
}

async function main() {
  const [, , cmd, ...rest] = process.argv;
  if (!cmd || cmd === "help" || cmd === "--help" || cmd === "-h") {
    console.log(`atp — agent-task-protocol CLI

Usage:
  atp create  --goal <text> --owner <key> [--notify done_only|state_changes|silent]
  atp list    [--owner <key>] [--status <status>]
  atp get     <id>
  atp start   <id>
  atp wait    <id> --reason <text>
  atp resume  <id>
  atp finish  <id> [--result <json>]
  atp fail    <id> --error <text>
  atp cancel  <id>

Environment:
  ATP_DB   Path to SQLite database. If unset, uses in-memory store (resets every run).

For long-running use, set ATP_DB. Example:
  ATP_DB=./tasks.sqlite atp create --goal "draft Q2 retro" --owner alice@example.com
`);
    return;
  }

  const store = await openStore();

  switch (cmd) {
    case "create": {
      const goal = flag(rest, "goal");
      const owner = flag(rest, "owner");
      if (!goal || !owner) throw new Error("--goal and --owner are required");
      const notify = (flag(rest, "notify") ?? "state_changes") as
        | "done_only" | "state_changes" | "silent";
      const t = await createTask(store, { goal, ownerKey: owner, notifyPolicy: notify });
      console.log(JSON.stringify(t, null, 2));
      break;
    }
    case "list": {
      const owner = flag(rest, "owner");
      const status = flag(rest, "status");
      const tasks = await store.list({
        ownerKey: owner,
        status: status as never,
      });
      console.log(JSON.stringify(tasks, null, 2));
      break;
    }
    case "get": {
      const id = rest[0];
      if (!id) throw new Error("id required");
      const t = await store.get(id);
      console.log(t ? JSON.stringify(t, null, 2) : "(not found)");
      break;
    }
    case "start": {
      const id = rest[0];
      if (!id) throw new Error("id required");
      const cur = await store.get(id);
      if (!cur) throw new Error("not found");
      const t = await transition(store, id, { to: "running", expectedRevision: cur.revision });
      console.log(JSON.stringify(t, null, 2));
      break;
    }
    case "wait": {
      const id = rest[0];
      const reason = flag(rest, "reason") ?? "(unspecified)";
      if (!id) throw new Error("id required");
      const cur = await store.get(id);
      if (!cur) throw new Error("not found");
      const t = await transition(store, id, {
        to: "waiting",
        expectedRevision: cur.revision,
        waitJson: { reason },
      });
      console.log(JSON.stringify(t, null, 2));
      break;
    }
    case "resume": {
      const id = rest[0];
      if (!id) throw new Error("id required");
      const cur = await store.get(id);
      if (!cur) throw new Error("not found");
      const t = await transition(store, id, { to: "running", expectedRevision: cur.revision });
      console.log(JSON.stringify(t, null, 2));
      break;
    }
    case "finish": {
      const id = rest[0];
      const resultRaw = flag(rest, "result");
      if (!id) throw new Error("id required");
      const cur = await store.get(id);
      if (!cur) throw new Error("not found");
      const t = await transition(store, id, {
        to: "succeeded",
        expectedRevision: cur.revision,
        result: (resultRaw ? safeJson(resultRaw) : { ok: true }) as never,
      });
      console.log(JSON.stringify(t, null, 2));
      break;
    }
    case "fail": {
      const id = rest[0];
      const err = flag(rest, "error") ?? "(unspecified)";
      if (!id) throw new Error("id required");
      const cur = await store.get(id);
      if (!cur) throw new Error("not found");
      const t = await transition(store, id, {
        to: "failed",
        expectedRevision: cur.revision,
        error: err,
      });
      console.log(JSON.stringify(t, null, 2));
      break;
    }
    case "cancel": {
      const id = rest[0];
      if (!id) throw new Error("id required");
      const cur = await store.get(id);
      if (!cur) throw new Error("not found");
      const t = await transition(store, id, { to: "cancelled", expectedRevision: cur.revision });
      console.log(JSON.stringify(t, null, 2));
      break;
    }
    default:
      console.error(`Unknown command: ${cmd}`);
      process.exit(2);
  }
}

function safeJson(raw: string): unknown {
  try { return JSON.parse(raw); } catch { return raw; }
}

main().catch((err) => {
  console.error(err.message ?? String(err));
  process.exit(1);
});
