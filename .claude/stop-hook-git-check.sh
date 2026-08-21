#!/bin/bash

# Read the JSON input from stdin
input=$(cat)

# Check if stop hook is already active (recursion prevention)
stop_hook_active=$(echo "$input" | jq -r '.stop_hook_active')
if [[ "$stop_hook_active" = "true" ]]; then
  exit 0
fi

# ── WHICH repositories this session holds ────────────────────────────────────
#
# This used to be "whichever repo the cwd happens to be in, or none", and none
# was the common case: a cloud session's root (/home/user) is NOT a repo — the
# creation-attached checkouts sit BESIDE it (/home/user/.github,
# /home/user/.github-private) and mid-session `add_repo` clones land in
# /workspace/<repo>. The old guard here was `git rev-parse --git-dir || exit 0`,
# so the hook ran its predicate against nothing and reported "safe to stop".
#
# Measured 2026-08-18 (#214) in a four-checkout session, with one untracked file
# in /workspace/verbspec: run from /home/user the hook exited 0; run from inside
# that repo it exited 2. The predicate was never wrong — it was never asked.
#
# So scope is the fix, not logic: everything below is the SAME per-repo check,
# now asked once per checkout. The roots are variables so the test suite can be
# hermetic against the container's real /workspace (see `hermetic` in the tests);
# a session sets neither and gets the real ones.
#
# The session-root default is $PWD, NOT $HOME: the platform invokes this hook
# with the session's working directory, which IS the session root (/home/user),
# while $HOME in this container is /root. Defaulting to $HOME found /workspace
# and silently missed both creation-attached checkouts — measured while building
# #214, which is the same class of miss the issue is about.
repos_in() (
  # dotglob is LOAD-BEARING, not tidiness: this org's two creation-attached
  # checkouts are `.github` and `.github-private`, and a bare `*` skips every
  # name starting with a dot. Without it the scan found /workspace and silently
  # missed both repos every session actually holds — measured while building
  # #214. nullglob keeps an unmatched pattern from arriving as a literal.
  # A subshell body so neither option leaks to the caller.
  shopt -s dotglob nullglob
  local root="$1" d
  [ -d "$root" ] || exit 0
  for d in "$root"/*/; do
    [ -e "$d.git" ] || continue      # a file for worktrees/submodules, a dir otherwise
    ( cd "$d" && git rev-parse --show-toplevel 2>/dev/null ) || true
  done
)

# The cwd's repo first (the only one the old version could see), then the two
# places a session's checkouts actually live. Deduped by top-level path, so a
# cwd inside a discovered checkout is not checked twice.
discover_repos() {
  {
    git rev-parse --show-toplevel 2>/dev/null || true
    repos_in "${CLAUDE_SESSION_ROOT:-$PWD}"
    repos_in "${CLAUDE_WORKSPACE_ROOT:-/workspace}"
  } | awk 'NF && !seen[$0]++'
}

# ── How to push, printed at the moment a push is demanded (.github-private #461)
#
# The retry-with-backoff form a session reaches for under time pressure pipes the
# push to keep the transcript short:
#
#   git push -u origin "$b" 2>&1 | tail -3 && break
#
# That is broken. A pipeline's exit status is the LAST command's, so `tail`
# exiting 0 makes the whole thing succeed no matter what git did: `&& break`
# fires on the first attempt every time, the retry loop that exists to survive
# transient failure is inert, and the caller reports a push that never happened.
# It fails in the OPTIMISTIC direction, which is why nothing downstream catches
# it — the session says "pushed" and ends with the work still local.
#
# Measured on a live refusal (#461): the pipe ate `error: RPC failed; HTTP 403`
# and left `send-pack: unexpected disconnect` plus a reassuring `Everything
# up-to-date`, which was read — and reported to the operator — as a network
# flake. A 403 and a dropped connection look identical once the discriminating
# line is discarded, so the masking degrades diagnosis, not just this one push.
#
# This is printed HERE, rather than written into a doc, because this is the
# moment a session is told to push; a doc it might read is not that moment. It
# costs nothing on every stop where there is nothing to push.
push_guidance() {
  local b="$1"
  cat >&2 <<EOF
  Do NOT pipe the push. A pipeline's status is tail's, not git's, so a refused
  push reports success. Retry on the command itself, and verify the
  POSTCONDITION (the ref is on the remote) rather than the command's own claim:

    ok=0
    for i in 1 2 3 4 5; do
      git push -u origin '$b' && { ok=1; break; }
      sleep \$((2**i))
    done
    [ "\$ok" = 1 ] || { echo 'push FAILED after retries'; exit 1; }
    git ls-remote --exit-code --heads origin '$b'
EOF
}

# One checkout's worth of checking. A SUBSHELL body — `( )`, not `{ }` — so the
# `cd` cannot leak to the next repo and every `exit 2` below keeps its original
# meaning: it ends this repo's check and becomes this function's return code,
# leaving the hard-won logic underneath untouched.
check_repo() (
  LOC="$1: "
  cd "$1" || exit 0

# Bail if there's no remote to push to. Every error path below asks the user
# to "push to the remote branch" — meaningless without a remote, and
# unsatisfiable if signing also requires a source. This case arises when CCR
# was launched against a local repo with no github remote (sources=[]) and
# the container's cwd has a leftover .git from a cached resume.
if [[ -z "$(git remote)" ]]; then
  exit 0
fi

# Check for uncommitted changes (both staged and unstaged)
if ! git diff --quiet || ! git diff --cached --quiet; then
  echo "${LOC}There are uncommitted changes in the repository. Please commit and push these changes to the remote branch." >&2
  exit 2
fi

# Check for untracked files that might be important
untracked_files=$(git ls-files --others --exclude-standard)
if [[ -n "$untracked_files" ]]; then
  echo "${LOC}There are untracked files in the repository. Please commit and push these changes to the remote branch." >&2
  exit 2
fi

# Is this commit signed? Reads the raw object's HEADERS, not `%G?` (#536-B).
#
# `%G?` answers "can git VERIFY this signature", and nothing in this container
# can: no `gpg.ssh.allowedSignersFile` is configured, so git prints
#   error: gpg.ssh.allowedSignersFile needs to be configured and exist
# and reports N — the same letter it uses for "no signature at all" — for a
# commit carrying a perfectly good one. Measured 2026-08-16: cc7f12c has a
# BEGIN SSH SIGNATURE block and `%G?` says N. The old comment here asserted such
# commits "report B/U/E"; they do not, and every agent commit was therefore one
# unmasking away from being called Unverified.
#
# Presence is the question this hook can actually answer, so ask that instead.
# BOTH flavours: agent commits are SSH, and GitHub signs its own squash-merges
# with PGP (verified on 1337986, 6675ce5, 57b93c5 — pgp=1 ssh=0).
# HEADER-ONLY (`sed -n '/^$/q;p'` stops at the blank line ending the header
# block): a commit whose MESSAGE quotes signature armour — this file's own
# commits do — would otherwise count as signed.
commit_is_signed() {
  git cat-file commit "$1" 2>/dev/null \
    | sed -n '/^$/q;p' \
    | grep -qE '^(gpgsig|gpgsig-sha256)? *-----BEGIN (SSH|PGP) SIGNATURE-----'
}

# Keep only refs that actually resolve, so one bad ref cannot kill the command.
#
# (#536-C) `origin/HEAD` is UNRESOLVED in a `--depth 1` clone — the shallow
# fetch never writes it. It was assigned to `$upstream` whenever the branch had
# no remote counterpart, and `$upstream` went into the exclude list WITHOUT
# passing the resolve test the candidate loop applied to everything else. git
# then died with `fatal: ambiguous argument 'origin/HEAD'`, `2>/dev/null` ate
# the message, and BOTH checks below returned nothing — reporting a clean tree
# on exactly the branches most likely to be dirty. The old code said "a check
# that silently stops running is worse than the false positive it replaced" and
# then did precisely that, because the guard covered the candidates and not the
# one ref that was always present.
resolvable_refs() {
  local ref
  for ref in "$@"; do
    [[ -n "$ref" ]] && git rev-parse --verify --quiet "$ref" >/dev/null 2>&1 && printf '%s\n' "$ref"
  done
}

current_branch=$(git branch --show-current)
if [[ -n "$current_branch" ]]; then
  if git rev-parse "origin/$current_branch" >/dev/null 2>&1; then
    upstream="origin/$current_branch"
  else
    upstream="origin/HEAD"
  fi

  # Check for local commits that GitHub will show as "Unverified": either no
  # signature at all (%G? == N), or signed with a committer email other than
  # noreply@anthropic.com (the identity CCR's signing key is registered to).
  # Only run when commit signing is configured. Note: %G? is N for unsigned
  # commits; signed-but-locally-unverifiable commits report B/U/E, so this is
  # a reliable presence check even though CCR doesn't configure local verification.
  #
  # SCOPE (infra#112): only commits NOT already reachable from the default branch.
  # `$upstream..HEAD` was wrong whenever the remote feature branch lags the default
  # branch — which is the normal state right after a squash merge, since the branch
  # tip stays where it was pushed while HEAD moves onto the merged history. The
  # range then includes GitHub's own squash commit, whose committer is
  # `GitHub <noreply@github.com>` and can never satisfy the email test.
  #
  # That made the warning fire after EVERY merge, and its own remedy
  # (`--amend --reset-author`) would rewrite an already-merged commit on the
  # default branch and fork the working branch from it — the divergence that made
  # infra#102 fail to merge. Merged history is never the author's to fix, so the
  # range must exclude it. Genuinely unpushed local work is still ahead of the
  # default branch, so it is still checked.
  #
  # The second exclusion is belt-and-braces for the same class: a commit GitHub
  # itself committed is not something a session authored or can re-sign.
  # Resolve the default branch by asking the remote, falling back to origin/main.
  # A ref that does not resolve is dropped rather than passed to git log: an
  # unresolvable exclude would make the whole command fail, and a check that
  # silently stops running is worse than the false positive it replaced.
  # Every ref is filtered, `$upstream` included — see resolvable_refs (#536-C).
  mapfile -t exclude < <(resolvable_refs "$upstream")
  for candidate in "$(git symbolic-ref --quiet --short refs/remotes/origin/HEAD 2>/dev/null)" origin/main; do
    if [[ -n "$candidate" ]] && git rev-parse --verify --quiet "$candidate" >/dev/null 2>&1; then
      exclude+=("$candidate")
      break
    fi
  done

  # A repo-local `commit.gpgsign=false` is a FINDING, not a reason to go quiet
  # (#536-A). The old guard read the EFFECTIVE value, so writing that override —
  # the one action that actually disables signing for this repo — also switched
  # off the check that exists to notice it. The harness signs via a global
  # `gpg.ssh.program`, so a local `false` is never legitimate here: it silently
  # produces unsigned commits that the merge gate rejects hours later.
  local_gpgsign=$(git config --local --get commit.gpgsign 2>/dev/null)
  if [[ "$local_gpgsign" == "false" ]]; then
    echo "${LOC}This repository has a LOCAL commit.gpgsign=false, which disables signing for every commit made here while the rest of the session still believes signing is on." >&2
    echo "Remove it with 'git config --local --unset commit.gpgsign', then re-create any commits made since." >&2
    exit 2
  fi

  # Presence, per commit, from the raw object — not `%G?` (#536-B).
  if [[ "$(git config --type=bool commit.gpgsign 2>/dev/null)" == "true" ]]; then
    unverifiable=""
    while read -r rev; do
      [[ -z "$rev" ]] && continue
      committer=$(git log -1 --format='%ce' "$rev")
      # GitHub's own squash-merge commits are not this session's to fix.
      [[ "$committer" == "noreply@github.com" ]] && continue
      if ! commit_is_signed "$rev" || [[ "$committer" != "noreply@anthropic.com" ]]; then
        unverifiable+="$(git log -1 --format='%h %ce' "$rev")"$'\n'
      fi
    done < <(git rev-list HEAD --not "${exclude[@]}" 2>/dev/null)

    if [[ -n "$unverifiable" ]]; then
      echo "${LOC}There are commit(s) on branch '$current_branch' that GitHub will show as Unverified (missing signature, or committer email is not noreply@anthropic.com):" >&2
      printf '%s' "$unverifiable" >&2
      # NEVER --amend here (#536, and the trap that cost two PRs on 2026-08-16).
      # In a `--depth 1` clone the shallow graft severs the parent, so --amend
      # produces a PARENTLESS ROOT COMMIT: GitHub loses the merge base and closes
      # the PR. reset --soft keeps the parent link and fails loudly rather than
      # silently corrupting history when there is no parent to reset onto.
      echo "Please run 'git config user.email noreply@anthropic.com && git config user.name Claude', then re-create the tip commit with 'git reset --soft HEAD~1 && git commit -C ORIG_HEAD', then push." >&2
      echo "Do NOT use 'git commit --amend' in this container: the clone is shallow, and amending the graft boundary produces a parentless root commit that closes the PR." >&2
      exit 2
    fi
  fi

  # Same exclusion, same reason (infra#112). After a squash merge the local branch
  # is typically reset onto the merged default branch while its remote tip stays
  # where it was pushed, so `$upstream..HEAD` counts the merge commit and asks the
  # author to push already-merged history back onto their feature branch. Fixing
  # only the signature check above would leave the hook firing after every merge
  # with a different message, which is the same defect.
  # Same exclude list, now guaranteed resolvable — this `|| unpushed=0` used to
  # convert the `fatal: ambiguous argument 'origin/HEAD'` above into "nothing to
  # push", which is the second half of #536-C.
  unpushed=$(git rev-list HEAD --not "${exclude[@]}" --count 2>/dev/null) || unpushed=0

  # (#234) A `--depth 1` clone sets a fetch refspec covering only the default
  # branch, so a branch pushed with `-u` gets `branch.<b>.merge` written while
  # `refs/remotes/origin/<b>` is never created. `$upstream` falls back to the
  # default branch, every commit on the branch counts as unpushed, and the
  # message below claims "no remote branch" about work already on the remote.
  #
  # That loop does not converge: the remedy is a push, the push succeeds and
  # changes nothing, and the next Stop says the same thing. The hook's own
  # advice to verify with `git ls-remote` PASSES while the hook keeps failing.
  # The push was never the fix; the refspec is.
  #
  # Same root cause as #536-C — a shallow clone has fewer refs than this hook
  # assumes — opposite symptom.
  #
  # An upstream that is CONFIGURED but has no tracking ref is the unambiguous
  # signature of that state: it can only follow a successful push, so the remote
  # is reachable by definition, and it cannot arise on a branch that was never
  # pushed. That keeps `ls-remote` off the common path and away from fixtures
  # whose `origin` is unreachable.
  if [[ "$unpushed" -gt 0 && "$upstream" != "origin/$current_branch" ]] \
     && [[ -n "$(git config --get "branch.$current_branch.merge" 2>/dev/null)" ]]; then
    remote_tip=$(GIT_TERMINAL_PROMPT=0 git ls-remote --heads origin "$current_branch" 2>/dev/null | cut -f1)
    if [[ -n "$remote_tip" && "$remote_tip" == "$(git rev-parse HEAD 2>/dev/null)" ]]; then
      echo "${LOC}Branch '$current_branch' is fully pushed ($remote_tip), but this clone has no remote-tracking ref for it: the fetch refspec covers only the default branch, which is what 'git clone --depth 1' configures." >&2
      echo "Do NOT push again — the ref is already on the remote and a push will change nothing. Repair the refspec once instead:" >&2
      echo "    git config --replace-all remote.origin.fetch '+refs/heads/*:refs/remotes/origin/*'" >&2
      echo "    git fetch origin '$current_branch'" >&2
      exit 2
    fi
  fi

  if [[ "$unpushed" -gt 0 ]]; then
    if [[ "$upstream" == "origin/$current_branch" ]]; then
      echo "${LOC}There are $unpushed unpushed commit(s) on branch '$current_branch'. Please push these changes to the remote repository." >&2
    else
      echo "${LOC}Branch '$current_branch' has $unpushed unpushed commit(s) and no remote branch. Please push these changes to the remote repository." >&2
    fi
    push_guidance "$current_branch"
    exit 2
  fi
fi

exit 0
)

mapfile -t REPOS < <(discover_repos)
# No checkouts at all is still quiet — the same answer the old bail gave, but
# now because there is genuinely nothing to check rather than because the cwd
# happened not to be a repo.
[ ${#REPOS[@]} -eq 0 ] && exit 0

# EVERY repo is checked before exiting: stopping at the first problem would hide
# the second one behind a fix-and-retry cycle per repo.
status=0
for repo in "${REPOS[@]}"; do
  check_repo "$repo" || status=2
done
exit $status
