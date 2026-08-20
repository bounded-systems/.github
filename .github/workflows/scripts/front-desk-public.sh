#!/usr/bin/env bash
# Filter a Front Desk projection down to what may be published.
#
#   bash front-desk-public.sh < front-desk.json > front-desk-public.json
#
# WHY (site#205, #651). The board is the org's own ranking of what to work on,
# and the site should be "a layer I can look at to figure out what I am going to
# work on". But the board spans the whole org, and a private repo's issue TITLES
# are exactly the kind of thing that must not appear on a public page. So the
# projection stays private and this produces a second, publishable snapshot.
#
# DEFAULT-DENY, AND THAT IS THE WHOLE DESIGN. A row survives only when the
# snapshot positively established that its repo is public — `repo_private` is
# exactly `false`. Every other case drops:
#
#   repo_private: true   → private repo, obviously out
#   repo_private: null   → visibility UNKNOWN (a snapshot predating the field, a
#                          DraftIssue with no repo at all). Unknown is not
#                          permission. A denylist would publish these; an
#                          allowlist refuses them, and refusing is the only
#                          direction whose failure mode is "too little published"
#                          rather than "a private title on the internet".
#   repo: null           → nothing to attribute the row to; out.
#
# This is the same fail-direction rule claim-boundary.md applies to the claim
# door: when the product of a step is a sentence someone will believe, a false
# green is the expensive failure, so the step fails closed.
#
# FIELDS ARE ALLOWLISTED TOO, not just rows. Only the keys named below survive,
# so a field added upstream (a new content column, an internal note) cannot ride
# along into the public feed just because nobody thought about it here. Adding a
# key is a deliberate edit with a test to match.
#
# `assignees` is deliberately NOT carried: `claimed` already answers the only
# question a reader needs ("is someone on this?") without republishing a roster
# of who is working on what.
#
# What this is NOT: a claim door, or any kind of authentication. It is a read
# surface — a filtered copy of a ranking that the org already made.
set -euo pipefail

jq '
  {
    generated_at: .generated_at,
    # Named so a consumer can never confuse the two feeds, and stamped with the
    # filter that produced it — a public snapshot that could not say what filter
    # made it is not auditable.
    feed: "front-desk-public",
    visibility_filter: "repo_private == false (default-deny)",
    project: { org: .project.org, number: .project.number, title: .project.title },
    items: [
      .items[]
      | select(.repo != null)
      | select(.repo_private == false)
      | {
          repo: .repo,
          number: .number,
          title: .title,
          url: .url,
          issue_state: .issue_state,
          labels: .labels,
          claimed: .claimed,
          type: .type,
          fields: .fields
        }
    ]
  }
  # Counts are recomputed over the FILTERED set. Carrying the private snapshot'"'"'s
  # counts would describe a board this feed does not show, and the difference
  # between the two is itself a private fact (how much work is in private repos).
  | .counts = (
      .items
      | group_by(.fields.Status // "(no status)")
      | map({ key: (.[0].fields.Status // "(no status)"), value: length })
      | from_entries
    )
  | .item_count = (.items | length)
'
