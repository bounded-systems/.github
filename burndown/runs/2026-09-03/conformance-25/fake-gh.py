#!/usr/bin/env python3
# Fake `gh` for an offline dry run of scripts/audit/release-tags.ts.
# Serves: repo list; trees/contents for 3 repos; tag rulesets with 3 shapes.
import sys, json
a = sys.argv[1:]
def out(o): print(o if isinstance(o, str) else json.dumps(o)); sys.exit(0)
if a[:2] == ["repo", "list"]:
    out([{"name": n} for n in ["mint", "drift-gate", "guest-room", "docs-site"]])
if a[0] != "api": sys.exit(1)
path = a[1]
REL = "name: release\non:\n  push:\n    tags: [\"v*\"]\npermissions:\n  contents: read\n"
STD = "name: standard\non:\n  push:\n    branches: [main]\n  pull_request:\n"
trees = {
  "mint": [".release/README.md", ".github/workflows/release.yml", ".github/workflows/standard.yml"],
  "drift-gate": [".github/workflows/publish-jsr.yml", ".github/workflows/standard.yml"],
  "guest-room": [".github/workflows/release.yml"],
  "docs-site": [".github/workflows/standard.yml", "README.md"],
}
ent_no_bypass = {"id": 9001, "name": "Restrict tag creation", "target": "tag", "source_type": "Enterprise", "source": "bounded", "enforcement": "active",
  "bypass_actors": [], "conditions": {"ref_name": {"include": ["refs/tags/*"], "exclude": []}}, "rules": [{"type": "creation"}]}
org_with_actions = {"id": 42, "name": "release-tags", "target": "tag", "source_type": "Organization", "source": "bounded-systems", "enforcement": "active",
  "bypass_actors": [{"actor_id": 15368, "actor_type": "Integration", "bypass_mode": "always"}],
  "conditions": {"ref_name": {"include": ["~ALL"], "exclude": []}}, "rules": [{"type": "creation"}]}
rulesets = {"mint": [ent_no_bypass], "drift-gate": [ent_no_bypass, org_with_actions], "guest-room": []}
summary = lambda r: {k: r[k] for k in ("id","name","target","source_type","source","enforcement")}
for repo, paths in trees.items():
    if path == f"repos/bounded-systems/{repo}/git/trees/HEAD?recursive=1":
        out({"tree": [{"type": "blob", "path": p} for p in paths]})
    if path.startswith(f"repos/bounded-systems/{repo}/contents/"):
        p = path.split("/contents/")[1]
        out(REL if "release" in p or "publish" in p else STD)
    if path == f"repos/bounded-systems/{repo}/rulesets?targets=tag&includes_parents=true":
        out([summary(r) for r in rulesets.get(repo, [])])
    for r in rulesets.get(repo, []):
        if path == f"repos/bounded-systems/{repo}/rulesets/{r['id']}?includes_parents=true":
            # guest-room: pretend the token can't read details (403) -> UNKNOWN
            if repo == "drift-gate" and r["id"] == 9001: sys.exit(1)
            out(r)
sys.exit(1)
