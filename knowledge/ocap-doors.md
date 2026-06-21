---
id: ocap-doors
title: Object-capability doors
type: concept
status: Enforced
last_reviewed: 2026-06-21
sources:
  - https://github.com/bounded-systems/guest-room
---

# Object-capability doors

A **door** is a single unit of authority: you hold a socket to a brokered
service, never the keys behind it. Authority can only ever be **narrowed** as it
is handed onward, never widened — the object-capability (ocap) model, in the
Miller / E lineage.

This is where the system draws its boundary: at the door (the capability), not
the process or container. The broker that holds the keys behind each door is
[[bellhop]].
