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
#   1. The org's own snapshot — https://status.bounded.tools/status.json by
#      default (the Cloudflare status layer, live since 2026-08-07; contract in
#      .github-private docs/handoffs/service-status-layer.md), overridable via
#      $BOUNDED_STATUS_URL and disabled by setting it EMPTY. Preferred:
#      sessions need exactly ONE owned host allowlisted instead of every
#      vendor's, and it can serve MOCK incidents for testing outage handling.
#      A parseable AND FRESH snapshot ends the probe, healthy or not.
#   2. Statuspage summaries via the status Worker's scoped relay —
#      https://status.bounded.tools/upstream/<provider>/api/v2/summary.json
#      (infra cloudflare/status, .github-private#534) — since 2026-08-16, when
#      the direct-host defaults were retired along with their dialog grants
#      (status.claude.com, *.githubstatus.com). The relay serves the vendor
#      body VERBATIM from Cloudflare's network, so the jq below behaves
#      exactly as it did against the vendor: a non-JSON 200 fails the parse
#      and skips silently, a Worker 502 fails curl -f and skips silently.
#      Both fallbacks now ride the SAME owned host as source 1 — one grant
#      (*.bounded.tools) covers the whole probe, and what source 2 still adds
#      is the case where the SNAPSHOT is stale/broken while the Worker and
#      vendor are both fine. Worker fully down takes snapshot and relay
#      together; that residual case is accepted (the probe fails open and
#      says an absent warning is not proof of health). History that shaped
#      this: the pre-2026-08-16 defaults named the vendor hosts directly,
#      reachable in cloud sessions only through two dialog grants (#316);
#      before THAT, Anthropic's page moved (status.anthropic.com 302 →
#      status.claude.com, infra#224) and the stale default died silently —
#      fetch() does not follow redirects, by design. Vendor page moves are
#      now the Worker's PROVIDERS map's problem, fixed in one place.
#      Elsewhere (local dev, CI runners) the relay works the same — it is a
#      public read on the public internet.
set -uo pipefail
command -v curl >/dev/null 2>&1 || exit 0
command -v jq >/dev/null 2>&1 || exit 0

# --connect-timeout 1: a host that black-holes instead of refusing must not
# cost the full --max-time on every session start (two probes sit in the
# SessionStart critical path). A refused/403'd connect is already instant.
fetch() { curl -fsS --connect-timeout 1 --max-time 3 "$1" 2>/dev/null; }

# TEST SEAMS. The defaults ARE the contract; these variables exist so
# status-probe.test.mjs can point every source at a file:// fixture and
# exercise each path with no network. They are not a redirection mechanism —
# pointing sessions somewhere else is what BOUNDED_STATUS_URL is for.
: "${BOUNDED_STATUS_GITHUB_URL:=https://status.bounded.tools/upstream/github}"
: "${BOUNDED_STATUS_ANTHROPIC_URL:=https://status.bounded.tools/upstream/anthropic}"

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

# Default to the org's canonical status host (live since 2026-08-07). UNSET
# means "use the layer": a session needs only the network allowlist to
# benefit — no env var, no selector edit. EMPTY is an explicit off-switch
# (the tests use it), which is why this is ${var+x} rather than ${var:-}:
# unset and empty mean different things here, on purpose.
if [ -z "${BOUNDED_STATUS_URL+x}" ]; then
  BOUNDED_STATUS_URL="https://status.bounded.tools/status.json"
fi

if [ -n "${BOUNDED_STATUS_URL:-}" ] && probe_snapshot; then
  : # snapshot answered (healthy or degraded) — do not double-report from direct probes
else
  probe_statuspage "GitHub" "$BOUNDED_STATUS_GITHUB_URL"
  probe_statuspage "Anthropic (Claude)" "$BOUNDED_STATUS_ANTHROPIC_URL"
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
