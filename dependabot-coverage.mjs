// Does .github/dependabot.yml actually cover the manifests in the tree?
//
// WHY THIS EXISTS. On 2026-08-28 a sweep of 15 repos found 9 whose
// dependabot.yml declared only `github-actions` while the repo carried npm or
// cargo manifests. The shared template had been copied WHOLESALE instead of
// appended to, which its own "ADOPTING THIS FILE" note tells adopters not to
// do. Nothing went red: with no npm entry there are simply no npm updates, so
// 30 advisories sat in lockfiles while the osv lane hard-failed on them every
// run, until they were moved by hand.
//
// Dependabot's failure mode is SILENCE. This turns the same condition into a
// check, which is the only form the org treats as a gate (docs/merge-gate.md:
// a predicate is machine-checkable, or it is a guideline).
//
// THREE OUTCOMES, not two. The distinction is load-bearing:
//   covered     - a manifest, and an entry that updates it.
//   uncovered   - a manifest, an ecosystem Dependabot SUPPORTS, and no entry.
//                 This is the bug. It fails.
//   uncoverable - a manifest Dependabot has no ecosystem for at all (deno).
//                 Reported, never failed: no config can fix it, and failing on
//                 it would make the check unfixable and therefore ignored.

/** Manifest/lockfile -> the Dependabot ecosystem that updates it. */
export const ECOSYSTEM_FOR = new Map([
  ["package-lock.json", "npm"],
  ["yarn.lock", "npm"],
  ["pnpm-lock.yaml", "npm"],
  ["npm-shrinkwrap.json", "npm"],
  // bun.lock is NOT npm. Dependabot ships a distinct `bun` ecosystem, and the
  // npm one does not parse a bun lockfile - declaring npm for a bun repo is a
  // silent no-op that LOOKS correct in review. prx already declares `bun`.
  ["bun.lock", "bun"],
  ["bun.lockb", "bun"],
  ["Cargo.toml", "cargo"],
  ["Cargo.lock", "cargo"],
  ["go.mod", "gomod"],
  ["requirements.txt", "pip"],
  ["pyproject.toml", "pip"],
  ["Pipfile", "pip"],
  ["Gemfile", "bundler"],
  ["composer.json", "composer"],
  ["Dockerfile", "docker"],
]);

/** Manifests with no Dependabot ecosystem in existence. Reported, not failed. */
export const UNCOVERABLE = new Map([
  ["deno.json", "deno"],
  ["deno.jsonc", "deno"],
  ["deno.lock", "deno"],
]);

/**
 * Read the `updates:` list out of a dependabot.yml.
 *
 * Deliberately NOT a general YAML parser - the org has no yaml dependency, and
 * adding one to org-defaults for a lint is the wrong trade. This understands
 * exactly the shape Dependabot's schema permits for the two keys that matter,
 * and the test suite pins it against the real configs in this org, including
 * the multi-ecosystem one (prx) and the shared template.
 */
