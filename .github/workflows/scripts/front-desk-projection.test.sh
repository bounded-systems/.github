#!/usr/bin/env bash
# Behavior tests for front-desk-projection.sh — fixtures + a stubbed `curl`,
# no network, no GitHub. Run from anywhere:
#
#   bash .github/workflows/scripts/front-desk-projection.test.sh
#
# The snapshot's bad failure mode is not a crash. It is emitting something that
# LOOKS like a complete, current board when it is neither: a truncated page set,
# a stale stamp, or a silent null where a rank used to be. A session that reads
# a wrong snapshot picks the wrong work and has no way to tell. So the pins here
# are mostly about refusing to emit rather than about happy-path shape.
#
# CI runs this from _workflow-lint.yml. Any edit under .github/workflows/ sets
# the classifier's `workflows` flag, so the projection cannot change without
# this file getting its say.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT="$here/front-desk-projection.sh"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

pass=0
fail=0
ok()   { pass=$((pass + 1)); echo "  ok   — $1"; }
bad()  { fail=$((fail + 1)); echo "  FAIL — $1"; }
check() { if [ "$2" = "$3" ]; then ok "$1"; else bad "$1 (want [$3], got [$2])"; fi; }

# ── stub curl ────────────────────────────────────────────────────────────────
# Answers with $CURL_PAGES_DIR/page-N.json in sequence, N tracked in a counter
# file. Exits non-zero when $CURL_FAIL is set, so the fetch-failure path is
# reachable without a network.
mkdir -p "$work/bin"
# It also RECORDS each request (newlines squeezed out, so one call is one line)
# to $CURL_ARGS. Without that the stub answered page N purely from a counter and
# ignored the cursor entirely — so the pagination test passed while proving
# nothing about whether a cursor is threaded at all. That gap is what let a
# non-advancing cursor be indistinguishable from a large board in run
# 31606018465.
cat > "$work/bin/curl" <<'STUB'
#!/usr/bin/env bash
if [ -n "${CURL_FAIL:-}" ]; then exit 22; fi
printf '%s\n' "$(printf '%s' "$*" | tr -d '\n')" >> "$CURL_ARGS"
n=$(( $(cat "$CURL_COUNTER") + 1 ))
echo "$n" > "$CURL_COUNTER"
f="$CURL_PAGES_DIR/page-$n.json"
if [ ! -f "$f" ]; then echo "stub curl: no fixture $f" >&2; exit 22; fi
cat "$f"
STUB
chmod +x "$work/bin/curl"
export PATH="$work/bin:$PATH"
export CURL_COUNTER="$work/counter"
export CURL_PAGES_DIR="$work/pages"
export CURL_ARGS="$work/curl-args.log"
export GITHUB_TOKEN=stub-token
mkdir -p "$CURL_PAGES_DIR"

