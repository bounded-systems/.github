# Bounded Systems

**Outward-only, composably-published tooling for agent-run software delivery.**

We build the machinery for software that is *delivered by agents but governed
like infrastructure*: every privileged effect an agent performs is verified
against its signed owner, and every change moves through one auditable pipeline
to a merged PR. The flagship is **prx**; underneath it sits a stack of small,
single-responsibility capability libraries published under the
`@bounded-systems/*` npm scope.

## Start here

### [`prx`](https://github.com/bounded-systems/prx) · public · TypeScript

The agent-run work-unit CLI: capability-scoped agents whose every privileged
effect is verified against its signed owner, driving a work unit through one
signed pipeline to a merged PR. This is the front door to everything below —
the `@bounded-systems/*` libraries live in its monorepo under `packages/`.

## The `@bounded-systems/*` libraries

Each is a narrow capability seam — one sanctioned access point for one ambient
authority — so that effects stay attributable and policy stays enforceable.

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

> prx and the libraries are source-available under
> [PolyForm Noncommercial 1.0.0](https://polyformproject.org/licenses/noncommercial/1.0.0/).
