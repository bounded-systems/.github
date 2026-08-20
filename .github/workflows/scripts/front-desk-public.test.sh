#!/usr/bin/env bash
# Leak-guard tests for front-desk-public.sh. No network, no GitHub.
#
#   bash .github/workflows/scripts/front-desk-public.test.sh
#
# THIS FILE IS THE POINT OF THE FEATURE. A visibility filter is a claim that
# something cannot appear, and per docs/agentic-code-hygiene.md rule 3 a gate's
# own claim about itself is not evidence — so the pins below are written as
# ATTEMPTS TO LEAK, not as happy-path shape checks. The fixture carries a
# private-repo row whose title is a distinctive string, and the tests assert
# that string appears nowhere in the output: not in items, not in counts, not in
# a stray field that got carried along.
#
# CI runs this from _workflow-lint.yml with its sibling: any edit under
# .github/workflows/ sets the classifier's `workflows` flag.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT="$here/front-desk-public.sh"

pass=0
fail=0
ok()   { pass=$((pass + 1)); echo "  ok   — $1"; }
bad()  { fail=$((fail + 1)); echo "  FAIL — $1"; }
check() { if [ "$2" = "$3" ]; then ok "$1"; else bad "$1 (want [$3], got [$2])"; fi; }

# A distinctive, unmistakable string: if this ever appears in output, a real
# private title reached a public surface.
SECRET="CONFIDENTIAL-ACQUISITION-CODENAME-BLUEJAY"

fixture() {
  cat <<JSON
{
  "generated_at": "2026-08-20T23:00:00Z",
  "project": { "org": "bounded-systems", "number": 2, "title": "Front Desk" },
  "items": [
    { "type": "Issue", "item_id": "PVTI_pub1", "repo": "bounded-systems/prx", "number": 434,
      "title": "Cut the signing release", "url": "https://github.com/bounded-systems/prx/issues/434",
      "issue_state": "OPEN", "assignees": [], "labels": [], "claimed": false,
      "repo_private": false, "fields": { "Status": "Todo", "Score": 17.3 } },

    { "type": "Issue", "item_id": "PVTI_priv1", "repo": "bounded-systems/.github-private", "number": 999,
      "title": "$SECRET", "url": "https://github.com/bounded-systems/.github-private/issues/999",
      "issue_state": "OPEN", "assignees": ["someone"], "labels": ["secret"], "claimed": false,
      "repo_private": true, "fields": { "Status": "Todo", "Score": 99.9 } },

    { "type": "Issue", "item_id": "PVTI_unknown", "repo": "bounded-systems/mystery", "number": 7,
      "title": "$SECRET-UNKNOWN-VISIBILITY", "url": "https://github.com/bounded-systems/mystery/issues/7",
      "issue_state": "OPEN", "assignees": [], "labels": [], "claimed": false,
      "repo_private": null, "fields": { "Status": "Todo", "Score": 5.0 } },

    { "type": "DraftIssue", "item_id": "PVTI_draft", "repo": null, "number": null,
      "title": "$SECRET-DRAFT", "url": null,
      "issue_state": null, "assignees": [], "labels": [], "claimed": false,
      "repo_private": null, "fields": { "Status": "Todo" } },

    { "type": "Issue", "item_id": "PVTI_pub2", "repo": "bounded-systems/guest-room", "number": 12,
      "title": "Doors doc", "url": "https://github.com/bounded-systems/guest-room/issues/12",
      "issue_state": "OPEN", "assignees": ["someone"], "labels": [], "claimed": true,
      "repo_private": false, "fields": { "Status": "In Progress" } }
  ],
  "counts": { "Todo": 4, "In Progress": 1 }
}
JSON
}

out="$(fixture | bash "$SCRIPT")"

echo "front-desk-public:"

# ── the leak guard, stated as an attempt rather than an assertion of virtue ───
if printf '%s' "$out" | grep -q "$SECRET"; then
  bad "LEAK: the private/unknown marker string appears in the public output"
else
  ok "no private or unknown-visibility title anywhere in the output"
fi

# ── row filtering, case by case ──────────────────────────────────────────────
check "only the two public rows survive" \
  "$(printf '%s' "$out" | jq '.items | length')" "2"
check "the public repos are exactly the ones expected" \
  "$(printf '%s' "$out" | jq -r '[.items[].repo] | sort | join(",")')" \
  "bounded-systems/guest-room,bounded-systems/prx"
check "repo_private:true is dropped" \
  "$(printf '%s' "$out" | jq '[.items[] | select(.repo == "bounded-systems/.github-private")] | length')" "0"
check "repo_private:null (unknown) is dropped — unknown is not permission" \
  "$(printf '%s' "$out" | jq '[.items[] | select(.repo == "bounded-systems/mystery")] | length')" "0"
check "a draft with no repo is dropped" \
  "$(printf '%s' "$out" | jq '[.items[] | select(.repo == null)] | length')" "0"

# ── field allowlisting: a key nobody thought about must not ride along ───────
check "assignees is not republished" \
  "$(printf '%s' "$out" | jq '[.items[] | select(has("assignees"))] | length')" "0"
check "repo_private itself is not echoed into the public feed" \
  "$(printf '%s' "$out" | jq '[.items[] | select(has("repo_private"))] | length')" "0"

# An unexpected upstream key must NOT survive: this is the regression that field
# allowlisting exists to prevent, and it can only be proven by adding one.
sneaky="$(fixture | jq '.items[0].internal_note = "do-not-publish-me"' | bash "$SCRIPT")"
if printf '%s' "$sneaky" | grep -q "do-not-publish-me"; then
  bad "LEAK: an unknown upstream field rode along into the public feed"
else
  ok "an unknown upstream field is dropped (fields are allowlisted, not denylisted)"
fi

# ── counts describe the FILTERED board, not the private one ─────────────────
check "counts are recomputed over public rows only (Todo)" \
  "$(printf '%s' "$out" | jq -r '.counts.Todo')" "1"
check "item_count matches the emitted rows" \
  "$(printf '%s' "$out" | jq -r '.item_count')" "2"

# ── the feed must remain self-describing and age-checkable ──────────────────
check "generated_at is carried through verbatim" \
  "$(printf '%s' "$out" | jq -r '.generated_at')" "2026-08-20T23:00:00Z"
check "the feed names itself" \
  "$(printf '%s' "$out" | jq -r '.feed')" "front-desk-public"
check "the feed states the filter that produced it" \
  "$(printf '%s' "$out" | jq -r '.visibility_filter')" "repo_private == false (default-deny)"

# ── an empty public board must still be a valid, dated snapshot ─────────────
empty="$(fixture | jq '[.items[] | select(.repo_private != false)] as $p | .items = $p' | bash "$SCRIPT")"
check "an all-private board yields zero items, not an error" \
  "$(printf '%s' "$empty" | jq '.items | length')" "0"
check "…and still carries its stamp, so the reader can age-check it" \
  "$(printf '%s' "$empty" | jq -r '.generated_at')" "2026-08-20T23:00:00Z"

echo
echo "  $pass passed, $fail failed"
[ "$fail" -eq 0 ]