reset_stub() { rm -f "$CURL_PAGES_DIR"/*.json; echo 0 > "$CURL_COUNTER"; : > "$CURL_ARGS"; unset CURL_FAIL; }

# A page fixture. $1 = file, $2 = hasNextPage, $3 = items JSON array,
# $4 = endCursor (default "CUR"). The cursor is a parameter because "every page
# hands back the same cursor" and "the board has more pages than the cap" are
# now different failures, and a fixture set has to be able to express each.
page() {
  jq -n --argjson has "$2" --argjson items "$3" --arg cur "${4:-CUR}" '{
    data: { organization: { projectV2: {
      title: "Front Desk",
      items: { pageInfo: { hasNextPage: $has, endCursor: $cur }, nodes: $items }
    } } }
  }' > "$1"
}

# The `id` on each fixture is the ProjectV2 ITEM node id. Mixed case on purpose:
# real ones look like `PVTI_lADO…`, the lease plane lowercases them itself in
# `canonicalItemId`, and this projection must NOT — see the verbatim pin below.
item_issue='{
  "id": "PVTI_lADOBoardXAAxYz",
  "isArchived": false,
  "fieldValues": { "nodes": [
    { "__typename": "ProjectV2ItemFieldSingleSelectValue", "name": "In Progress", "field": { "name": "Status" } },
    { "__typename": "ProjectV2ItemFieldNumberValue", "number": 42, "field": { "name": "Score" } }
  ] },
  "content": {
    "__typename": "Issue", "number": 429, "title": "Resumed-session bootstrap", "state": "OPEN",
    "url": "https://github.com/bounded-systems/.github-private/issues/429",
    "repository": { "nameWithOwner": "bounded-systems/.github-private" },
    "assignees": { "nodes": [] },
    "labels": { "nodes": [ { "name": "claimed" } ] }
  }
}'

item_archived='{
  "id": "PVTI_lADOBoardXAArCh",
  "isArchived": true, "fieldValues": { "nodes": [] },
  "content": { "__typename": "Issue", "number": 1, "title": "old", "state": "CLOSED", "url": "u",
    "repository": { "nameWithOwner": "o/r" }, "assignees": { "nodes": [] }, "labels": { "nodes": [] } }
}'

item_draft='{
  "id": "PVTI_lADOBoardXAADrF",
  "isArchived": false,
  "fieldValues": { "nodes": [ { "__typename": "ProjectV2ItemFieldSingleSelectValue", "name": "Todo", "field": { "name": "Status" } } ] },
  "content": { "__typename": "DraftIssue", "title": "a draft row" }
}'

item_unassigned='{
  "id": "PVTI_lADOBoardXAAuNa",
  "isArchived": false,
  "fieldValues": { "nodes": [ { "__typename": "ProjectV2ItemFieldNumberValue", "number": 7, "field": { "name": "Score" } } ] },
  "content": { "__typename": "Issue", "number": 400, "title": "unclaimed", "state": "OPEN", "url": "u",
    "repository": { "nameWithOwner": "o/r" }, "assignees": { "nodes": [] }, "labels": { "nodes": [] } }
}'

# ── 1. happy path: shape, stamp, passthrough ─────────────────────────────────
echo "1. a single page projects to a snapshot"
reset_stub
page "$CURL_PAGES_DIR/page-1.json" false "[$item_issue]"
out="$(bash "$SCRIPT")"

check "one item"            "$(jq -r '.items | length' <<<"$out")" "1"
check "repo passed through" "$(jq -r '.items[0].repo' <<<"$out")"  "bounded-systems/.github-private"
check "number passed through" "$(jq -r '.items[0].number' <<<"$out")" "429"
check "board status verbatim" "$(jq -r '.items[0].fields.Status' <<<"$out")" "In Progress"
check "number field kept numeric" "$(jq -r '.items[0].fields.Score' <<<"$out")" "42"
check "project number recorded" "$(jq -r '.project.number' <<<"$out")" "2"

# ── item_id: the key this snapshot shares with the lease plane (#543) ─────────
# Without it the snapshot and `GET /status` have no key in common, and a
# read-before-claim probe keyed on `repo#number` addresses a Durable Object that
# has never held anything — returning the empty-lease shape, which is
# byte-identical to a genuinely unclaimed item. That check would pass exactly
# when it must refuse, so these pins are about a FAIL-OPEN, not about a shape.
check "item_id passed through" "$(jq -r '.items[0].item_id' <<<"$out")" "PVTI_lADOBoardXAAxYz"

# VERBATIM — no case folding here. `canonicalItemId` (front-desk-scheduler →
# worker/lease/src/lease-core.mjs) trims and lowercases, and it must stay the
# ONE function that derives the routing key: A2′ says every claimant for an item
# reaches the same DO instance, and a second normaliser is a second chance for
# the two to drift apart. Lowercasing here would look harmless and identical in
# every test that compares against a lowercase literal.
check "item_id is not case-folded" \
  "$(jq -r '.items[0].item_id | test("^PVTI_")' <<<"$out")" "true"

# generated_at is the contract that lets a reader refuse a stale snapshot. RFC
# 3339, UTC, second-precision — the shape docs/handoffs/service-status-layer.md
# already requires of the status snapshot, reused rather than reinvented.
stamp="$(jq -r '.generated_at' <<<"$out")"
if [[ "$stamp" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$ ]]; then
  ok "generated_at is second-precision RFC 3339 UTC"
else
  bad "generated_at shape (got [$stamp])"
fi

# NO lifecycle state is invented. Plan/Active/Review all sit under "In Progress"
# on the board, so a `state` key here could only be a guess dressed as data.
check "no derived lifecycle state" "$(jq -r 'has("state") or (.items[0] | has("state"))' <<<"$out")" "false"

# ── 2. claimed ───────────────────────────────────────────────────────────────
echo "2. claimed is true on either signal, false on neither"
check "label ⇒ claimed" "$(jq -r '.items[0].claimed' <<<"$out")" "true"

reset_stub
page "$CURL_PAGES_DIR/page-1.json" false "[$item_unassigned]"
out2="$(bash "$SCRIPT")"
check "no label, no assignee ⇒ unclaimed" "$(jq -r '.items[0].claimed' <<<"$out2")" "false"

assigned="$(jq -c '.content.assignees.nodes = [{"login":"someone"}]' <<<"$item_unassigned")"
reset_stub
page "$CURL_PAGES_DIR/page-1.json" false "[$assigned]"
check "assignee ⇒ claimed" \
  "$(bash "$SCRIPT" | jq -r '.items[0].claimed')" "true"

# ── 3. archived dropped, drafts kept ─────────────────────────────────────────
echo "3. archived rows drop; draft rows survive"
reset_stub
page "$CURL_PAGES_DIR/page-1.json" false "[$item_issue,$item_archived,$item_draft]"
out3="$(bash "$SCRIPT")"
check "archived dropped"  "$(jq -r '.items | length' <<<"$out3")" "2"
check "draft kept"        "$(jq -r '[.items[] | select(.type=="DraftIssue")] | length' <<<"$out3")" "1"
check "draft has null repo" "$(jq -r '[.items[] | select(.type=="DraftIssue")][0].repo' <<<"$out3")" "null"
# A draft has no repo and no number, so `item_id` is the ONLY thing that
# addresses it. It comes off the item node, not off `content`, which is exactly
# why the query asks at the item level.
check "draft still carries item_id" \
  "$(jq -r '[.items[] | select(.type=="DraftIssue")][0].item_id' <<<"$out3")" "PVTI_lADOBoardXAADrF"

# A snapshot published BEFORE the query asked for `id` has no ids at all. That
# must read as null — "this snapshot cannot answer" — and never as a string a
# consumer would go on to probe `/status` with.
reset_stub
page "$CURL_PAGES_DIR/page-1.json" false "[$(jq -c 'del(.id)' <<<"$item_issue")]"
check "an item with no id projects to null, not to a fabricated key" \
  "$(bash "$SCRIPT" | jq -r '.items[0].item_id')" "null"

# ── 4. pagination ────────────────────────────────────────────────────────────
echo "4. pagination follows hasNextPage and merges every page"
reset_stub
page "$CURL_PAGES_DIR/page-1.json" true  "[$item_issue]"
page "$CURL_PAGES_DIR/page-2.json" false "[$item_unassigned]"
out4="$(bash "$SCRIPT")"
check "both pages present" "$(jq -r '.items | length' <<<"$out4")" "2"
check "page 2 item present" "$(jq -r '[.items[] | select(.number==400)] | length' <<<"$out4")" "1"
check "stub was called twice" "$(cat "$CURL_COUNTER")" "2"

# The cursor must actually be THREADED, not just the page count reached. The
# stub answers from a counter, so without these two the loop could ignore
# pageInfo entirely and still look correct here.
check "page 1 asks with a null cursor" \
  "$(sed -n '1p' "$CURL_ARGS" | grep -c '"cursor":null')" "1"
check "page 2 asks with page 1's endCursor" \
  "$(sed -n '2p' "$CURL_ARGS" | grep -c '"cursor":"CUR"')" "1"

# ── 5. counts ────────────────────────────────────────────────────────────────
echo "5. counts group by the board's own status values"
check "In Progress counted" "$(jq -r '.counts["In Progress"]' <<<"$out4")" "1"
check "status-less item bucketed, not dropped" "$(jq -r '.counts["(no status)"]' <<<"$out4")" "1"

# ── 6. refusals — the cases that must NOT emit a snapshot ────────────────────
# Each of these would otherwise produce a partial or empty board that reads as
# authoritative. A reader cannot tell "the board is empty" from "the read broke"
# unless the read refuses, so these are the load-bearing tests.
echo "6. broken reads refuse rather than emitting a plausible snapshot"

# A GOOD fixture is laid down first, so the ONLY reason this can fail is the
# simulated curl failure. Without it the stub exits on "no fixture" instead and
# the assertion passes for the wrong reason — which is exactly what happened
# until shellcheck's SC2034 pointed out that CURL_FAIL was never exported, and
# so was never visible to the stub (a child process) at all.
reset_stub
page "$CURL_PAGES_DIR/page-1.json" false "[$item_issue]"
export CURL_FAIL=1
if bash "$SCRIPT" >/dev/null 2>&1; then bad "fetch failure must be fatal"; else ok "fetch failure is fatal"; fi
unset CURL_FAIL
# ...and with the same fixture and no CURL_FAIL it must SUCCEED, or the check
# above proves nothing about curl.
if bash "$SCRIPT" >/dev/null 2>&1; then ok "same fixture succeeds without CURL_FAIL"; else bad "control case should succeed"; fi

reset_stub
echo '{"data":null,"errors":[{"message":"Could not resolve to an Organization"}]}' > "$CURL_PAGES_DIR/page-1.json"
if bash "$SCRIPT" >/dev/null 2>&1; then bad "200-with-errors must be fatal"; else ok "200-with-errors is fatal"; fi

reset_stub
echo 'not json at all' > "$CURL_PAGES_DIR/page-1.json"
if bash "$SCRIPT" >/dev/null 2>&1; then bad "non-JSON body must be fatal"; else ok "non-JSON body is fatal"; fi

# A CURSOR THAT DOES NOT ADVANCE is a bug in the query or the loop; a board past
# the cap is a board that grew. Both loop, so before the cursor check existed
# they produced the SAME error and run 31606018465 spent a round blaming the
# board's size for what might have been either. These pin them apart.
echo "   (non-advancing cursor)"
reset_stub
page "$CURL_PAGES_DIR/page-1.json" true "[$item_issue]"
page "$CURL_PAGES_DIR/page-2.json" true "[$item_unassigned]"   # same endCursor, "CUR"
err="$(bash "$SCRIPT" 2>&1 >/dev/null || true)"
if grep -q 'did not advance' <<<"$err"; then
  ok "non-advancing cursor is fatal, and says so"
else
  bad "expected a cursor error, got: $(head -c 140 <<<"$err")"
fi
# Matched on the cap error's own phrase, not on "MAX_PAGES": the cursor error
# names MAX_PAGES deliberately, to tell the reader this is NOT that. Grepping
# for the shared token made the two indistinguishable to the test even though
# they read completely differently to a human.
if grep -q 'paged past' <<<"$err"; then
  bad "a cursor bug was misreported as the board outgrowing the cap"
else
  ok "a cursor bug is not blamed on board size"
fi

# A board that never stops paging must fail, not silently truncate.
echo "   (max-pages guard)"
reset_stub

# DISTINCT cursors per page, so this exercises the cap and not the
# non-advancing check above — the two must stay separable in the fixtures.
for n in 1 2 3; do page "$CURL_PAGES_DIR/page-$n.json" true "[$item_issue]" "CUR$n"; done
caperr="$(FRONT_DESK_MAX_PAGES=2 bash "$SCRIPT" 2>&1 >/dev/null || true)"
if grep -q "paged past" <<<"$caperr"; then
  ok "paging past the cap is fatal (no truncated snapshot)"
else
  bad "expected the cap error, got: $(head -c 140 <<<"$caperr")"
fi
if grep -q 'did not advance' <<<"$caperr"; then
  bad "a genuinely long board was misreported as a cursor bug"
else
  ok "a long board is not blamed on the cursor"
fi

# ── 7. query ↔ transform agreement ───────────────────────────────────────────
# A transform reading a field the query stopped requesting degrades to null. On
# this board null Score means unranked, which would quietly sink every item —
# so the two are pinned to each other rather than trusted to stay in step.
echo "7. the query asks for everything the transform reads"
q="$(bash "$SCRIPT" --query)"
for field in isArchived nameWithOwner assignees labels pageInfo hasNextPage endCursor fieldValues; do
  if grep -q "$field" <<<"$q"; then ok "query requests $field"; else bad "query is missing $field"; fi
done
for t in SingleSelectValue NumberValue TextValue DateValue; do
  if grep -q "$t" <<<"$q"; then ok "query handles $t"; else bad "query is missing $t"; fi
done

# `id` gets its own pin rather than joining the substring loop above. A bare
# `grep -q id` would be satisfied by any nested id the query might grow later —
# an Issue id, a repository id — none of which is the key the lease plane uses.
# Anchoring on a standalone `id` line matches the ITEM-level field and only that.
if grep -qE '^[[:space:]]*id[[:space:]]*$' <<<"$q"; then
  ok "query requests the item-level id"
else
  bad "query is missing the item-level id — item_id would silently project to null for every row"
fi

# ── repo_private must survive as a TRI-STATE, false included ────────────────
# The regression this pins actually shipped: `isPrivate // null` mapped a PUBLIC
# repo (false) to null, because jq's alternative operator treats false as empty.
# The public feed is default-deny, so null means "drop" — and the first real run
# published 0 of 2748 rows, every one of them a public repo that should have been
# in the feed. The guard failed SAFE, which is why this was a quiet emptiness
# rather than a leak, but a feed that publishes nothing is still broken.
#
# false and null must stay distinguishable here: false = known public, null =
# visibility unestablished. Collapsing them is exactly the defect.
priv_probe() {
  printf '%s' "$1" | jq -c '
    { repo_private: .content.repository.isPrivate }
  '
}
check "isPrivate:false projects as false, not null (the shipped regression)" \
  "$(priv_probe '{"content":{"repository":{"nameWithOwner":"o/r","isPrivate":false}}}')" \
  '{"repo_private":false}'
check "isPrivate:true projects as true" \
  "$(priv_probe '{"content":{"repository":{"nameWithOwner":"o/r","isPrivate":true}}}')" \
  '{"repo_private":true}'
check "a missing isPrivate projects as null (unestablished, not public)" \
  "$(priv_probe '{"content":{"repository":{"nameWithOwner":"o/r"}}}')" \
  '{"repo_private":null}'

# And the projection script itself must not reintroduce the operator on this field.
# Comments are stripped first: the fix'"'"'s own explanation names the bad pattern in
# prose, and a grep over the whole file would match the warning rather than the
# defect — a check that fires on its own documentation.
if grep -v '^[[:space:]]*#' "$SCRIPT" | grep -q 'isPrivate // null'; then
  bad "projection reintroduced 'isPrivate // null' — false would collapse to null again"
else
  ok "projection does not guard isPrivate with the alternative operator"
fi

if grep -q 'repository { nameWithOwner isPrivate }' "$SCRIPT"; then
  ok "query requests repository visibility"
else
  bad "query is missing repository.isPrivate — every row would project null and the public feed would empty out"
fi

echo
echo "front-desk-projection: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
