#!/usr/bin/env bash
# Projects the Front Desk board (org project #2) into a JSON snapshot, so a
# SESSION can read what is on the board. Extracted from front-desk-projection.yml
# so the same bytes run in CI, locally, and under
# front-desk-projection.test.sh; the workflow keeps the schedule, the mint and
# the push, this file owns the query and the transform.
#
# WHY THIS EXISTS (#431). A session can WRITE a claim — claim-ticket.yml is a
# workflow and it resolves — but it cannot READ the board it is claiming
# against. `organization_projects` is minted via OIDC at the broker, which needs
# `id-token: write` INSIDE Actions; the session's own GitHub surface has no
# Projects tool and there is no `gh` in the container. So "every session's work
# ties to a Front Desk claim" runs against a board no session can see, and
# sessions fall back to ranking issue titles by eye. This makes the board
# readable off disk instead.
#
# Requires: bash, curl, jq. GITHUB_TOKEN must carry organization_projects
# (read is sufficient here; the caller asserts the level before invoking).
set -euo pipefail

# TEST SEAMS. The defaults ARE the contract; the variables exist so the test can
# point the query at a fixture and pin the org/number without a live board.
# `curl` is stubbed via PATH, which needs no seam.
: "${FRONT_DESK_GRAPHQL_URL:=https://api.github.com/graphql}"
: "${FRONT_DESK_ORG:=bounded-systems}"
: "${FRONT_DESK_PROJECT_NUMBER:=2}"
# Bounded so a runaway board cannot spin forever. 100 items/page, so this is
# 20k items of headroom. If it is ever hit the run FAILS rather than emitting a
# truncated snapshot that looks complete — a partial board read as whole is the
# failure this file exists to stop repeating at a different layer.
#
# THIS WAS 20 AND THAT WAS WRONG, measured: run 31606018465, the lane's first
# live firing, hit the cap. 20 pages assumed the board held only OPEN work
# (~92 repos' worth). It does not — Done items stay on the board, so the real
# figure is the org's whole history of tracked work, not its backlog. The cap
# is a runaway guard, not a size estimate, so it is set far above any plausible
# board; the non-advancing-cursor check below is what actually stops a loop.
: "${FRONT_DESK_MAX_PAGES:=200}"

# ── the query ────────────────────────────────────────────────────────────────
# Printed by `--query` so the test can assert that what we ASK for and what the
# transform READS stay in agreement. A transform reading a field the query stops
# requesting degrades silently to null, which on this board means "unranked" and
# would quietly sink every item — so the agreement is pinned rather than trusted.
#
# fieldValues covers the four value types the board actually uses (single-select
# Status/Kind, number Score/Effort/Value, text, date). Field NAMES are not
# hardcoded: they are flattened generically below, so a board rename shows up as
# a renamed key rather than a crash or a silent null.
#
# `id` IS THE ITEM'S ProjectV2 NODE ID — the `PVTI_…` — and it is requested at
# the ITEM level deliberately, not from `content` (#543). It is not decoration:
# it is the only key this snapshot and the lease plane can share.
#
# The lease Worker addresses one Durable Object per item, keyed by the caller's
# `item_id` string put through `canonicalItemId` — trim and lowercase, nothing
# else (front-desk-scheduler → worker/lease/src/lease-core.mjs). Real claims are
# taken with the board row's node id: `src/verbs.ts` hands `row.id` to the CAS,
# and docs/claiming-from-a-session.md shows `item_id: "PVTI_lADO…"`. So live
# leases sit under `pvti_…` keys and nothing else.
#
# Until now this projection emitted `repo` and `number` but no node id, so the
# two credential-free surfaces a session has — this snapshot and
# `GET $FDS_CLAIM_ENDPOINT/status` — had NO key in common. A session that probed
# `/status?item_id=repo#number` addressed a DO that had never held anything and
# got the empty-lease shape back, which is byte-identical to a genuinely
# unclaimed item: measured 2026-08-16, `/status` for `.github-private#543`, for a
# fabricated `PVTI_lADOCnonexistent` and for the string `totally-made-up-…` all
# returned `{"holder":null,"fencing":0,"expiresAt":null,"live":false,
# "referent":null}`. A read-before-claim check built on that answer would pass
# precisely when it must refuse — worse than no check, so #529 decision 4 stayed
# unwired until this field existed. Emitting it here is the enabling half; the
# convention documents the check only once this lane has actually published.
query_text() {
  cat <<'GQL'
query($org:String!, $number:Int!, $cursor:String) {
  organization(login:$org) {
    projectV2(number:$number) {
      title
      items(first:100, after:$cursor) {
        pageInfo { hasNextPage endCursor }
        nodes {
          id
          isArchived
          fieldValues(first:20) {
            nodes {
              __typename
              ... on ProjectV2ItemFieldSingleSelectValue { name  field { ... on ProjectV2FieldCommon { name } } }
              ... on ProjectV2ItemFieldNumberValue       { number field { ... on ProjectV2FieldCommon { name } } }
              ... on ProjectV2ItemFieldTextValue         { text  field { ... on ProjectV2FieldCommon { name } } }
              ... on ProjectV2ItemFieldDateValue         { date  field { ... on ProjectV2FieldCommon { name } } }
            }
          }
          content {
            __typename
            ... on Issue {
              number title url state
              repository { nameWithOwner isPrivate }
              assignees(first:10) { nodes { login } }
              labels(first:20)    { nodes { name } }
            }
            ... on PullRequest {
              number title url state
              repository { nameWithOwner isPrivate }
              assignees(first:10) { nodes { login } }
              labels(first:20)    { nodes { name } }
            }
            ... on DraftIssue { title }
          }
        }
      }
    }
  }
}
GQL
}

