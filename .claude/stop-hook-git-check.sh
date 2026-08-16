#!/bin/bash

# Read the JSON input from stdin
input=$(cat)

# Check if stop hook is already active (recursion prevention)
stop_hook_active=$(echo "$input" | jq -r '.stop_hook_active')
if [[ "$stop_hook_active" = "true" ]]; then
  exit 0
fi

# Check if we're in a git repository - bail if not
if ! git rev-parse --git-dir >/dev/null 2>&1; then
  exit 0
fi

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
  echo "There are uncommitted changes in the repository. Please commit and push these changes to the remote branch." >&2
  exit 2
fi

# Check for untracked files that might be important
untracked_files=$(git ls-files --others --exclude-standard)
if [[ -n "$untracked_files" ]]; then
  echo "There are untracked files in the repository. Please commit and push these changes to the remote branch." >&2
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
    echo "This repository has a LOCAL commit.gpgsign=false, which disables signing for every commit made here while the rest of the session still believes signing is on." >&2
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
      echo "There are commit(s) on branch '$current_branch' that GitHub will show as Unverified (missing signature, or committer email is not noreply@anthropic.com):" >&2
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
  if [[ "$unpushed" -gt 0 ]]; then
    if [[ "$upstream" == "origin/$current_branch" ]]; then
      echo "There are $unpushed unpushed commit(s) on branch '$current_branch'. Please push these changes to the remote repository." >&2
    else
      echo "Branch '$current_branch' has $unpushed unpushed commit(s) and no remote branch. Please push these changes to the remote repository." >&2
    fi
    exit 2
  fi
fi

exit 0
