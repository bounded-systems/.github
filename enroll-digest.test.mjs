// The enroll-request format (infra#482).
//
// Same protection claim-digest.test.mjs states for its half: the ENCODING,
// against silent drift. enroll-digest.vectors.json is a committed fixture, not
// something this suite regenerates — a change to the field order, the length
// prefix, or the field set turns these tests red, which is the only moment
// anyone will remember that old approvals were bound to the old bytes. What is
// NOT here: the pending-credential state and the approval itself live in the
// relying party (infra), which conformance-tests against this same fixture.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ENROLL_REQUEST_FIELDS_V1,
  ENROLL_REQUEST_V1,
  canonicalEnrollRequest,
  enrollDigest,
  validateEnrollRequest,
} from "./enroll-digest.mjs";

const ROOT = dirname(fileURLToPath(import.meta.url));
const vectors = JSON.parse(readFileSync(join(ROOT, "enroll-digest.vectors.json"), "utf8"));

test("there are vectors to check", () => {
  // Guards the guard: an empty fixture would make every loop below vacuously green.
  assert.ok(vectors.valid.length >= 5, `expected vectors, got ${vectors.valid.length}`);
  assert.ok(vectors.invalid.length >= 10, `expected refusal vectors, got ${vectors.invalid.length}`);
  assert.equal(vectors.format, ENROLL_REQUEST_V1);
  assert.deepEqual(vectors.fieldOrder, [...ENROLL_REQUEST_FIELDS_V1]);
});

test("every valid vector reproduces its canonical form and digest", async () => {
  for (const v of vectors.valid) {
    assert.deepEqual(validateEnrollRequest(v.request), [], v.name);
    assert.equal(canonicalEnrollRequest(v.request), v.canonical, `canonical form drifted: ${v.name}`);
    assert.equal(await enrollDigest(v.request), v.digest, `digest drifted: ${v.name}`);
  }
});

test("every invalid vector is refused, and refused for a stated reason", () => {
  for (const v of vectors.invalid) {
    const errs = validateEnrollRequest(v.request);
    assert.ok(errs.length > 0, `should have been refused: ${v.name}`);
    // The recorded reasons are part of the fixture: a validator that starts
    // refusing for a DIFFERENT reason has changed behaviour even though the
    // pass/fail bit is unchanged.
    assert.deepEqual(errs, v.errors, `refusal reason changed: ${v.name}`);
  }
});

test("canonicalEnrollRequest refuses rather than hashing unvalidated input", () => {
  assert.throws(() => canonicalEnrollRequest({ ...vectors.valid[0].request, alg: "0" }), /invalid enroll request/);
  assert.throws(() => canonicalEnrollRequest(null), /invalid enroll request/);
  assert.throws(() => canonicalEnrollRequest("not an object"), /invalid enroll request/);
});

test("adjacent fields cannot be slid into one another", async () => {
  // The classic concatenation attack: person="p", credentialId="AAA…A" (23) vs
  // person="pA", credentialId="AA…A" (22) are the same character sequence and
  // MUST NOT be the same digest. This is what the length prefix buys, so it
  // gets a named test rather than living only as two rows in the fixture.
  const a = vectors.valid.find((v) => v.request.person === "p");
  const b = vectors.valid.find((v) => v.request.person === "pA");
  assert.ok(a && b, "the near-collision pair is missing from the fixture");
  assert.equal(a.request.person + a.request.credentialId, b.request.person + b.request.credentialId);
  assert.notEqual(await enrollDigest(a.request), await enrollDigest(b.request));
});

test("the digest is 64 lowercase hex characters", async () => {
  for (const v of vectors.valid) assert.match(v.digest, /^[0-9a-f]{64}$/);
});

test("a token field is refused by name — the field this format exists to retire", () => {
  // infra#482's whole point: after the first enrollment, no bearer string
  // anywhere in the chain. A request carrying one is not a stricter request,
  // it is a different protocol.
  const errs = validateEnrollRequest({ ...vectors.valid[0].request, token: "hand-carried" });
  assert.deepEqual(errs, ["unknown field(s): token — a new field is a version bump"]);
});
