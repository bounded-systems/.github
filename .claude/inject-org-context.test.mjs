// Ratchet for the org-context source host (infra#414/#415, .github-private#534 item 2).
//
// ── Why this exists ──────────────────────────────────────────────────────────
// `inject-org-context.sh` step 0 was the LAST session-side fetch of
// raw.githubusercontent.com, and the only reason that host was still granted in
// the shared front-desk egress dialog. It now goes through the boot Worker,
// which fetches the same file from Cloudflare's network and streams it through.
//
// The retirement is worth nothing if the line comes back. And it would come back
// invisibly: while the allowlist entry still exists, a reverted step 0 works
// perfectly and nothing reports it. Only after the grant is dropped would the
// symptom appear — as "sessions have no org context", in a repo nobody would
// think to look at, on a schedule nobody controls. That is the same shape as the
// #71/#72 pin pair and the toolpath ratchet next door: a property that is only
// observable long after the change that broke it.
//
// So this file holds the property directly. It is deliberately a CONTENT gate on
// the script rather than a behavioural test: the failure mode is textual (a
// URL), the check should be too, and a test that ran the hook would need network
// and would pass against either host.
//
// ── What this does NOT claim ─────────────────────────────────────────────────
// Nothing here proves the Worker serves the right bytes — that is the Worker's
// own suite (infra: cloudflare/boot/src/index.test.mjs, which asserts the
// upstream URL as a literal and that the route never reads CONTEXT_KV) plus the
// deploy read-back. This file only pins which host a SESSION contacts.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const HOOK = fileURLToPath(new URL("./inject-org-context.sh", import.meta.url));
const src = readFileSync(HOOK, "utf8");

// Comments legitimately DISCUSS the retired host — the step 0 block explains at
// length why it is gone and why no fallback to it is kept. Stripping comments is
// what separates "explains the retirement" from "still does it".
const code = src
  .split("\n")
  .filter((l) => !/^\s*#/.test(l))
  .join("\n");

test("step 0 fetches the org context from the boot Worker", () => {
  assert.match(
    code,
    /https:\/\/boot\.bounded\.tools\/public-context\.md/,
    "step 0 must fetch the public org context through the boot Worker proxy",
  );
});

test("no executable line fetches raw.githubusercontent.com — the retired grant", () => {
  const offenders = code
    .split("\n")
    .map((l, i) => [i + 1, l])
    .filter(([, l]) => l.includes("raw.githubusercontent.com"));
  assert.deepEqual(
    offenders,
    [],
    `raw.githubusercontent.com is back in executable code — that grant is being retired ` +
      `(.github-private#534 item 2). If this is deliberate, the allowlist entry has to come ` +
      `back in the same sitting, in .github-private's BS_ROUTES_CONFIG and every adopter's ` +
      `record. Offending line(s): ${JSON.stringify(offenders)}`,
  );
});

test("the lease-gated route is NOT what this hook reaches for", () => {
  // /context.md serves the .github-PRIVATE copy out of CONTEXT_KV behind a
  // bearer. This hook wants the public copy. Reaching for the gated one would
  // 401 in every session — and worse, a session that somehow held the lease key
  // would be injected a DIFFERENT file than bare sessions get, which is exactly
  // the #581 divergence this org already paid for once.
  assert.ok(
    !/boot\.bounded\.tools\/context\.md/.test(code),
    "the hook must use /public-context.md, not the lease-gated /context.md",
  );
});

test("the github.com fallbacks survive — this change removes a host, not resilience", () => {
  // Step 0 moving hosts must not quietly become step 0 being the only source.
  // These three run over github.com, which is not going anywhere, and they are
  // what covers the Worker being unreachable.
  assert.match(code, /gh api /, "the gh-api fallback (step 1) is missing");
  assert.match(code, /git clone /, "the git-clone fallback (step 2) is missing");
  assert.match(code, /api\.github\.com/, "the token-curl fallback (step 3) is missing");
});

test("the degraded-mode line names the source actually tried", () => {
  // Fail open but never silent (#491) is only useful if the line is TRUE. When
  // step 0's host changed, a message still saying "public raw" would send the
  // next person debugging to a host this script no longer contacts.
  const m = src.match(/org context NOT loaded[^"]*/);
  assert.ok(m, "the degraded-mode message is gone — #491's whole lesson");
  const msg = m[0];
  assert.ok(
    msg.includes("boot.bounded.tools"),
    `the degraded message must name the source step 0 actually uses: ${msg}`,
  );
  assert.ok(
    !/public raw/.test(msg),
    `the degraded message still says "public raw" — step 0 no longer fetches raw: ${msg}`,
  );
});
