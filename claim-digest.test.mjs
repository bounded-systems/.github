// The claim-request format and the claim ladder (.github-private#637).
//
// ── What this suite is actually protecting ──────────────────────────────────
// Two different things, and they fail in different directions:
//
//   1. The ENCODING, against silent drift. claim-digest.vectors.json is a
//      committed fixture, not something this suite regenerates. So a change to
//      the field order, the length prefix, or the field set turns these tests
//      red — which is the only moment anyone is going to remember that old
//      authorizations were bound to the old bytes. A suite that re-derived the
//      fixture from the implementation would agree with itself forever and
//      catch precisely nothing.
//
//   2. The LADDER, against the boolean it wants to collapse into. Most of the
//      cases below assert that something is NOT `human-authorized` — an
//      assertion with no transaction binding, a stale user-verification, a
//      relying party that is the requester. Those are the paths that ship by
//      accident and then get described in a PR body as "passkey-gated". The
//      negative tests are the load-bearing half.
//
// Neither half verifies a signature: this repo holds no credential and the RP
// does not live here. What it holds is the definition both sides must agree on.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  CLAIM_REQUEST_FIELDS_V1,
  CLAIM_REQUEST_FIELDS_V2,
  CLAIM_REQUEST_V1,
  CLAIM_REQUEST_V2,
  PATCH_FIELDS_V1,
  REPO_CHARSET_V1,
  RUNGS,
  assuranceLevel,
  authorizationRung,
  canonicalClaimRequest,
  canonicalClaimRequestV2,
  canonicalPatchSet,
  claimDigest,
  claimDigestV2,
  patchSetDigest,
  validateClaimRequest,
  validateClaimRequestV2,
  validatePatchSet,
} from "./claim-digest.mjs";

const ROOT = dirname(fileURLToPath(import.meta.url));
const vectors = JSON.parse(readFileSync(join(ROOT, "claim-digest.vectors.json"), "utf8"));

// ── the encoding, against the committed fixture ──────────────────────────────

test("there are vectors to check", () => {
  // Guards the guard, the same way workflows.test.mjs does: an empty fixture
  // would make every loop below vacuously green.
  assert.ok(vectors.valid.length >= 5, `expected vectors, got ${vectors.valid.length}`);
  assert.ok(vectors.invalid.length >= 10, `expected refusal vectors, got ${vectors.invalid.length}`);
  assert.equal(vectors.format, CLAIM_REQUEST_V1);
  assert.deepEqual(vectors.fieldOrder, [...CLAIM_REQUEST_FIELDS_V1]);
});

test("every valid vector reproduces its canonical form and digest", async () => {
  for (const v of vectors.valid) {
    assert.deepEqual(validateClaimRequest(v.request), [], v.name);
    assert.equal(canonicalClaimRequest(v.request), v.canonical, `canonical form drifted: ${v.name}`);
    assert.equal(await claimDigest(v.request), v.digest, `digest drifted: ${v.name}`);
  }
});

test("every invalid vector is refused, and refused for a stated reason", () => {
  for (const v of vectors.invalid) {
    const errs = validateClaimRequest(v.request);
    assert.ok(errs.length > 0, `should have been refused: ${v.name}`);
    // The recorded reasons are part of the fixture: a validator that starts
    // refusing for a DIFFERENT reason than the one recorded has changed
    // behaviour even though the pass/fail bit is unchanged.
    assert.deepEqual(errs, v.errors, `refusal reason changed: ${v.name}`);
  }
});

test("canonicalClaimRequest refuses rather than hashing unvalidated input", () => {
  assert.throws(() => canonicalClaimRequest({ ...vectors.valid[0].request, issue: "0" }), /invalid claim request/);
  assert.throws(() => canonicalClaimRequest(null), /invalid claim request/);
  assert.throws(() => canonicalClaimRequest("not an object"), /invalid claim request/);
});

