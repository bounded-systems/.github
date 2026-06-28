// Org-wide seam-coverage meta-test (closes the structural half of trust ledger
// row 3.2). Every `@bounded-systems/*` capability package must declare a seam
// claim — an `assertSeam(...)` test importing `@bounded-systems/seam-check`.
// Per-repo CI proves the repos that HAVE a check; this proves the SET is
// complete, so a brand-new uncovered capability repo can't slip in unnoticed.
//
// Discovery: a repo is a CAPABILITY PACKAGE iff its `package.json` carries a
// `"bounded"` block — the same per-package marker `bounded.tools`' registry is
// generated from, and the one signal reliably present on GitHub. We enumerate
// the org's public repos, keep the ones with that marker, shallow-clone each,
// and run the published `assertAllPackagesChecked` over them (reusing the
// harness, not reimplementing it).

import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { UncheckedPackagesError, assertAllPackagesChecked } from "@bounded-systems/seam-check";

/**
 * Repos excluded from the check — PERMANENT only: packages a leaf seam claim
 * doesn't apply to. The meta-test still FAILS on any *new* capability repo not
 * listed here. The `prx-w2mf` baseline is fully burned down — schema-gen (#3),
 * ocap-provenance (#9), and door-kit (#16) are migrated and now enforced.
 */
const EXEMPT = new Set<string>([
  "seam-check", // the harness itself; self-tested (imports ../index.ts, not the marker)
  "guest-room", // runtime: composes capabilities (BDD specs), not an extractable leaf
]);

function gh(args: string[], quiet = false): string {
  return execFileSync("gh", args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", quiet ? "ignore" : "inherit"],
  });
}

/** Public, non-archived repos in the org. */
function listOrgRepos(): string[] {
  return gh([
    "api",
    "--paginate",
    "/orgs/bounded-systems/repos?per_page=100",
    "--jq",
    '.[] | select(.archived | not) | select(.visibility == "public") | .name',
  ])
    .trim()
    .split("\n")
    .filter(Boolean);
}

/** A repo is a capability package iff its package.json carries a `bounded` block. */
function isCapabilityPackage(name: string): boolean {
  let contentB64: string;
  try {
    // quiet: a 404 here just means "no package.json" (most non-package repos).
    contentB64 = gh(
      ["api", `repos/bounded-systems/${name}/contents/package.json`, "--jq", ".content"],
      true,
    );
  } catch {
    return false; // no package.json
  }
  return Buffer.from(contentB64, "base64").toString("utf8").includes('"bounded"');
}

function main(): void {
  const capability = listOrgRepos()
    .filter((n) => !EXEMPT.has(n))
    .filter(isCapabilityPackage)
    .sort();

  const workspace = mkdtempSync(join(tmpdir(), "seam-coverage-"));
  try {
    for (const name of capability) {
      execFileSync(
        "git",
        ["clone", "--quiet", "--depth", "1", `https://github.com/bounded-systems/${name}`, join(workspace, name)],
        { stdio: ["ignore", "ignore", "inherit"] },
      );
    }
    assertAllPackagesChecked({ packagesDir: workspace });
    console.log(`✓ seam coverage: all ${capability.length} capability packages declare a seam claim.`);
    console.log(`  checked: ${capability.join(", ")}`);
    console.log(`  exempt (permanent — not leaf seams): ${[...EXEMPT].sort().join(", ")}`);
  } catch (err) {
    if (err instanceof UncheckedPackagesError) {
      console.error(
        `✗ seam-coverage gap — capability packages (carry a 'bounded' block) with NO seam check:\n  ` +
          `${err.packages.join("\n  ")}\n\n` +
          `Add @bounded-systems/seam-check + an assertSeam test (recipe: see fs/host), ` +
          `or add to EXEMPT with a written reason (bead prx-w2mf).`,
      );
      process.exit(1);
    }
    throw err;
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
}

main();
