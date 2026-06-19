# Bounded Systems

**Keeping AI agents honest when they build and ship software.**

Agents are increasingly trusted to write and ship real code. The moment you let
them, the bottleneck stops being "can the agent do the task" and becomes "can
you trust what it did" — across many changes, many tools, and many
agent-authored components that all have to stay consistent as they evolve.

Bounded Systems builds that machinery: software *delivered by agents but
governed like infrastructure*. Every privileged effect an agent performs is
verified against its signed owner, and every change moves through one auditable
pipeline to a merged PR. Most tooling secures a single action — the harder,
unsolved problem is enforcement *between* components, keeping a growing set of
agent-authored contracts honest against each other.

The flagship is **prx**. Underneath it sits a stack of small,
single-responsibility capability libraries — each one the single sanctioned
access point for one kind of system authority (filesystem, network, env,
subprocess), so every effect stays attributable and every policy stays
enforceable.

## Start here

### [`guest-room`](https://github.com/bounded-systems/guest-room) — the model in one library

A guest-agnostic capability runtime built on **rooms and doors**. A *door* is a
single unit of authority: you hold a socket to a brokered service, never the
keys behind it. A *room* is a named bundle of doors, and authority can only ever
be narrowed as it is handed onward, never widened. Its behavior specs execute
against the engine, so the docs cannot drift from the code. Read this to see the
capability model made physical.

### [`prx`](https://github.com/bounded-systems/prx) — the flagship

The agent-run **work-unit CLI** — a work unit is one scoped task an agent owns
end-to-end. Capability-scoped agents whose every privileged effect is verified
against its signed owner, driving each work unit through one signed,
content-addressed pipeline to a merged PR. The `@bounded-systems/*` libraries
below live in its monorepo under `packages/`.

## The `@bounded-systems/*` libraries

Each is a narrow capability seam — the one sanctioned access point for one kind
of ambient system power — so that effects stay attributable and policy stays
enforceable.

| Package | What it is |
|---|---|
| `anchored-chain` | Derivation chain with contract validation, signing, lineage tracking, and invalidation |
| `anchored-chain-sqlite` | SQLite/Drizzle-backed implementation of the anchored-chain stores |
| `audit-context` | Ambient runtime context for gh-call audit attribution |
| `auth` | Service-credential resolver (GitHub, Notion) through a single sanctioned access point |
| `bd` | Typed interface to the beads CLI with policy enforcement |
| `cas` | Content-addressable storage: bytes addressed by their SHA-256 digest |
| `disposition` | Pure classifier mapping work-unit state to a disposition (ok/prune/repair/review) |
| `env` | The one sanctioned reader of `process.env` |
| `fs` | Filesystem capability seam — the one allowed filesystem-access point |
| `gh` | GitHub CLI wrapper with policy enforcement and budget audit logging |
| `git` | Git CLI wrapper with policy enforcement and stale-lock recovery |
| `github-budget` | Rate-limit-aware gh wrapper with bucket classification and audit trail |
| `host` | The one sanctioned reader of host/OS ambient state |
| `machine-schema` | Brands, handoff envelope, and state/phase primitives for work-unit machines |
| `policy` | Tool-policy engine enforcing subcommand allowlists by tool, state, and role |
| `proc` | The one allowed subprocess spawn point |
| `repo-root` | Repo-root resolution capability |
| `scout` | Content-addressed surface reads with anchored-chain provenance |
| `slack` | Policy-gated, provenance-tracked Slack read surface |
| `surface-sync` | Type ontology for work-unit change-detection across GH/branch/worktree/tmux/beads |

## Links

- 🌐 [bounded.tools](http://bounded.tools)
- 📦 [`prx` on GitHub](https://github.com/bounded-systems/prx)
- 🚪 [`guest-room` on GitHub](https://github.com/bounded-systems/guest-room)

> prx, guest-room, and the libraries are source-available under
> [PolyForm Noncommercial 1.0.0](https://polyformproject.org/licenses/noncommercial/1.0.0/).