# ── fetch ────────────────────────────────────────────────────────────────────
# Emits one raw GraphQL response per line (JSONL) — the pages, unmerged. Follows
# `hasNextPage` itself rather than leaving the cursor loop inline in the
# workflow: untested inline shell in a workflow is the shape #399 is open about,
# and pagination is precisely where a quiet truncation would live.
fetch_pages() {
  local cursor=null page=0 body resp next
  while :; do
    page=$((page + 1))
    if [ "$page" -gt "$FRONT_DESK_MAX_PAGES" ]; then
      echo "::error title=Front Desk projection did NOT run::the board paged past FRONT_DESK_MAX_PAGES=$FRONT_DESK_MAX_PAGES. Refusing to emit a truncated snapshot that would read as a complete board. Raise the cap deliberately after checking why the board grew." >&2
      return 1
    fi

    body="$(jq -nc \
      --arg q "$(query_text)" \
      --arg org "$FRONT_DESK_ORG" \
      --argjson num "$FRONT_DESK_PROJECT_NUMBER" \
      --argjson cur "$cursor" \
      '{query:$q, variables:{org:$org, number:$num, cursor:$cur}}')"

    if ! resp="$(curl -fsS --max-time 30 \
      -H "Authorization: bearer ${GITHUB_TOKEN:-}" \
      -H "Content-Type: application/json" \
      -X POST -d "$body" "$FRONT_DESK_GRAPHQL_URL")"; then
      echo "::error title=Front Desk projection did NOT run::the GraphQL fetch failed against $FRONT_DESK_GRAPHQL_URL. No snapshot written; the previous one keeps its own generated_at and will age out on the reader's side rather than being silently replaced by a partial." >&2
      return 1
    fi

    # A 2xx IS NOT SUCCESS on GraphQL: errors ride in the body with a 200. Same
    # lesson as service-status-reconcile.sh's non-JSON check, one protocol up.
    if ! jq -e 'type == "object" and has("data") and (.errors | not)' >/dev/null 2>&1 <<<"$resp"; then
      echo "::error title=Front Desk projection did NOT run::GraphQL answered without usable data. First 200 chars: $(head -c 200 <<<"$resp" | tr -d '\n')" >&2
      return 1
    fi

    printf '%s\n' "$resp"

    if [ "$(jq -r '.data.organization.projectV2.items.pageInfo.hasNextPage' <<<"$resp")" != "true" ]; then
      return 0
    fi

    # THE CURSOR MUST ADVANCE. If the endCursor we get back equals the one we
    # just sent, the next request re-fetches this same page — an infinite loop
    # that the page cap would eventually stop while blaming the board's SIZE for
    # a bug in this loop. Those are different failures with different fixes
    # (raise the cap vs. fix the query), so they get different errors; run
    # 31606018465 could not tell them apart and cost a round to diagnose.
    # `hasNextPage: true` with a null endCursor lands here too, which is correct
    # — it is the same defect wearing a different value.
    next="$(jq -c '.data.organization.projectV2.items.pageInfo.endCursor' <<<"$resp")"
    if [ "$next" = "$cursor" ]; then
      echo "::error title=Front Desk projection did NOT run::the GraphQL cursor did not advance — page $page returned the same endCursor ($next) it was given, so paging would repeat this page forever. This is a defect in the query or in this loop, NOT a board that outgrew FRONT_DESK_MAX_PAGES; raising the cap would only make it spin longer." >&2
      return 1
    fi
    cursor="$next"
  done
}