export function readDependabotUpdates(text) {
  if (typeof text !== "string") return [];
  const out = [];
  let cur = null;
  for (const raw of text.split("\n")) {
    const line = raw.replace(/\t/g, "  ");
    if (/^\s*#/.test(line) || line.trim() === "") continue;
    const eco = line.match(/^\s*-\s*package-ecosystem:\s*["']?([\w-]+)["']?/);
    if (eco) {
      if (cur) out.push(cur);
      cur = { ecosystem: eco[1], directory: "/" };
      continue;
    }
    if (!cur) continue;
    const dir = line.match(/^\s+directory:\s*["']?([^"'\s#]+)["']?/);
    if (dir) cur.directory = dir[1];
  }
  if (cur) out.push(cur);
  return out;
}

const dirOf = (p) => {
  const i = p.lastIndexOf("/");
  return i === -1 ? "/" : "/" + p.slice(0, i);
};
const norm = (d) => {
  const s = d === "" || d === "." ? "/" : d.startsWith("/") ? d : "/" + d;
  return s.replace(/\/+$/, "") || "/";
};

const inside = (child, root) => root === "/" ? child !== "/" : child.startsWith(root + "/");

/**
 * @param {object} input
 * @param {string[]} input.paths        every tracked path in the repo
 * @param {{ecosystem:string,directory:string}[]} input.updates  parsed dependabot entries
 * @param {{ecosystem:string,directory:string}[]} [input.workspaces]
 *   Workspace ROOTS. A cargo workspace root updates its members, and so does an
 *   npm/bun workspace root - Dependabot resolves the members from the root
 *   manifest. Without this, hooksmith reports 28 separate cargo directories for
 *   one workspace, and a check that noisy gets switched off, which is the
 *   "noise machine nobody reads" failure the shared template already warns
 *   about for ungrouped updates.
 * @returns {{covered:object[], uncovered:object[], uncoverable:object[], ok:boolean}}
 */
export function coverageReport({ paths = [], updates = [], workspaces = [] }) {
  const declared = new Set(
    updates.map((u) => `${u.ecosystem} ${norm(u.directory ?? "/")}`),
  );
  const roots = workspaces.map((w) => ({
    ecosystem: w.ecosystem,
    directory: norm(w.directory ?? "/"),
  }));
  const covered = [];
  const uncovered = [];
  const uncoverable = [];
  const needs = [];

  for (const p of paths) {
    const base = p.split("/").pop();
    if (UNCOVERABLE.has(base)) {
      uncoverable.push({
        path: p,
        reason: `no Dependabot ecosystem for ${UNCOVERABLE.get(base)}`,
      });
      continue;
    }
    const eco = ECOSYSTEM_FOR.get(base);
    if (eco) needs.push({ path: p, ecosystem: eco, directory: norm(dirOf(p)) });
  }

  // github-actions is implied by any workflow file, and lives at the root.
  if (paths.some((p) => /^\.github\/workflows\/[^/]+\.ya?ml$/.test(p))) {
    needs.push({
      path: ".github/workflows/",
      ecosystem: "github-actions",
      directory: "/",
    });
  }

  // package.json alone does not imply npm: a bun repo has one too, and the
  // lockfile is what decides. Only count it when no JS lockfile sits beside it.
  for (const p of paths) {
    if (p.split("/").pop() !== "package.json") continue;
    const d = norm(dirOf(p));
    if (needs.some((n) => n.directory === d && (n.ecosystem === "npm" || n.ecosystem === "bun"))) continue;
    needs.push({ path: p, ecosystem: "npm", directory: d });
  }

  const seen = new Set();
  for (const n of needs) {
    // A member of a declared workspace is already updated from its root.
    // cargo and the JS ecosystems both resolve members from the root manifest.
    const memberOf = roots.find(
      (r) =>
        inside(n.directory, r.directory) &&
        (r.ecosystem === n.ecosystem ||
          (["npm", "bun"].includes(r.ecosystem) && ["npm", "bun"].includes(n.ecosystem))),
    );
    if (memberOf) continue;

    const key = `${n.ecosystem} ${n.directory}`;
    if (seen.has(key)) continue;
    seen.add(key);
    (declared.has(key) ? covered : uncovered).push(n);
  }
  return { covered, uncovered, uncoverable, ok: uncovered.length === 0 };
}

export function formatReport(repo, r) {
  const lines = [];
  for (const u of r.uncovered) {
    lines.push(`  MISSING  ${u.ecosystem} at ${u.directory}  (needed by ${u.path})`);
  }
  for (const u of r.uncoverable) {
    lines.push(`  note     ${u.path}: ${u.reason} - needs a manual updater`);
  }
  const head = `${repo}: ${r.ok ? "ok" : `${r.uncovered.length} uncovered`}`;
  return lines.length ? `${head}\n${lines.join("\n")}` : head;
}
