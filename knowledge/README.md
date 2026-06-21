# Knowledge graph

A git-backed, self-consistent knowledge base for Bounded Systems. Plain markdown
nodes, linked with `[[wikilinks]]`, graded with the same *Enforced / Partial /
Aspirational / Stale* vocabulary the code uses — and checked in CI so the graph
can't quietly drift.

## A node

One concept per file, `id` matching the filename stem, typed frontmatter:

```yaml
---
id: ocap-doors
title: Object-capability doors
type: concept        # concept | capability | claim | decision | component
status: Enforced     # Enforced | Partial | Aspirational | Stale
last_reviewed: 2026-06-21
sources:             # repo-relative paths (checked) or URLs (not fetched)
  - https://github.com/bounded-systems/guest-room
---
```

Link nodes with `[[id]]` or `[[id|alias]]`. The frontmatter contract is
[`note.schema.json`](note.schema.json).

## Consistency checks

`scripts/check-knowledge.py` (stdlib only) runs in CI on every change and fails
on drift. It reads `note.schema.json`, so the schema and the checker stay in
lockstep, then enforces:

- **Schema** — required fields, `id` pattern, `type` / `status` enums, non-empty `sources`.
- **Id discipline** — ids unique across the graph and equal to the filename stem.
- **Link integrity** — every `[[wikilink]]` resolves to a node.
- **Claim ↔ source** — every repo-relative `sources` path exists on disk.
- **Tracked gaps** — `Aspirational` nodes must carry a `tracking` reference.

Run it locally:

```sh
python3 scripts/check-knowledge.py
```

## Viewer

The graph is just markdown + wikilinks, so **Obsidian**, **Logseq**, or **Foam**
all open it directly. The viewer is a lens; the checks live in CI, so the choice
is yours and reversible.

## Not yet enforced (next invariants)

- `capability` nodes must map to a real `@bounded-systems/*` package.
- No two nodes may assert contradictory `status` for the same claim.
- Formal constraints via Datalog (Logseq) or SHACL over exported RDF.