test("adjacent fields cannot be slid into one another", async () => {
  // The classic concatenation attack: repo="repo",issue="12" vs repo="repo1",
  // issue="2" are the same character sequence and MUST NOT be the same digest.
  // This is what the length prefix buys, so it gets a named test rather than
  // living only as two rows in the fixture.
  const a = vectors.valid.find((v) => v.request.repo === "repo" && v.request.issue === "12");
  const b = vectors.valid.find((v) => v.request.repo === "repo1" && v.request.issue === "2");
  assert.ok(a && b, "the near-collision pair is missing from the fixture");
  assert.notEqual(await claimDigest(a.request), await claimDigest(b.request));
});

test("the digest is 64 lowercase hex characters", async () => {
  for (const v of vectors.valid) assert.match(v.digest, /^[0-9a-f]{64}$/);
});

// ── the cross-file ratchet ───────────────────────────────────────────────────

test("the repo charset is the one claim-ticket.yml actually enforces", () => {
  // If these two drift apart, a human can be shown and sign a request the door
  // will refuse, or the door can admit one the digest never covered. Both are
  // silent. The door's preflight is a shell case pattern:
  //     case "$REPO" in (*[!A-Za-z0-9._-]*|"") ... exit 1
  // so the negated class inside it must be exactly REPO_CHARSET_V1.
  const wf = readFileSync(join(ROOT, ".github/workflows/claim-ticket.yml"), "utf8");
  const m = wf.match(/\(\*\[!([^\]]+)\]\*\|""\)/);
  assert.ok(m, "could not find the repo preflight pattern in claim-ticket.yml — if the door's guard moved, this ratchet must follow it, not be deleted");
  assert.equal(
    m[1],
    REPO_CHARSET_V1,
    `claim-ticket.yml refuses [!${m[1]}] but the digest accepts [${REPO_CHARSET_V1}]`,
  );
});

// ── the ladder ───────────────────────────────────────────────────────────────

const DIGEST = "a".repeat(64);
const RP = "desk.bounded.tools";
const expected = { digest: DIGEST, relyingParty: RP };

/** A record at the top of the ladder; each test below breaks exactly one thing. */
const authorized = {
  assertionVerified: true,
  relyingParty: RP,
  challenge: DIGEST,
  userVerification: "required",
  uvPerformed: true,
  attentionCheckPassed: true,
  backupEligible: false,
  approvers: ["person:alice"],
};

test("the ladder is ordered weakest-first and has no duplicates", () => {
  assert.equal(new Set(RUNGS).size, RUNGS.length);
  assert.equal(RUNGS[0], "unauthenticated");
  assert.equal(RUNGS.at(-1), "dual-human-authorized");
  // The five rungs the doc names must appear, in the doc's order.
  const doc = ["human-reviewed", "human-authenticated", "human-attended", "human-authorized", "dual-human-authorized"];
  assert.deepEqual(RUNGS.filter((r) => doc.includes(r)), doc);
});

test("a complete record reaches human-authorized with nothing held back", () => {
  const got = authorizationRung(authorized, expected);
  assert.equal(got.rung, "human-authorized");
  assert.deepEqual(got.reasons, []);
});

test("today's claim record — a dispatcher and nothing else — is human-associated", () => {
  // This is the state claim-ticket.yml is in as of #637: it names github.actor,
  // which is association. The suite asserts the honest label rather than the
  // aspirational one.
  const got = authorizationRung({ dispatcher: "bdelanghe" }, expected);
  assert.equal(got.rung, "human-associated");
  assert.match(got.reasons.join(" "), /association, not authorization/);
});

test("no record at all is unauthenticated", () => {
  assert.equal(authorizationRung(null, expected).rung, "unauthenticated");
  assert.equal(authorizationRung(undefined, expected).rung, "unauthenticated");
  assert.equal(authorizationRung("yes", expected).rung, "unauthenticated");
});

test("an UNBOUND assertion never reaches human-authorized", () => {
  // The single most important negative in this file. A passkey ceremony over a
  // server-random challenge is a real ceremony and proves a real thing — just
  // not the thing the claim record would be claiming. With an operation-specific
  // attention check it rises to human-attended, that rung's exact definition;
  // without one it is presence, which is human-authenticated.
  const unbound = { ...authorized, challenge: "b".repeat(64) };
  const attended = authorizationRung(unbound, expected);
  assert.equal(attended.rung, "human-attended");
  assert.match(attended.reasons.join(" "), /presence, not authorization of this claim/);
  const bare = authorizationRung({ ...unbound, attentionCheckPassed: undefined }, expected);
  assert.equal(bare.rung, "human-authenticated");
  assert.match(bare.reasons.join(" "), /control 6/);
});

