/**
 * @module
 * The canonical form of a CLAIM REQUEST, and the digest a human authorization
 * is bound to. `.github-private`#637.
 *
 * ── What this is for ────────────────────────────────────────────────────────
 * `claim-ticket.yml` records who claimed a ticket, and the record is only as
 * good as the `claimant` string it was handed. Nothing authenticates that
 * string: door 2 explicitly does not (`.github-private`#530), and door 1 cannot
 * either — its own comment says why, `github.actor is owner-grade identity and
 * cannot name a guest` (#537, #558). So the claim record today is at best
 * HUMAN-ASSOCIATED: an account is somewhere in the chain.
 *
 * The upgrade is a WebAuthn assertion whose CHALLENGE IS THIS DIGEST. That is
 * the whole point and it is worth stating precisely, because the weaker version
 * is the one that gets built by accident:
 *
 *   an assertion over a server-random challenge proves a human was present.
 *   an assertion over THIS digest proves a human authorized THIS claim.
 *
 * `.github-private/docs/human-in-loop-authorization.md` §4 draws exactly that
 * line — ordinary WebAuthn establishes user presence/consent and is *not*
 * transaction authorization; the binding is what upgrades it. This module is
 * that binding, and nothing else. It holds no credential, verifies no
 * signature, and grants nothing.
 *
 * ── Why an explicit encoding rather than JSON ───────────────────────────────
 * The digest has to be reproduced byte-for-byte by at least three implementations
 * that will never share code: the relying party (a Worker, in `infra`), this
 * repo's claim door, and whatever mints the request. `JSON.stringify` is the
 * obvious choice and the wrong one — key order is insertion order, `/` may or
 * may not be escaped, non-ASCII may or may not be `\u`-escaped, and none of that
 * is pinned by the JSON grammar. Two conforming implementations can produce two
 * different strings for one object, which here means two different challenges
 * and a verification that fails for no visible reason.
 *
 * So: a fixed field ORDER (not sorted keys — sorting is a rule someone has to
 * re-derive), and length-prefixed values, so no value can be mistaken for a
 * delimiter no matter what it contains. A reimplementation is a for-loop and a
 * UTF-8 byte count. `claim-digest.vectors.json` is the cross-implementation
 * conformance fixture; it exists so the Worker can be checked against these
 * exact bytes rather than against a second reading of this comment.
 *
 * ── Dependency-free, and Worker-compatible on purpose ───────────────────────
 * Uses WebCrypto (`crypto.subtle`) rather than `node:crypto`, because the other
 * implementation of this file runs on Cloudflare Workers, where `node:crypto`
 * is not the default. Same reason `TextEncoder` does the byte counting.
 */

/**
 * The version tag, and the FIRST field of the canonical form — so a v2 request
 * cannot collide with a v1 request even if every other field matches.
 *
 * Adding, removing or reordering a field is a version bump, not an edit. The
 * digest is the only thing standing between "approved this claim" and "approved
 * some claim", and a silently-changed encoding turns old approvals into
 * unverifiable ones (or, worse, makes a new request match an old approval).
 */
export const CLAIM_REQUEST_V1 = "bounded.claim-request.v1";

/** The canonical field order for v1. Order is part of the format. */
export const CLAIM_REQUEST_FIELDS_V1 = Object.freeze([
  "v",
  "repo",
  "issue",
  "claimant",
  "policy",
  "nonce",
  "issuedAt",
]);

// ── validation ───────────────────────────────────────────────────────────────

/**
 * `repo` accepts exactly what `claim-ticket.yml`'s preflight accepts:
 * `case "$REPO" in (*[!A-Za-z0-9._-]*|"")` → refuse. Kept identical
 * DELIBERATELY. If the digest accepted a name the door refuses, a human could
 * be shown and sign a request the door will never execute; if the door accepted
 * one the digest refuses, the claim would run unbound. Either direction is a
 * gap, so the two charsets are asserted equal in claim-digest.test.mjs rather
 * than left to match by good intentions.
 */
export const REPO_CHARSET_V1 = "A-Za-z0-9._-";
const RE_REPO = new RegExp(`^[${REPO_CHARSET_V1}]+$`);

