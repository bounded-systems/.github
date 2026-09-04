Do ONE queued task and prove it. Spend whatever effort it takes; thoroughness over speed.
id: claude-box-245
repo: https://github.com/bounded-systems/claude-box
issue: https://github.com/bounded-systems/claude-box/issues/245 — fetch with WebFetch (load via ToolSearch); the issue body is the spec.
task (summary): Fix the unqualified `claude-box:latest` pod default (fully qualify the image ref). The private-GHCR half of the issue is an owner action — note it, do not attempt.
verify criterion: grep finds no unqualified image ref in pod defaults; repo tests pass.
Note: scout found the defect lives in bounded-systems/prx (packages/prx/src/room/claude-room.ts), not claude-box. Clone prx and fix it there; the private-GHCR half is an owner action — state it in the report.
A read-only scout already wrote $BURNDOWN_DIR/scout/<id>.json — read it first; trust its file paths, re-check its claims.

Rules:
- Clone into /tmp/work/claude-box-245/<reponame> (full clone, all branches). Work on branch claude/burndown-claude-box-245. Commit with clear messages referencing the issue. Do NOT push.
- Keep the diff minimal and scoped to the issue; no drive-by refactors. Match repo conventions (read CONTRIBUTING/AGENTS/CLAUDE.md if present).
- Run the repo's own checks (test/lint/typecheck) AND the scout's verify_command. Capture output.
- Write out: mkdir -p $BURNDOWN_DIR/out/claude-box-245; `git format-patch <default-branch>..HEAD -o $BURNDOWN_DIR/out/claude-box-245/`; and $BURNDOWN_DIR/out/claude-box-245/REPORT.md containing: what changed (files), verify output (trimmed), what is left unresolved and why, and a ready-to-paste GitHub comment for the issue (≤12 lines) describing the change and how to apply the patch.
- If the correct outcome is that the issue is already resolved or stale, do not fabricate work: write REPORT.md with evidence (commits/lines) and a ready-to-paste closing comment, and no patch.
- Finally write $BURNDOWN_DIR/out/claude-box-245/<id>.json: {"id","done":bool,"patch_files":[...],"verify_passed":bool,"summary":"one line","unresolved":[...]}
Return only DONE or the error text.