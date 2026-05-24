# agent-task-protocol (ATP)

> A portable, framework-agnostic protocol for durable agent tasks.

## Problem

Every agent framework reinvents the same task primitives:

| Framework | Task model |
|---|---|
| LangGraph | Stateful nodes + checkpointer |
| Temporal (OpenAI Agents SDK integration) | Workflow + activity replay |
| MCP | `Task` primitive (lifecycle gaps in 2026 roadmap) |
| OpenAI Agents SDK | Run + step records |
| Inngest | Step-function model |
| Multi-channel agent runtimes | Native task / flow registries (typically SQLite-backed) |

There is no portable contract for what an agent task **is**: its lifecycle, its persistence shape, its retry/expiry semantics, its delivery context, its cost/time budgets, its approval gates. So memory, observability, audit, and federation across agent runtimes are all hand-rolled.

## Why doesn't this already exist

- MCP shipped a `Task` primitive but the 2026 roadmap still has open SEPs on retry semantics and expiry policies ([blog.modelcontextprotocol.io](https://blog.modelcontextprotocol.io/posts/2026-mcp-roadmap/)).
- OpenTelemetry GenAI semantic conventions standardize **traces**, not task state.
- A2A standardizes agent-to-agent task exchange, but not the local-runtime task model.

A small, focused spec that an agent framework can adopt to make its tasks portable is missing.

## What this is

1. A **JSON Schema** for `AgentTask` — lifecycle, persistence, delivery, budgets, checkpoints.
2. A **TypeScript reference implementation** with:
   - In-memory store
   - SQLite store (via `better-sqlite3` or Node native `sqlite`)
   - Validators (`ajv`)
   - CLI to create / list / transition / inspect tasks
3. **Adapter interfaces** so existing frameworks can wrap their native task model and emit ATP-compliant snapshots.

The protocol intentionally borrows from the most thought-out durable-task models in open-source personal-assistant codebases as of mid-2026 — revision-checked updates, opaque state bags, explicit delivery context, and human-checkpoint hooks.

## Quick start

```bash
pnpm install
pnpm build
pnpm cli create --goal "draft Q2 retrospective" --owner "alice@example.com"
pnpm cli list
pnpm cli wait <flowId> --reason "needs HR approval"
pnpm cli resume <flowId>
pnpm cli finish <flowId> --result "delivered"
```

## MVP scope

- [x] `AgentTask` JSON Schema
- [x] TypeScript types
- [x] In-memory store
- [x] SQLite store
- [x] Validators
- [x] CLI (create, list, get, wait, resume, finish, fail, cancel)
- [x] Unit tests on the lifecycle state machine
- [ ] Adapter: LangGraph wrapper
- [ ] Adapter: MCP Task → ATP
- [ ] Adapter: OpenAI Agents SDK
- [ ] Cross-process subscriber (LISTEN/NOTIFY-style on SQLite or Redis)

## Roadmap

| Milestone | What |
|---|---|
| v0.1 | Schema frozen, TS ref impl, in-memory + SQLite, CLI |
| v0.2 | Two adapters (LangGraph + MCP) |
| v0.3 | Python parity (`pip install agent-task-protocol`) |
| v0.4 | Streaming subscribers (cross-process) |
| v1.0 | RFC published, schema versioned |

## References

- Research paper §5 (Deep Dive — Task Handling)
- Research paper §10.1 #1 (proposed standards)
- Companion appendix: [appendix-task-handling.md](../../appendix-task-handling.md)

## License

Apache-2.0 © Vlad Bordei