test("a missing or malformed expected digest cannot be satisfied", () => {
  // A verifier that forgot to recompute the digest must not accidentally pass:
  // human-attended (this record carries an attention check) is its ceiling.
  for (const bad of [{}, { digest: undefined }, { digest: "short" }, { digest: DIGEST.slice(0, 63) }]) {
    const got = authorizationRung(authorized, { ...bad, relyingParty: RP });
    assert.equal(got.rung, "human-attended", JSON.stringify(bad));
  }
});

test("a stale ceremony is human-authenticated even when bound", () => {
  for (const stale of [{ userVerification: "preferred" }, { uvPerformed: false }, { uvPerformed: undefined }]) {
    const got = authorizationRung({ ...authorized, ...stale }, expected);
    assert.equal(got.rung, "human-authenticated", JSON.stringify(stale));
    assert.match(got.reasons.join(" "), /cached or inherited login is not an approval/);
  }
});

test("an assertion verified by the requester is capped at human-reviewed", () => {
  const got = authorizationRung({ ...authorized, relyingParty: "the-session-itself" }, expected);
  assert.equal(got.rung, "human-reviewed");
  assert.match(got.reasons.join(" "), /verified by the requester proves nothing/);
});

test("an unverified assertion does not lift the record off the bottom", () => {
  const got = authorizationRung({ ...authorized, assertionVerified: false }, expected);
  assert.equal(got.rung, "unauthenticated");
});

test("a bound approval without an attention check is still human-authorized", () => {
  // Binding outranks attention (#706): the doc's definition of this rung is
  // "explicitly approved the exact bound operation", which this record is. The
  // absent check stays visible in the record itself, not in the rung name.
  const got = authorizationRung({ ...authorized, attentionCheckPassed: undefined }, expected);
  assert.equal(got.rung, "human-authorized");
  assert.deepEqual(got.reasons, []);
});

test("a failed attention check never yields the rung whose definition says it passed", () => {
  // The negative #706 asked for by name: human-attended MEANS the person
  // completed an operation-specific attention check, so no record with
  // attentionCheckPassed !== true may ever be classified as it — whatever else
  // the record proves or fails to prove.
  const variants = [
    authorized,                                             // bound and fresh
    { ...authorized, challenge: "b".repeat(64) },           // unbound
    { ...authorized, uvPerformed: false },                  // stale
    { ...authorized, assertionVerified: false },            // unverified
    { ...authorized, relyingParty: "the-session-itself" },  // self-attested
  ];
  for (const record of variants) {
    for (const failed of [false, undefined, "true"]) {
      const got = authorizationRung({ ...record, attentionCheckPassed: failed }, expected);
      assert.notEqual(got.rung, "human-attended", JSON.stringify({ ...record, attentionCheckPassed: failed }));
    }
  }
});

test("two distinct approvers reach dual-human-authorized; one repeated does not", () => {
  const two = authorizationRung({ ...authorized, approvers: ["person:alice", "person:bob"] }, expected);
  assert.equal(two.rung, "dual-human-authorized");
  const dupe = authorizationRung({ ...authorized, approvers: ["person:alice", "person:alice"] }, expected);
  assert.equal(dupe.rung, "human-authorized");
});

// ── the authenticator axis ───────────────────────────────────────────────────

test("a syncable passkey is aal2 and cannot be reported as aal3", () => {
  const got = authorizationRung({ ...authorized, backupEligible: true }, expected);
  assert.equal(got.rung, "human-authorized"); // the protocol is fine…
  assert.equal(got.aal, "aal2");              // …the key is still exportable
});

test("a device-bound credential is aal3-ELIGIBLE, not aal3", () => {
  // Deliberate: nothing in this repo checks attestation, so nothing here may
  // say "aal3". The string is the claim, and it has to be the weakest true one.
  assert.equal(assuranceLevel({ backupEligible: false }), "aal3-eligible");
  assert.ok(!Object.values({ a: assuranceLevel({ backupEligible: false }) }).includes("aal3"));
});

