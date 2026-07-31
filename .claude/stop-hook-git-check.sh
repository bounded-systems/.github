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
  exclude=("$upstream")
  for candidate in "$(git symbolic-ref --quiet --short refs/remotes/origin/HEAD 2>/dev/null)" origin/main; do
    if [[ -n "$candidate" ]] && git rev-parse --verify --quiet "$candidate" >/dev/null 2>&1; then
      exclude+=("$candidate")
      break
    fi
  done

  if [[ "$(git config --type=bool commit.gpgsign 2>/dev/null)" == "true" ]]; then
    unverifiable=$(git log --format='%h %G? %ce' HEAD --not "${exclude[@]}" 2>/dev/null \
      | awk '$3 != "noreply@github.com" && ($2 == "N" || $3 != "noreply@anthropic.com")')
    if [[ -n "$unverifiable" ]]; then
      echo "There are commit(s) on branch '$current_branch' that GitHub will show as Unverified (missing signature, or committer email is not noreply@anthropic.com):" >&2
      echo "$unverifiable" >&2
      echo "Please run 'git config user.email noreply@anthropic.com && git config user.name Claude', then 'git commit --amend --no-edit --reset-author' for the tip commit, or 'git rebase --exec \"git commit --amend --no-edit --reset-author\" $upstream' for earlier commits, then push." >&2
      exit 2
    fi
  fi

  # Same exclusion, same reason (infra#112). After a squash merge the local branch
  # is typically reset onto the merged default branch while its remote tip stays
  # where it was pushed, so `$upstream..HEAD` counts the merge commit and asks the
  # author to push already-merged history back onto their feature branch. Fixing
  # only the signature check above would leave the hook firing after every merge
  # with a different message, which is the same defect.
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
