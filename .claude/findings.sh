#!/usr/bin/env bash
# The findings buffer (#162) — append what this session learned, so the Stop
# hook has something to read and the next session has something to find.
#
# The gate is stop-hook-findings-check.sh; this is the other half of the pair.
# Keeping the writer here rather than asking each session to hand-append JSON is
# not a convenience: the honor-system residual this design accepts is "remember
# to append", so appending has to be cheaper than not bothering. A note that
# needs correct JSON quoting to record is a note that will not get recorded.
#
#   bash .claude/findings.sh add "in:title search returns silent false negatives"
#   bash .claude/findings.sh list
#   bash .claude/findings.sh discharge 1 https://github.com/o/r/issues/457
#   bash .claude/findings.sh discharge 2 'dropped - already covered by #456'
#
# A finding is anything a future session would have to rediscover: a tool that
# reports something untrue, a documented rule contradicted by observed behaviour,
# a prerequisite that turns out not to hold. It is NOT a task list — work goes on
# the board. The test is whether the knowledge dies with the transcript.
#
# Discharge takes a URL or a reason, and both are first-class. "Not worth
# keeping" is a legitimate outcome; what is not legitimate is the entry quietly
# vanishing, so the reason is recorded in the same field the URL would occupy.

set -uo pipefail

FINDINGS_FILE="${FINDINGS_FILE:-${HOME:-/root}/.claude/findings.jsonl}"
JQ="${JQ:-jq}"

die() {
  echo "findings: $1" >&2
  exit 1
}

command -v "$JQ" >/dev/null 2>&1 || die "jq not found (set \$JQ to override)"

usage() {
  cat >&2 <<'EOF'
usage:
  findings.sh add <note>                  record a finding
  findings.sh list                        show the buffer with line numbers
  findings.sh discharge <n> <url|reason>  mark entry <n> as captured
EOF
  exit 2
}

cmd="${1:-}"
[ -n "$cmd" ] || usage

case "$cmd" in
add)
  shift
  note="$*"
  [ -n "$note" ] || die "add needs a note"
  mkdir -p "$(dirname "$FINDINGS_FILE")" || die "cannot create $(dirname "$FINDINGS_FILE")"
  # -c so one finding is one line: the whole format depends on that, since the
  # line number IS the handle `discharge` and the Stop hook both address.
  "$JQ" -nc --arg note "$note" \
    '{ts: (now | todate), note: $note, discharged: null}' >>"$FINDINGS_FILE" ||
    die "could not append to $FINDINGS_FILE"
  echo "recorded: $note"
  ;;

list)
  [ -s "$FINDINGS_FILE" ] || {
    echo "no findings recorded ($FINDINGS_FILE)"
    exit 0
  }
  "$JQ" -R -s -r '
    split("\n")
    | to_entries
    | map(select(.value | test("^\\s*$") | not))
    | map(
        (try (.value | fromjson) catch null) as $o
        | if $o == null then "[\(.key + 1)] !! malformed: \(.value[0:70])"
          elif ($o.discharged // null) == null then "[\(.key + 1)] OPEN  \($o.note)"
          else "[\(.key + 1)] done  \($o.note)  -> \($o.discharged)"
          end
      )
    | .[]
  ' "$FINDINGS_FILE"
  ;;

discharge)
  n="${2:-}"
  shift 2 2>/dev/null || usage
  where="$*"
  [ -n "$n" ] || usage
  [ -n "$where" ] || die "discharge needs a URL or a reason"
  case "$n" in
  '' | *[!0-9]*) die "entry number must be a positive integer, got '$n'" ;;
  esac
  [ -s "$FINDINGS_FILE" ] || die "no findings recorded ($FINDINGS_FILE)"

  # Classify the target BEFORE rewriting. An earlier draft inferred the outcome
  # by diffing the file afterwards, which was wrong twice over: `jq -r` appends a
  # newline, so a no-op rewrite still differed (every discharge silently grew a
  # blank line, and a number addressing nothing reported success), and
  # re-discharging an already-captured entry DOES change the file, so a diff can
  # never reject it. Deciding from the entry's own state is the only reading that
  # answers both. Caught by the two negative tests, not by review.
  state=$("$JQ" -R -s -r --argjson n "$n" '
    split("\n")
    | to_entries
    | map(select(.key + 1 == $n))
    | (.[0].value // null)
    | if . == null then "missing"
      elif test("^\\s*$") then "blank"
      else ((try fromjson catch null) as $o
            | if $o == null then "malformed"
              elif ($o.discharged // null) == null then "open"
              else "done"
              end)
      end
  ' "$FINDINGS_FILE") || die "could not read $FINDINGS_FILE"

  case "$state" in
  open | malformed) ;;
  done) die "entry $n is already discharged" ;;
  blank | missing) die "entry $n is not an entry (blank or out of range)" ;;
  *) die "could not classify entry $n" ;;
  esac

  # Rewrite through a temp file in the same directory so a failure partway
  # cannot truncate the buffer: losing the record here would destroy exactly
  # what the pair exists to preserve.
  tmp="$(mktemp "${FINDINGS_FILE}.XXXXXX")" || die "cannot create temp file"
  trap 'rm -f "$tmp"' EXIT

  # -j, not -r: with -r jq adds a trailing newline that the join has already
  # accounted for, so the file gained a blank line on every pass.
  #
  # A malformed line is rewritten into a well-formed discharged entry that keeps
  # the raw text as its note. That path is not a nicety — the Stop hook counts a
  # malformed line as outstanding, so without a way to discharge one, a single
  # stray keystroke in the buffer would be a session that can never stop. The
  # gate must always have an exit.
  "$JQ" -R -s -j --argjson n "$n" --arg d "$where" '
    split("\n")
    | to_entries
    | map(
        if (.key + 1) == $n then
          ((try (.value | fromjson) catch null) as $o
           | if $o == null
             then {ts: (now | todate), note: .value, discharged: $d} | tojson
             else ($o + {discharged: $d} | tojson)
             end)
        else .value
        end
      )
    | join("\n")
  ' "$FINDINGS_FILE" >"$tmp" || die "rewrite failed; buffer left untouched"

  [ -s "$tmp" ] || die "rewrite produced an empty buffer; original left untouched"

  mv "$tmp" "$FINDINGS_FILE" || die "could not replace $FINDINGS_FILE"
  trap - EXIT
  echo "discharged $n -> $where"
  ;;

*) usage ;;
esac
