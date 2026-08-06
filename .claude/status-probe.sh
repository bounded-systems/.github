#!/usr/bin/env bash
# SessionStart hook — service-status probe: the weather report at check-in.
#
# Injects a context warning ONLY when a provider (GitHub, Anthropic) reports an
# active incident, so a fresh session knows before it burns retries into a
# platform outage it cannot see. Motivating failure, 2026-08-06: four retry
# rounds against a degraded Actions queue (githubstatus incident qcvjkzcs7j74)
# before the outage was diagnosed by hand, outside the session.
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
#      handling. A parseable snapshot ends the probe, healthy or not.
#   2. Direct Statuspage APIs. NOTE: the cloud egress proxy 403'd
#      www.githubstatus.com on 2026-08-06 — that is the fail-open path here,
#      and the reason source 1 exists. status.anthropic.com bypasses the proxy
#      (*.anthropic.com is on its no-proxy list), so the Anthropic half works
#      even before an allowlist entry or the layer lands.
set -uo pipefail
command -v curl >/dev/null 2>&1 || exit 0
command -v jq >/dev/null 2>&1 || exit 0

fetch() { curl -fsS --max-time 3 "$1" 2>/dev/null; }

warnings=""
add_warning() { warnings="${warnings}${1}"$'\n'; }

# Source 1 — the org snapshot:
# { providers: { <name>: { indicator, components: [...], incidents: [{name,url}], mock? } } }
probe_snapshot() {
  local body lines
  body="$(fetch "$BOUNDED_STATUS_URL")" || return 1
  jq -e 'has("providers")' >/dev/null 2>&1 <<<"$body" || return 1
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
Checked once at session start; it may be stale by the time you read it. Before
spending retries on failing CI runs or API calls, confirm the incident is over
(provider status page, or ask the user). This probe fails open — an ABSENT
warning in another session is not proof of health. A [MOCK] line is a
synthetic incident served by the org status layer to exercise outage
handling; treat it as real inside tests, and say it is a mock anywhere else."

jq -n --arg c "$ctx" \
  '{hookSpecificOutput:{hookEventName:"SessionStart",additionalContext:$c}}'