# ── transform ────────────────────────────────────────────────────────────────
# stdin: the JSONL pages. stdout: the snapshot.
#
# `generated_at` is REQUIRED and second-precision RFC 3339 UTC, matching the
# contract in docs/handoffs/service-status-layer.md — consumers MUST enforce its
# age. It is stamped unconditionally on every successful read, which is the
# deliberate reversal that doc records (#276): a snapshot that skips the write
# when nothing changed goes on looking authoritative while its stamp rots.
#
# ARCHIVED items are dropped; DRAFT items are kept but carry no repo/number,
# because they are real board rows a session would otherwise be blind to.
#
# What is NOT derived here: the lifecycle state. work-unit-lifecycle.md maps
# Plan, Active AND Review all onto board status "In Progress", so the board
# alone cannot separate them — the distinction lives in the attestation records,
# not in a project field. Emitting a guessed `state` would be the projection
# claiming to know something it cannot. `board_status` is passed through
# verbatim and the reader is left to say only what the board says.
to_projection() {
  local now="$1"
  jq -s --arg now "$now" --arg org "$FRONT_DESK_ORG" --argjson num "$FRONT_DESK_PROJECT_NUMBER" '
    {
      generated_at: $now,
      project: {
        org: $org,
        number: $num,
        title: (.[0].data.organization.projectV2.title // null)
      },
      items: [
        .[].data.organization.projectV2.items.nodes[]?
        | select(.isArchived != true)
        | select(.content != null)
        | {
            type: .content.__typename,
            # The ProjectV2 ITEM node id (`PVTI_…`), verbatim — the key the lease
            # plane claims under. NOT lowercased here: `canonicalItemId` owns
            # that, and a second place that also normalises is a second chance
            # for the two to disagree, which is the one thing A2′ cannot afford.
            # Null on a snapshot whose query predates the field, so a consumer
            # can tell "this item has no id" from "this snapshot has no ids".
            item_id: (.id // null),
            repo: (.content.repository.nameWithOwner // null),
            # Visibility as GitHub reports it AT SNAPSHOT TIME — the only
            # authoritative source for "may this row be published". Carried as a
            # tri-state on purpose: true / false / null, where null means the
            # snapshot could not establish visibility (a query predating this
            # field, a draft with no repo). front-desk-public.sh treats anything
            # other than an explicit `false` as private, so an unknown never
            # becomes a leak.
            # NO alternative operator here, and that is load-bearing. In jq,
            # the // operator treats false as empty, so isPrivate // null maps a
            # PUBLIC repo (false) to null — and default-deny on the public feed
            # then drops precisely the rows it exists to publish. That shipped
            # once: the first real run emitted 0 public items out of 2748, every
            # one of them null. A bare field access already yields null for a
            # missing key or a null repository, so it is correct and shorter.
            # (Apostrophes are also forbidden in this comment: the whole jq
            # program is a single-quoted shell string, and one would end it.)
            repo_private: .content.repository.isPrivate,
            number: (.content.number // null),
            title: (.content.title // null),
            url: (.content.url // null),
            issue_state: (.content.state // null),
            assignees: [.content.assignees.nodes[]?.login],
            labels: [.content.labels.nodes[]?.name],
            # Both operands must be evaluated against the ITEM. Parenthesise the
            # first: without it the `|` scope carries into the second operand,
            # which then indexes the label array with "content" — and `or`
            # short-circuits, so it only breaks on rows that are NOT
            # label-claimed. Caught by the unclaimed fixture, not by the happy path.
            claimed: (([.content.labels.nodes[]?.name] | index("claimed")) != null
                      or ([.content.assignees.nodes[]?.login] | length) > 0),
            fields: (
              [ .fieldValues.nodes[]?
                | select(.field.name != null)
                | { key: .field.name,
                    value: (if   has("name")   then .name
                            elif has("number") then .number
                            elif has("text")   then .text
                            elif has("date")   then .date
                            else null end) }
              ] | from_entries
            )
          }
      ]
    }
    | .counts = (
        .items
        | group_by(.fields.Status // "(no status)")
        | map({ key: (.[0].fields.Status // "(no status)"), value: length })
        | from_entries
      )
  '
}

main() {
  if [ "${1:-}" = "--query" ]; then
    query_text
    return 0
  fi
  local now
  now="$(date -u +%FT%TZ)"
  fetch_pages | to_projection "$now"
}

# Sourced by the test (to reach query_text/to_projection directly) or run.
if [ "${BASH_SOURCE[0]}" = "${0}" ]; then
  main "$@"
fi
