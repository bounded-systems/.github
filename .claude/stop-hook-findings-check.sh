#!/usr/bin/env bash
# Stop hook — refuse to end a session while it is still holding findings that
# exist nowhere but its own transcript (#162).
#
# ── Why this exists ──────────────────────────────────────────────────────────
# A session routinely learns things worth more than the diff it shipped: a tool
# that lies, a rule that has gone stale, a prerequisite nobody had verified.
# Today the only place those land is prose in a closing message, and the next
# session does not read transcripts. The default outcome is that they evaporate.
#
# Measured in the session that wrote this file: after finishing claude-box#248
# it surfaced two findings — a GitHub search qualifier returning silent false
# negatives (.github-private#457) and the fact that board placement is not
# confirmable from inside the session. Both existed only as sentences. One of
# them is an org-wide trap that causes duplicate work, which is precisely what
# claim-ticket.yml exists to prevent.
#
# ── Why a Stop hook, and why this shape ──────────────────────────────────────
# stop-hook-git-check.sh already establishes the posture: it refuses to let a
# session stop while the working tree holds uncommitted work, and names the
# remedy. This is the same gate on unsaved KNOWLEDGE rather than unsaved code —
# same lever, same exit 2, same "here is what is outstanding" message.
#
# ── Why the evidence is a file and not a question ────────────────────────────
# A hook cannot introspect; it cannot know what the session learned. The obvious
# alternative — prompt at every Stop, "did you learn anything?" — fires in every
# session including the ones where nothing was learned, and check-session-scope.sh
# states the objection precisely: "a block that fires when nothing is wrong
# teaches the reader to skim past the one that matters."
#
# So the buffer is the evidence. The session APPENDS as it goes (findings.sh),
# this hook READS that file, and the repair — writing the issue — stays
# irreducibly the model's or the human's act. That is the same declaration /
# detector / repair triad check-session-scope.sh describes in its own header.
#
# ── What this does NOT do, stated because implying otherwise is worse ────────
# This bounds the DISCHARGE of recorded findings. It cannot bound their
# RECORDING. An empty buffer is not evidence that nothing was learned; it is
# evidence that nothing was written down. The honor-system core moves from
# "remember to file it" to "remember to append it" — narrower and cheaper to
# comply with, but not eliminated. Hygiene rule 3 applies to this hook as much
# as to anything it guards: do not read a silent gate as a clean bill of health.
#
# ── Fail direction ───────────────────────────────────────────────────────────
# Two different failures, two different directions, deliberately:
#
#   * the check RAN and found undischarged findings  ⇒ exit 2, block the stop.
#   * the check COULD NOT RUN (no jq, unreadable buffer) ⇒ exit 0, fail open.
#
# The second is check-session-scope.sh's rule — a broken check must never block
# a session — and it matters more here than there, because a gate that blocks
# Stop and cannot be satisfied is a session that can never end. Every message
# below therefore names an escape that always works: an entry judged not worth
# keeping is discharged with a reason instead of a URL.

set -uo pipefail

FINDINGS_FILE="${FINDINGS_FILE:-${HOME:-/root}/.claude/findings.jsonl}"
JQ="${JQ:-jq}"

input=$(cat 2>/dev/null || true)

# Fail open before anything else is attempted: without jq neither the recursion
# guard below nor the scan can be trusted, and a gate that cannot read its own
# evidence must not be the thing that decides a session may not end.
command -v "$JQ" >/dev/null 2>&1 || exit 0

# Recursion guard, same contract as stop-hook-git-check.sh: a Stop hook that
# fires again while its own block is being handled never lets the session out.
if [ -n "$input" ]; then
  active=$(printf '%s' "$input" | "$JQ" -r '.stop_hook_active // false' 2>/dev/null || echo "false")
  [ "$active" = "true" ] && exit 0
fi

[ -s "$FINDINGS_FILE" ] || exit 0

# Line numbers are the FILE's, 1-based, so what this prints is what
# `findings.sh discharge <n>` takes. Blank lines are skipped but still consume a
# number, which keeps the two views aligned after a hand-edit.
#
# A line that does not parse is reported rather than skipped. `fromjson?` would
# drop it silently, and a finding lost to a stray keystroke is exactly the
# outcome this hook exists to prevent — surfacing it costs one confusing line,
# swallowing it costs the finding.
prog='
split("\n")
| to_entries
| map(select(.value | test("^\\s*$") | not))
| map(
    (try (.value | fromjson) catch null) as $o
    | if $o == null then "  [\(.key + 1)] !! malformed entry: \(.value[0:70])"
      elif ($o.discharged // null) == null then "  [\(.key + 1)] \($o.note // "(no note)")"
      else empty
      end
  )
| .[]
'

outstanding=$("$JQ" -R -s -r "$prog" "$FINDINGS_FILE" 2>/dev/null) || exit 0
[ -n "$outstanding" ] || exit 0

count=$(printf '%s\n' "$outstanding" | grep -c .)

{
  echo "There are $count recorded finding(s) that have not been captured anywhere durable:"
  echo ""
  echo "$outstanding"
  echo ""
  echo "These die with this session unless they are filed or written down. For each:"
  echo "  1. file it — an issue, or a commit to the doc it belongs in"
  echo "  2. record where it went:"
  echo "       bash .claude/findings.sh discharge <n> <url>"
  echo ""
  echo "An entry not worth keeping is discharged with a reason instead of a URL:"
  echo "       bash .claude/findings.sh discharge <n> 'dropped - <why>'"
  echo ""
  echo "Buffer: $FINDINGS_FILE"
} >&2

exit 2