test("an absent backup flag is unknown, not assumed", () => {
  assert.equal(assuranceLevel({}), "unknown");
  assert.equal(assuranceLevel(null), "unknown");
  assert.equal(assuranceLevel({ backupEligible: "false" }), "unknown");
});

// ── the ladder, against the committed fixture ────────────────────────────────
//
// The cases above are hand-written and stay that way — they read well and they
// are proven. What they are NOT is portable: they exercise this repo's
// implementation only. #310 measured the cost of that. The encoding vectors
// could not see the ladder, so when #706 landed here the vendored copy in
// bounded-systems/infra kept the pre-#706 classification and nothing went red
// for five days. It was dead code there, so nothing was mis-graded — but the
// keeper is one import away from grading with it.
//
// So the cases also live in claim-digest.vectors.json, and every implementation
// runs them from there. A case added to the fixture is a case infra's suite
// runs too, without anyone remembering to copy a test across.

/** A case's record: `record` replaces outright (including null); else patch/unset over the base. */
function ladderRecord(vector, base) {
  if ("record" in vector) return vector.record;
  const record = { ...base, ...(vector.patch ?? {}) };
  for (const key of vector.unset ?? []) delete record[key];
  return record;
}

test("the ladder fixture exists and every case asserts something", () => {
  assert.ok(vectors.ladder, "claim-digest.vectors.json carries no `ladder` section");
  assert.ok(vectors.ladder.cases.length >= 20, `expected ladder cases, got ${vectors.ladder.cases.length}`);
  for (const v of vectors.ladder.cases) {
    assert.ok(
      "rung" in v || "notRung" in v || "aal" in v,
      `ladder case asserts nothing, so it can never fail: ${v.name}`,
    );
  }
  // The fixture must cover #706 by name, because that is the drift it exists to catch.
  assert.ok(
    vectors.ladder.cases.some((v) => v.name.includes("#706")),
    "the fixture no longer names #706 — the case this section was written for",
  );
});

test("every ladder vector classifies exactly as the fixture says", () => {
  const { baseRecord, baseExpected, cases } = vectors.ladder;
  for (const v of cases) {
    const got = authorizationRung(ladderRecord(v, baseRecord), v.expected ?? baseExpected);
    if ("rung" in v) assert.equal(got.rung, v.rung, v.name);
    if ("notRung" in v) assert.notEqual(got.rung, v.notRung, v.name);
    if ("reasons" in v) assert.deepEqual(got.reasons, v.reasons, v.name);
    if ("reasonsMatch" in v) {
      assert.ok(
        got.reasons.join(" ").includes(v.reasonsMatch),
        `${v.name}: reasons ${JSON.stringify(got.reasons)} do not mention ${JSON.stringify(v.reasonsMatch)}`,
      );
    }
    if ("aal" in v) assert.equal(got.aal, v.aal, v.name);
  }
});

// ── v2: the claim bound to a patch set ───────────────────────────────────────
//
// Same discipline as the v1 block at the top of this file, against the `v2`
// section of the same committed fixture. Those digests were computed by an
// independent python/hashlib implementation of the format rule before they were
// committed, so a green run here is two implementations agreeing — not this one
// agreeing with itself.

const v2 = vectors.v2;

test("the v2 fixture is present and describes the format this file implements", () => {
  assert.ok(v2, "claim-digest.vectors.json carries no `v2` section");
  assert.equal(v2.format, CLAIM_REQUEST_V2);
  assert.deepEqual(v2.fieldOrder, [...CLAIM_REQUEST_FIELDS_V2]);
  assert.deepEqual(v2.patchFieldOrder, [...PATCH_FIELDS_V1]);
  assert.ok(v2.valid.length >= 3, `expected v2 vectors, got ${v2.valid.length}`);
  assert.ok(v2.invalid.length >= 8, `expected v2 refusals, got ${v2.invalid.length}`);
  assert.ok(v2.invalidPatchSets.length >= 8, `expected patch-set refusals, got ${v2.invalidPatchSets.length}`);
});

