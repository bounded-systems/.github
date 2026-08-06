#!/usr/bin/env bash
# SessionStart hook — service-status probe: the weather report at check-in.
#
# Injects a context warning ONLY when a provider (GitHub, Anthropic) reports an
# active incident, so a session that STARTS during one knows before it burns
# retries into a platform outage it cannot see. Scope, honestly: that is the
# only case a SessionStart hook covers. 2026-08-06 (githubstatus qcvjkzcs7j74)
# was the OTHER case — the incident began mid-session and cost four retry
# rounds anyway. Catching that one belongs to the retry path consulting the
# same snapshot (a different consumer, per the layer handoff), not to this hook.
#
# When both .github repos are attached, both copies fire, and the dispatcher's
# mergeContexts dedupe is only PROBABILISTIC here: unlike the org-context hooks
# (which read one identical file), these are independent network calls seconds
# apart, and a component flipping between them yields two differing blocks —
# both inject. Accepted: rare, bounded to one incident window, and two
# slightly-different warnings still beat zero.
#
# SILENT when healthy, and silent when it cannot check — injected context
# counts against the window every session, and a block that fires when nothing
# is wrong is how a warning gets skimmed past (same rule as mcpDriftContext in
# .github's session-start-dispatch.mjs). The cost of that choice: an absent
# warning is NOT proof of health, and the warning text says so.
#
# Fail OPEN everywhere: no curl, no jq, no network, a proxy that 403s the
# status hosts — all yield no output and exit 0, never a blocked session.
#
# Sources, in order:
#   1. $BOUNDED_STATUS_URL — the org's own snapshot (the Cloudflare status
#      layer; contract in .github-private docs/handoffs/service-status-layer.md).
#      Preferred: sessions then need exactly ONE owned host reachable instead
#      of every provider's, and it can serve MOCK incidents for testing outage
#      handling. A parseable AND FRESH snapshot ends the probe, healthy or not.
#   2. Direct Statuspage APIs. NOTE: in cloud sessions on 2026-08-06 BOTH were
#      unreachable, by two different mechanisms — worth knowing, because they
#      look like different problems and are the same one:
#        - www.githubstatus.com — denied at CONNECT (proxy answers 403 to the
#          tunnel).
#        - status.anthropic.com — bypasses the proxy (`.anthropic.com` is on
#          NO_PROXY) and is then refused by the egress filter itself:
#          `HTTP/2 403, x-deny-reason: host_not_allowed`.
#      Bypassing the proxy is NOT the same as being allowed out, so neither
#      half of this fallback works in a cloud session until the environment's
#      network policy allowlists the hosts. Source 1 is the fix: one owned
#      host to allowlist instead of one per vendor. Elsewhere (local dev, CI
#      runners) the direct probes work normally.
set -uo pipefail
command -v curl >/dev/null 2>&1 || exit 0
command -v jq >/dev/null 2>&1 || exit 0

# --connect-timeout 1: a host that black-holes instead of refusing must not
# cost the full --max-time on every session start (two probes sit in the
# SessionStart critical path). A refused/403'd connect is already instant.
fetch() { curl -fsS --connect-timeout 1 --max-time 3 "$1" 2>/dev/null; }

warnings=""
add_warning() { warnings="${warnings}${1}"$'\n'; }

# Source 1 — the org snapshot:
# { generated_at, providers: { <name>: { indicator, components: [...], incidents: [{name,url}], mock? } } }
#
# FRESHNESS GATES TRUST. A reachable-but-stuck layer (poller wedged, cache
# never revalidating) serving yesterday's "none" would silently suppress the
# direct probes in every session — green from a job that did nothing is not
# evidence of health. So a snapshot may end the probe only if it proves its
# age: generated_at present, parseable, under 10 minutes old. Stale, missing,
# or malformed → unanswered (return 1) → fall through to the direct probes.
# jq's fromdateiso8601 does the parsing so there is no GNU-date dependency.
probe_snapshot() {
  local body lines
  body="$(fetch "$BOUNDED_STATUS_URL")" || return 1
  jq -e '
    has("providers") and ((now - (.generated_at | fromdateiso8601)) < 600)
  ' >/dev/null 2>&1 <<<"$body" || return 1
  lines="$(jq -r '
    .providers | to_entries[]
    | .value.indicator as $i
    | select($i != null and $i != "" and $i != "none")
    | "- **\(.key)**: \($i)"
      + (if (.value.mock // false) then " [MOCK]" else "" end)
      + " — components: " + ((.value.components // []) | join(", "))
      + (if ((.value.incidents // []) | length) > 0
         then " — " + ([.value.incidents[] | "\(.name) <\(.url)>"] | join("; "))
         else "" end)
  ' <<<"$body" 2>/dev/null)" || return 0
  [ -n "$lines" ] && add_warning "$lines"
  return 0
}

# Source 2 — one provider's Statuspage v2 summary; one warning line if degraded.
probe_statuspage() {
  local label="$1" base="$2" body line
  body="$(fetch "$base/api/v2/summary.json")" || return 0
  line="$(jq -r --arg label "$label" '
    .status.indicator as $i
    | select($i != null and $i != "none")
    | "- **\($label)**: \($i)"
      + " — components: "
      + ([.components[]? | select(.status != "operational") | .name] | join(", "))
      + (if ((.incidents // []) | length) > 0
         then " — " + ([.incidents[] | "\(.name) <\(.shortlink // "")>"] | join("; "))
         else "" end)
  ' <<<"$body" 2>/dev/null)" || return 0
  [ -n "$line" ] && add_warning "$line"
  return 0
}

if [ -n "${BOUNDED_STATUS_URL:-}" ] && probe_snapshot; then
  : # snapshot answered (healthy or degraded) — do not double-report from direct probes
else
  probe_statuspage "GitHub" "https://www.githubstatus.com"
  probe_statuspage "Anthropic (Claude)" "https://status.anthropic.com"
fi

[ -n "$warnings" ] || exit 0

ctx="## Service status warning — active provider incident(s) at session start

${warnings}
Checked ONCE at session start, so it covers incidents that were already open
then — an incident starting mid-session produces no warning at all. Before
spending retries on failing CI runs or API calls, confirm current status
(provider status page, or ask the user) rather than treating this block, or
its absence, as live. This probe fails open — an ABSENT warning is not proof
of health. A [MOCK] line is a
synthetic incident served by the org status layer to exercise outage
handling; treat it as real inside tests, and say it is a mock anywhere else."

jq -n --arg c "$ctx" \
  '{hookSpecificOutput:{hookEventName:"SessionStart",additionalContext:$c}}'
