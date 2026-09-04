READ-ONLY scout of one queued task. Do not modify repos, do not push.
id: claude-box-245
repo: https://github.com/bounded-systems/claude-box
issue: https://github.com/bounded-systems/claude-box/issues/245 — fetch it with WebFetch (load via ToolSearch) and treat the body as the spec. Also WebFetch https://claims.bounded.tools and check whether this issue is listed.
task (summary): Fix the unqualified `claude-box:latest` pod default (fully qualify the image ref). The private-GHCR half of the issue is an owner action — note it, do not attempt.
verify criterion: grep finds no unqualified image ref in pod defaults; repo tests pass.

Steps: `git clone --depth 50 https://github.com/bounded-systems/claude-box /tmp/scout/claude-box-245`. Read what is relevant. Do NOT do the task. Sandbox facts: no GitHub credentials, no podman, network = github.com + package registries only (curl to bounded.tools is blocked; use WebFetch for it).
Then write your report to $BURNDOWN_DIR/scout/<id>.json as JSON with exactly these keys:
id, feasible (bool), reason, current_state (what the repo looks like today re this task, with file paths), plan (array of concrete steps naming files), verify_command (exact shell command proving done, or ""), est_size (small|medium|large), risks (array), claimed (bool: appears on claims.bounded.tools).
Return only the string DONE or the error text if writing failed.