test("every patch-set vector reproduces its canonical form and digest", async () => {
  for (const p of v2.patchSets) {
    assert.equal(canonicalPatchSet(p.patches), p.canonical, p.name);
    assert.equal(await patchSetDigest(p.patches), p.digest, p.name);
  }
});

test("list ORDER is part of the request — the same bumps reversed are a different claim", async () => {
  // Not a sort. This file refuses sorted keys because "sorting is a rule someone
  // has to re-derive", and a list is already ordered, so there is nothing to
  // sort. Two orderings are two requests, and the fixture pins that they differ.
  const forward = v2.patchSets.find((p) => p.name.includes("in the producer's order"));
  const reversed = v2.patchSets.find((p) => p.name.includes("reversed"));
  assert.ok(forward && reversed, "the ordered pair is missing from the fixture");
  assert.deepEqual(
    [...forward.patches].reverse().map((p) => p.pr),
    reversed.patches.map((p) => p.pr),
    "the pair must be the same patches in the other order, or it proves nothing",
  );
  assert.notEqual(await patchSetDigest(forward.patches), await patchSetDigest(reversed.patches));
});

test("a patch cannot be slid into its neighbour", async () => {
  // The nested encoding inherits the outer form's adjacency property because it
  // reuses the same length-prefix loop; this pins that it actually holds.
  const a = v2.patchSets.find((p) => p.name.startsWith("adjacency:"));
  const b = v2.patchSets.find((p) => p.name.startsWith("...its near-collision"));
  assert.ok(a && b, "the adjacency pair is missing from the fixture");
  assert.notEqual(await patchSetDigest(a.patches), await patchSetDigest(b.patches));
});

test("every valid v2 vector reproduces its canonical form and digest", async () => {
  for (const c of v2.valid) {
    assert.equal(canonicalClaimRequestV2(c.request), c.canonical, c.name);
    assert.equal(await claimDigestV2(c.request), c.digest, c.name);
  }
});

test("a v2 request's subject IS the digest of its patch set", async () => {
  // The binding this version exists for. Without it `subject` is 64 hex
  // characters that happen to validate.
  for (const c of v2.valid) {
    assert.equal(await patchSetDigest(c.patches), c.request.subject, c.name);
  }
});

test("every invalid v2 vector is refused, and refused for a stated reason", () => {
  for (const c of v2.invalid) {
    const errs = validateClaimRequestV2(c.request);
    assert.ok(errs.length > 0, `not refused: ${c.name}`);
    assert.ok(
      errs.some((e) => e.includes(c.reason)),
      `${c.name}: refused as ${JSON.stringify(errs)}, expected to mention ${JSON.stringify(c.reason)}`,
    );
  }
});

test("every invalid patch set is refused, and refused for a stated reason", () => {
  for (const c of v2.invalidPatchSets) {
    const errs = validatePatchSet(c.patches);
    assert.ok(errs.length > 0, `not refused: ${c.name}`);
    assert.ok(
      errs.some((e) => e.includes(c.reason)),
      `${c.name}: refused as ${JSON.stringify(errs)}, expected to mention ${JSON.stringify(c.reason)}`,
    );
  }
});

test("v1 and v2 cannot collide, and neither validator accepts the other's request", () => {
  // `v` is the first field, so the tag is inside the digest rather than beside
  // it. The cross-validator check is the half that matters operationally: a v2
  // request must never be gradeable as v1, or the patch-set binding is optional
  // in practice.
  const v1req = vectors.valid[0].request;
  const v2req = v2.valid[0].request;
  assert.ok(validateClaimRequest(v2req).length > 0, "the v1 validator accepted a v2 request");
  assert.ok(validateClaimRequestV2(v1req).length > 0, "the v2 validator accepted a v1 request");
  assert.notEqual(v2.valid[0].digest, vectors.valid[0].digest);
});

test("canonicalPatchSet refuses rather than hashing unvalidated input", () => {
  assert.throws(() => canonicalPatchSet([]), /invalid patch set/);
  assert.throws(() => canonicalPatchSet([{ repo: "keycard", pr: "27", head_sha: "nope" }]), /invalid patch set/);
});