/**
 * `claimant` matches the charset the relay door already documents
 * (`claim-relay.yml`: `claimant` matching `[A-Za-z0-9/._-]+`) — `/` included
 * because a branch name is the common claimant and branch names carry it.
 */
const RE_CLAIMANT = /^[A-Za-z0-9/._-]+$/;

/** Decimal, no leading zeros — so `07` and `7` cannot be two requests for one issue. */
const RE_ISSUE = /^[1-9][0-9]*$/;

/** A policy version, e.g. `2026-08-20.1`. Dotted alphanumerics, no spaces. */
const RE_POLICY = /^[A-Za-z0-9][A-Za-z0-9.-]*$/;

/** 256 bits, base64url, unpadded — 43 characters. Single-use; the RP enforces that, not this. */
const RE_NONCE = /^[A-Za-z0-9_-]{43}$/;

/** RFC3339 UTC, second precision, literal `Z`. No offsets: an offset is a second spelling of one instant. */
const RE_ISSUED_AT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;

const CHECKS = {
  repo: [RE_REPO, "must be a plain repository name ([A-Za-z0-9._-]+)"],
  issue: [RE_ISSUE, "must be a decimal issue number with no leading zeros"],
  claimant: [RE_CLAIMANT, "must match [A-Za-z0-9/._-]+"],
  policy: [RE_POLICY, "must be a policy version like 2026-08-20.1"],
  nonce: [RE_NONCE, "must be 43 base64url characters (256 bits, unpadded)"],
  issuedAt: [RE_ISSUED_AT, "must be RFC3339 UTC with second precision (…Z)"],
};

/**
 * Validate a claim request. Returns a list of human-readable problems; empty
 * means valid. Same shape as org-defaults.mjs — a list, not a throw, so a caller
 * can report every problem at once instead of one per round trip.
 */
export function validateClaimRequest(req) {
  if (req === null || typeof req !== "object" || Array.isArray(req)) {
    return ["claim request must be an object"];
  }
  const errs = [];

  if (req.v !== CLAIM_REQUEST_V1) {
    errs.push(`v: must be exactly "${CLAIM_REQUEST_V1}"`);
  }
  for (const [field, [re, why]] of Object.entries(CHECKS)) {
    const val = req[field];
    if (typeof val !== "string") {
      errs.push(`${field}: missing, or not a string`);
    } else if (!re.test(val)) {
      errs.push(`${field}: ${why}`);
    }
  }

  // An unknown key is a REFUSAL, not something to ignore. Ignoring it is how a
  // field that one implementation signs and another drops becomes invisible:
  // the digests still match, and the extra field was never authorized by anyone.
  const unknown = Object.keys(req).filter((k) => !CLAIM_REQUEST_FIELDS_V1.includes(k));
  if (unknown.length > 0) {
    errs.push(`unknown field(s): ${unknown.sort().join(", ")} — a new field is a version bump`);
  }

  // Verify the date is real, not merely well-shaped: 2026-02-31 passes the regex.
  if (typeof req.issuedAt === "string" && RE_ISSUED_AT.test(req.issuedAt)) {
    const t = new Date(req.issuedAt);
    if (Number.isNaN(t.getTime()) || t.toISOString().replace(/\.\d{3}Z$/, "Z") !== req.issuedAt) {
      errs.push("issuedAt: not a real UTC instant");
    }
  }

  return errs;
}

// ── canonical form ───────────────────────────────────────────────────────────

const enc = new TextEncoder();

/**
 * The canonical byte string for a claim request.
 *
 * Each field, in `CLAIM_REQUEST_FIELDS_V1` order, as `<utf8-byte-length>:<value>\n`.
 * The length is of BYTES, not JS characters — a UTF-16 length would disagree
 * with every non-JS implementation the moment a value left ASCII. It cannot
 * today (every field is charset-restricted above, so Unicode normalization is
 * not a variable either) but the encoding must not depend on the validator's
 * current strictness for its correctness — the validator is a policy, the
 * encoding is a format.
 *
 * REFUSES to encode an invalid request. A digest over unvalidated input is a
 * commitment to something nobody checked, and it would be indistinguishable
 * from a real one downstream.
 */
