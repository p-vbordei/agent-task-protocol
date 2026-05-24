/**
 * Basic usage of agent-task-protocol with the in-memory store.
 * Run: pnpm tsx examples/basic.ts
 */
import { InMemoryStore, createTask, transition } from "../src/index.ts";

const store = new InMemoryStore();

const t = await createTask(store, {
  goal: "Summarize Q2 retro and post to #team-eng",
  ownerKey: "user:alice@example.com",
  notifyPolicy: "state_changes",
  requesterOrigin: { channel: "slack", thread: "C123", peer: "U001" },
  costBudget: { currency: "USD", cents: 200 },
  humanCheckpoints: [
    { id: "draft-review", prompt: "Review draft before posting?", requiredAt: "before_finalize" },
  ],
});

console.log("created:", t.id, "rev", t.revision);

const running = await transition(store, t.id, { to: "running", expectedRevision: t.revision });
console.log("started:", running.status, "rev", running.revision);

const waiting = await transition(store, t.id, {
  to: "waiting",
  expectedRevision: running.revision,
  waitJson: { reason: "draft-review", expecting: "user approval" },
});
console.log("waiting:", waiting.status, "rev", waiting.revision);

const resumed = await transition(store, t.id, {
  to: "running",
  expectedRevision: waiting.revision,
});
console.log("resumed:", resumed.status, "rev", resumed.revision);

const done = await transition(store, t.id, {
  to: "succeeded",
  expectedRevision: resumed.revision,
  result: { posted: true, slackTs: "1748100000.000123" },
});
console.log("done:", done.status, "rev", done.revision);
