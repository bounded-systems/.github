---
id: bellhop
title: bellhop (capability broker)
type: component
status: Aspirational
tracking: docs/positioning.md#action-items
last_reviewed: 2026-06-21
sources:
  - docs/positioning.md
---

# bellhop (capability broker)

The capability **broker** that `prx` (and agents) use to obtain and pass
[[ocap-doors|doors]]: it carries authority to the guest and never surrenders the
master key. `bellhop` names the layer where sockets / fd-passing live — the
"brokered service" that guest-room's doors point at.

Seam to keep clean: `prx` orchestrates work-units to merged PRs; `bellhop`
brokers authority. They must not bleed into each other. Effects brokered here
land in the [[provenance-chain]].
