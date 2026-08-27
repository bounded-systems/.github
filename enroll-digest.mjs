/**
 * @module
 * The canonical form of an ENROLL REQUEST, and the digest a human authorization
 * is bound to. infra#482 — every keeper enrollment after the first is
 * authorized by an existing passkey, no token.
 *
 * ── What this is for ────────────────────────────────────────────────────────
 * The keeper's bootstrap enrollment is gated by a hand-carried token, and stays
 * that way deliberately: before any passkey exists, every machine channel is
 * account-shaped, which is the channel class the keeper exists to escape. This
 * format is the AFTER-the-first path. A new device registers a credential that
 * lands PENDING, the relying party opens a ceremony whose challenge is the
 * digest of this request, and an ALREADY-ENROLLED credential approves it. The
 * digest is what makes the approval mean "this credential, for this person,
 * with this label" rather than "some enrollment happened".
 *
 * Same discipline as `claim-digest.mjs`, for the same reasons (its module
 * header carries the full argument): fixed field ORDER rather than sorted keys,
 * length-prefixed values rather than JSON, refusal of unknown fields, and a
 * committed conformance fixture (`enroll-digest.vectors.json`) so the relying
 * party's implementation is checked against these exact bytes. This module
 * holds no credential, verifies no signature, and grants nothing — the pending
 * state and the approval live in the relying party (infra).
 */

/**
 * The version tag, and the FIRST field of the canonical form — so a v2 request
 * cannot collide with a v1 request even if every other field matches. Adding,
 * removing or reordering a field is a version bump, not an edit.
 */
export const ENROLL_REQUEST_V1 = "bounded.enroll-request.v1";

/** The canonical field order for v1. Order is part of the format. */
export const ENROLL_REQUEST_FIELDS_V1 = Object.freeze([
  "v",
  "person",
  "credentialId",
  "alg",
  "label",
]);

// ── validation ───────────────────────────────────────────────────────────────

/** The identity the credential binds to — the same shape the claim format's
 * `repo` uses. No `/`: a person is a name, not a path. */
const RE_PERSON = /^[A-Za-z0-9._-]+$/;

/**
 * The NEW credential requesting enrollment, base64url unpadded — the encoding
 * WebAuthn uses on the wire. Bounds from the spec: a credential id is at most
 * 1023 bytes (1364 base64url characters), and a randomly-generated one carries
 * at least 16 bytes (22 characters); anything shorter is guessable, and a
 * guessable id here names a credential an approver never saw.
 */
const RE_CREDENTIAL_ID = /^[A-Za-z0-9_-]{22,1364}$/;

/** A COSE algorithm identifier as a decimal string, e.g. `-7` (ES256), `-257`
 * (RS256). Nonzero (0 is reserved in COSE), no leading zeros — so `-07` and
 * `-7` cannot be two requests for one credential. */
const RE_ALG = /^-?[1-9][0-9]*$/;

/**
 * A short device label the human will read on the approval screen — "iPhone 17",
 * "YubiKey 5C". Words from the org charset joined by SINGLE spaces: no leading,
 * trailing or doubled space, because "iPhone  17" and "iPhone 17" render
 * identically on that screen and two spellings of one label is exactly the
 * ambiguity the rest of this format refuses. Length is capped separately.
 */
const RE_LABEL = /^[A-Za-z0-9._-]+( [A-Za-z0-9._-]+)*$/;
const LABEL_MAX = 64;

const CHECKS = {
  person: [RE_PERSON, "must match [A-Za-z0-9._-]+"],
  credentialId: [RE_CREDENTIAL_ID, "must be 22-1364 base64url characters (a WebAuthn credential id)"],
  alg: [RE_ALG, "must be a COSE algorithm number like -7, no leading zeros"],
  label: [RE_LABEL, "must be words of [A-Za-z0-9._-] separated by single spaces"],
};

/**
 * Validate an enroll request. Returns a list of human-readable problems; empty
 * means valid — the same contract as `validateClaimRequest`, so callers treat
 * the formats identically.
 */
export function validateEnrollRequest(req) {
  if (req === null || typeof req !== "object" || Array.isArray(req)) {
    return ["enroll request must be an object"];
  }
  const errs = [];

  if (req.v !== ENROLL_REQUEST_V1) {
    errs.push(`v: must be exactly "${ENROLL_REQUEST_V1}"`);
  }
  for (const [field, [re, why]] of Object.entries(CHECKS)) {
    const val = req[field];
    if (typeof val !== "string") {
      errs.push(`${field}: missing, or not a string`);
    } else if (!re.test(val)) {
      errs.push(`${field}: ${why}`);
    }
  }

  // An unknown key is a REFUSAL, not something to ignore — claim-digest.mjs
  // states why, and the failure it stops is the same here: a field one side
  // signs and the other drops is invisible in matching digests.
  const unknown = Object.keys(req).filter((k) => !ENROLL_REQUEST_FIELDS_V1.includes(k));
  if (unknown.length > 0) {
    errs.push(`unknown field(s): ${unknown.sort().join(", ")} — a new field is a version bump`);
  }

  // The label cap is not in RE_LABEL (a length bound across a repeating group
  // is not expressible there); charset first, then length, so each failure is
  // named for what it is.
  if (typeof req.label === "string" && RE_LABEL.test(req.label) && req.label.length > LABEL_MAX) {
    errs.push(`label: longer than ${LABEL_MAX} characters`);
  }

  return errs;
}

// ── canonical form ───────────────────────────────────────────────────────────

const enc = new TextEncoder();

/**
 * The canonical byte string: each field, in `ENROLL_REQUEST_FIELDS_V1` order,
 * as `<utf8-byte-length>:<value>\n` — the claim format's shape exactly, and for
 * its reasons (byte counts, not JS characters; the encoding must not depend on
 * the validator's strictness for its correctness).
 *
 * REFUSES to encode an invalid request. A digest over unvalidated input is a
 * commitment to something nobody checked.
 */
export function canonicalEnrollRequest(req) {
  const errs = validateEnrollRequest(req);
  if (errs.length > 0) {
    throw new TypeError(`invalid enroll request: ${errs.join("; ")}`);
  }
  let out = "";
  for (const field of ENROLL_REQUEST_FIELDS_V1) {
    const value = req[field];
    out += `${enc.encode(value).length}:${value}\n`;
  }
  return out;
}

/**
 * SHA-256 of the canonical form, lowercase hex — the WebAuthn `challenge` (as
 * its 32 raw bytes) of the authorization ceremony an already-enrolled
 * credential approves. The relying party recomputes this from the pending
 * credential's own record, never from anything the enrolling device sent at
 * approval time: a digest the requester hands you is a name it chose.
 */
export async function enrollDigest(req) {
  const bytes = enc.encode(canonicalEnrollRequest(req));
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
