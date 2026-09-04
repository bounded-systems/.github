#!/usr/bin/env bash
# Read the repo-standard conformance snapshot from a session.
#
#   bash .claude/repo-standard-conformance.sh          # totals + the repos with findings
#   bash .claude/repo-standard-conformance.sh -n 40    # more of them
#   bash .claude/repo-standard-conformance.sh --gaps   # what the lane could NOT measure
#
# repo-standard-conformance.yml sweeps the org's PUBLIC repos daily and publishes
# one JSON file on the `repo-standard-conformance` branch of this repo; this
# reads that branch. A session cannot make the sweep itself — the API 403s for
# any repo not attached (`.github-private`#481) — so this is the only way a
# session sees which repos call the standard and which do not.
#
# WHAT THIS IS NOT: a second opinion. It is the lane's own output, transported.
# Where it disagrees with a repo's actual workflows, the repo is right and this
# is stale — which is why the age is printed on every run and not only when
# something is wrong. A FINDING is the repo's (no caller, unpinned, filtered
# pull_request, toolchain without a test lane, red run); a GAP is the lane's
# (a listing it could not read). Never sum them.
set -euo pipefail

# The lane publishes daily; twice that is the same ratio front-desk.sh and
# repo-health.sh use. Over two days means at least one publish did not happen.
: "${RSC_MAX_AGE:=172800}"
: "${RSC_REF:=repo-standard-conformance}"
: "${RSC_REMOTE:=origin}"
: "${RSC_FILE:=}"   # set to read a local file instead of fetching

n=20
gaps=0
while [ $# -gt 0 ]; do
  case "$1" in
    -n) n="${2:?-n needs a count}"; shift 2 ;;
    --gaps) gaps=1; shift ;;
    -h|--help) sed -n '2,7p' "$0"; exit 0 ;;
    *) echo "repo-standard-conformance: unknown argument '$1'" >&2; exit 2 ;;
  esac
done

# ── get the snapshot ─────────────────────────────────────────────────────────
if [ -n "$RSC_FILE" ]; then
  [ -f "$RSC_FILE" ] || { echo "repo-standard-conformance: no such file: $RSC_FILE" >&2; exit 1; }
  body="$(cat "$RSC_FILE")"
else
  # --depth=1: the branch is main plus one commit holding the file; nothing to
  # walk. The branch is a moving ref, so refetch rather than trust a cached one.
  if ! git fetch --depth=1 "$RSC_REMOTE" "$RSC_REF" -q 2>/dev/null; then
    cat >&2 <<EOF
repo-standard-conformance: could not fetch $RSC_REMOTE/$RSC_REF.

This is NOT "every repo conforms" — it is "the snapshot could not be read",
and the two are not interchangeable. Either the lane has never published, or
this checkout cannot reach the remote. Check the lane before assuming the fleet
is clean:
  .github/workflows/repo-standard-conformance.yml  (daily)
EOF
    exit 1
  fi
  body="$(git show FETCH_HEAD:repo-standard-conformance.json 2>/dev/null)" || {
    echo "repo-standard-conformance: $RSC_REF exists but carries no repo-standard-conformance.json" >&2
    exit 1
  }
fi

# ── the snapshot must prove its age and its name before it is worth anything ─
if ! jq -e '.feed == "repo-standard-conformance" and has("repos") and has("totals") and (.generated_at | fromdateiso8601)' >/dev/null 2>&1 <<<"$body"; then
  echo "repo-standard-conformance: snapshot is malformed, misnamed, or has no parseable generated_at — refusing to present it as the fleet's state." >&2
  exit 1
fi

stamp="$(jq -r '.generated_at' <<<"$body")"
age="$(jq -r '(now - (.generated_at | fromdateiso8601)) | floor' <<<"$body")"
human="$((age / 60)) min"
[ "$age" -ge 3600 ] && human="$((age / 3600))h $(((age % 3600) / 60))m"
[ "$age" -ge 86400 ] && human="$((age / 86400))d $(((age % 86400) / 3600))h"

stale=0
[ "$age" -gt "$RSC_MAX_AGE" ] && stale=1

# ── report ───────────────────────────────────────────────────────────────────
if [ "$stale" = 1 ]; then
  cat >&2 <<EOF
┌─ STALE ─────────────────────────────────────────────────────────────────────
│ This snapshot is $human old; the lane publishes daily. At least one run did
│ not happen, so treat what follows as a LEAD, not as the fleet's current state.
│   generated_at: $stamp
└─────────────────────────────────────────────────────────────────────────────
EOF
fi

jq -r --arg stamp "$stamp" --arg human "$human" '
  "repo-standard conformance — \(.org), public repos only\(if .strict then " (strict)" else "" end)",
  "generated \($stamp)  (\($human) ago)",
  "  denominator: \(.denominator.enumerated) public repos, verified against /orgs: \(.denominator.verified)  (\(.denominator.archived) archived, excluded)",
  "  standard:    \(.standard.head_sha // "?" | .[0:12]) on main; selftest \(.standard.selftest.state // "?")\(if .standard.selftest.url then " — " + .standard.selftest.url else "" end)",
  (if .fleet.generated_at then "  fleet feed:  \(.fleet.repos_observed)/\(.fleet.repos_known) observed, coverage_complete=\(.fleet.coverage_complete), generated \(.fleet.generated_at)"
   else "  fleet feed:  unavailable (\(.fleet.unavailable // "?"))" end),
  "  callers:     \(.totals.caller.present) present · \(.totals.caller.absent) absent · \(.totals.caller.unreadable) unreadable   pinned \(.totals.pinned)",
  "  test lane:   \(.totals.test_lane.present) present · \(.totals.test_lane.absent) absent · \(.totals.test_lane["n/a"]) n/a · \(.totals.test_lane.unmeasured) unmeasured",
  "  runs:        \(.totals.standard_run.green) green · \(.totals.standard_run.red) red · \(.totals.standard_run.other) other · \(.totals.standard_run.none) none · \(.totals.standard_run.unreadable) unreadable",
  "  findings:    \(.totals.findings) across \(.totals.with_findings) repos    gaps: \(.totals.gaps)"
' <<<"$body"

if [ "$gaps" = 1 ]; then
  echo
  echo "Measurement gaps (the lane's limits, not the repos' defects):"
  jq -r --argjson n "$n" '
    [ .repos[] | select(.gaps | length > 0) ] | .[:$n][]
    | "  \(.repo)  \(.gaps | join(", "))"
  ' <<<"$body"
else
  echo
  echo "Repos with findings (worst first):"
  jq -r --argjson n "$n" '
    [ .repos[] | select(.findings | length > 0) ] | .[:$n][]
    | "  \(.repo)  \(.findings | join(", "))\(if (.extra | length) > 0 then "   extra: " + ([.extra[].path | split("/") | last] | join(", ")) else "" end)"
  ' <<<"$body"
fi

if [ "$stale" = 1 ]; then
  echo
  echo "(exit 1: the snapshot above is stale — see the banner on stderr)" >&2
  exit 1
fi