export function canonicalClaimRequest(req) {
  const errs = validateClaimRequest(req);
  if (errs.length > 0) {
    throw new TypeError(`invalid claim request: ${errs.join("; ")}`);
  }
  let out = "";
  for (const field of CLAIM_REQUEST_FIELDS_V1) {
    const value = req[field];
    out += `${enc.encode(value).length}:${value}\n`;
  }
  return out;
}

/**
 * SHA-256 of the canonical form, lowercase hex.
 *
 * This is the value that goes in the WebAuthn `challenge` (as its 32 raw bytes),
 * and the value `claim-ticket.yml` recomputes from its own inputs before it
 * believes an authorization. Recomputing rather than accepting a supplied digest
 * is the point: a digest the requester hands you is a name it chose.
 */
export async function claimDigest(req) {
  const bytes = enc.encode(canonicalClaimRequest(req));
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// ── the claim ladder ─────────────────────────────────────────────────────────

/**
 * The rungs, weakest first. The middle five are
 * `.github-private/docs/human-in-loop-authorization.md` §"The claim ladder"
 * verbatim; `unauthenticated` and `human-associated` are added BELOW them
 * because they are what the org actually has today and the ladder has to be
 * able to say so. A ladder whose bottom rung is already an achievement cannot
 * describe the starting position.
 *
 * The discipline the doc attaches to this list is the whole reason it is a list
 * and not a boolean: PICK THE WEAKEST TRUE CLAIM.
 *
 * The two middle rungs are a LINEARIZATION OF TWO AXES — attention (control 6)
 * and transaction binding (control 4) — with binding ranked above attention,
 * because a digest binds the approval to the exact operation cryptographically
 * while an attention check ties it only behaviourally. So `human-authorized`
 * does not require the rung below it, and `human-attended` must never be
 * returned for a record whose attention check did not pass (#706). The doc's
 * §"The claim ladder" states the same rule; change both together.
 */
export const RUNGS = Object.freeze([
  "unauthenticated",        // nothing at all — no record
  "human-associated",       // an account is somewhere in the chain (today: github.actor)
  "human-reviewed",         // evidence was displayed; execution did not depend on it
  "human-authenticated",    // a credential bound to a person was freshly verified
  "human-attended",         // an operation-specific attention check was completed (binding not proven)
  "human-authorized",       // the assertion is bound to THIS request's digest — outranks, and does not require, the attention rung (#706)
  "dual-human-authorized",  // + a second independent person approved the same digest
]);

/**
 * Classify a `humanAuthorization` record against the claim it purports to
 * authorize. Returns `{ rung, reasons, aal }`.
 *
 * `reasons` names what held the rung down. That is the deliverable, not a
 * courtesy: `.github-private/docs/claim-boundary.md` P4 forbids a named
 * mechanism that does not resolve, and a verifier that returns `true` has
 * asserted a mechanism without naming which one ran. A caller writing
 * "human-authorized" into a claim record must be able to say why it is entitled
 * to the word.
 *
 * @param record the `humanAuthorization` field of a claim record, or null/undefined
 * @param expected `{ digest }` — the digest RECOMPUTED by the verifier from its
 *   own copy of the request. Never the digest the record carries.
 */
export function authorizationRung(record, expected = {}) {
  const reasons = [];
  const aal = assuranceLevel(record);

  if (record === null || record === undefined) {
    return { rung: "unauthenticated", reasons: ["no humanAuthorization record"], aal };
  }
  if (typeof record !== "object" || Array.isArray(record)) {
    return { rung: "unauthenticated", reasons: ["humanAuthorization is not an object"], aal };
  }

  // An assertion the RP did not verify is a blob. It is not evidence of
  // anything, so it does not lift the record off the bottom of the ladder.
  if (record.assertionVerified !== true) {
    const rung = record.dispatcher ? "human-associated" : "unauthenticated";
    reasons.push("assertionVerified !== true — no verified WebAuthn assertion");
    if (rung === "human-associated") {
      reasons.push(`a dispatcher (${record.dispatcher}) is named, which is association, not authorization`);
    }
    return { rung, reasons, aal };
  }

  // The relying party must not be the thing asking for the effect
  // (human-in-loop-authorization.md control 2, and §"Why the human is always
  // outside the room"). A session-rendered confirmation is self-attestation.
  if (record.relyingParty !== expected.relyingParty && expected.relyingParty !== undefined) {
    reasons.push(
      `relyingParty ${JSON.stringify(record.relyingParty)} is not the expected ` +
      `${JSON.stringify(expected.relyingParty)} — an assertion verified by the requester proves nothing`,
    );
    return { rung: "human-reviewed", reasons, aal };
  }

  // Freshness — control 5. `userVerification: required` is what was ASKED for;
  // `uvPerformed` is what the authenticator actually reported doing. Both, because
  // asking is not evidence.
  const fresh = record.userVerification === "required" && record.uvPerformed === true;
  if (!fresh) {
    reasons.push(
      "not a fresh user-verified ceremony (need userVerification === \"required\" " +
      "AND uvPerformed === true) — a cached or inherited login is not an approval",
    );
  }

  // Transaction binding — control 4, and the line §4 draws. This is the single
  // check that separates "a human was there" from "a human approved this".
  const bound = typeof expected.digest === "string" &&
    expected.digest.length === 64 &&
    typeof record.challenge === "string" &&
    timingSafeEqualHex(record.challenge, expected.digest);
  if (!bound) {
    reasons.push(
      "challenge is not this request's recomputed digest — the assertion proves " +
      "presence, not authorization of this claim",
    );
  }

  // A stale ceremony proves nothing was freshly decided, so nothing below may
  // lift it — an attention check completed inside a cached approval is cached
  // attention.
  if (!fresh) {
    return { rung: "human-authenticated", reasons, aal };
  }

  // Control 6 decides how far a fresh-but-UNBOUND ceremony rises. An
  // operation-specific check ties the person's attention to the operation even
  // without a digest — that is `human-attended`, and it is the ceiling: an
  // attention check reduces blind approval, it never proves comprehension, and
  // `attentionCheckPassed` must never be read as if it did. Once the assertion
  // IS bound, the check no longer gates the rung (RUNGS: binding outranks
  // attention, #706); its absence stays visible in the record, not the name.
  if (!bound) {
    if (record.attentionCheckPassed === true) {
      return { rung: "human-attended", reasons, aal };
    }
    reasons.push("no operation-specific attention check was passed (control 6)");
    return { rung: "human-authenticated", reasons, aal };
  }

  // Control 10. Two approvers, both over the SAME digest, and genuinely two.
  const approvers = Array.isArray(record.approvers) ? record.approvers : [];
  const distinct = new Set(approvers.filter((a) => typeof a === "string"));
  if (distinct.size >= 2) {
    return { rung: "dual-human-authorized", reasons, aal };
  }

  return { rung: "human-authorized", reasons, aal };
}

/**
 * What the AUTHENTICATOR is worth, which is a different axis from the ladder
 * above — the ladder grades the protocol, this grades the key.
 *
 * `human-in-loop-authorization.md` control 1: synchronized passkeys do not meet
 * AAL3, because their private keys are exportable. WebAuthn reports that as the
 * `backupEligible` (BE) flag — eligible to sync at all, which is the property
 * that matters, rather than `backupState`, which only says whether it has synced
 * yet. A credential that is merely not-yet-synced is still exportable.
 *
 * Note the ceiling honestly: BE === false makes a credential AAL3-ELIGIBLE, not
 * AAL3. Confirming it is device-bound needs authenticator attestation, which the
 * RP has to request at enrollment and which this record does not carry. Saying
 * "AAL3" from the absence of one flag is exactly the over-read the doc warns
 * about, so the value says `aal3-eligible` and means it.
 */
export function assuranceLevel(record) {
  if (record === null || typeof record !== "object" || Array.isArray(record)) return "unknown";
  if (record.backupEligible === true) {
    return "aal2"; // synced/syncable passkey — exportable key, AAL3 is unavailable
  }
  if (record.backupEligible === false) {
    return "aal3-eligible"; // device-bound as far as the flags go; attestation not checked here
  }
  return "unknown"; // flag absent — record it as unknown rather than assuming either way
}

/** Constant-time-ish comparison of two lowercase hex strings of equal length. */
function timingSafeEqualHex(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
