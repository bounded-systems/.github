/**
 * @module
 * The verification leg of the claim door: redeem a human authorization at the
 * relying party, then say which rung of the ladder it actually proved.
 * `.github-private`#642, step 3 of `docs/handoffs/passkey-claim-authorization.md`.
 *
 * ── What this adds to claim-digest.mjs ──────────────────────────────────────
 * `claim-digest.mjs` is the FORMAT — the canonical bytes both sides agree on,
 * and `authorizationRung()`, which grades a record. It performs no I/O and
 * knows nothing about any particular relying party. This module is the CONSUMER
 * side: it builds the request from the door's own inputs, hands it to the RP for
 * redemption, and turns the RP's answer into the record the ladder grades.
 *
 * The split matters because #225 landed the format alone on purpose, and the
 * door stayed untouched until something could actually populate the field
 * (`claim-boundary.md` P4 — a named mechanism that does not resolve is worse
 * than no mechanism). This file is that something.
 *
 * ── The one property everything here exists to protect ──────────────────────
 * WHAT IS BEING AUTHORIZED COMES FROM THE DOOR, NEVER FROM THE TOKEN.
 *
 * `repo`, `issue` and `claimant` are the door's own `workflow_dispatch` inputs,
 * and `policy` is a constant below. The token contributes only `nonce` and
 * `issuedAt` — the anti-replay values, which name no capability. So a token
 * minted for some other claim cannot be spent here: the request this module
 * builds names THIS claim, the digest differs, and both the RP's redemption and
 * the ladder's binding check refuse it.
 *
 * That is also why the token does not carry a digest. A digest handed to you is
 * a name the requester chose (#641 non-negotiable 1); it is recomputed here, and
 * again by the RP, from bytes neither of them was given.
 *
 * ── Two verifications, deliberately ─────────────────────────────────────────
 * The RP refuses a redemption bound to a different request, AND
 * `authorizationRung()` independently checks that the challenge the human signed
 * equals the digest recomputed here. That is not belt-and-braces for its own
 * sake: the two answer to different code, and the second is what produces the
 * RUNG — which is the deliverable. A door that only asked the RP "is this ok?"
 * would be back to a boolean, and a boolean cannot say what it proved.
 */

import {
  CLAIM_REQUEST_V1,
  RUNGS,
  claimDigest,
  validateClaimRequest,
  authorizationRung,
} from "./claim-digest.mjs";

/**
 * The claim policy version this door implements, and it is a CONSTANT rather
 * than an input on purpose: `policy` is part of the digest, so letting a caller
 * choose it would let a caller decide which policy the human's signature is
 * read against. A human who signed under a different policy version simply does
 * not verify here — the digest differs and the run goes red, which is the
 * correct outcome and the reason bumping this value is a deliberate act.
 *
 * Matches the value the committed vectors use (`claim-digest.vectors.json`).
 */
export const CLAIM_POLICY_V1 = "2026-08-20.1";

/**
 * The rung at or above which a supplied authorization is accepted.
 *
 * `human-authorized` is what the keeper's ceremony produces: a fresh,
 * user-verified assertion bound to this request's digest — which is that rung's
 * exact definition, attention check or none (binding outranks attention,
 * `.github-private`#706; it was misnamed `human-attended` before that). The
 * floor IS the fresh-and-bound predicate: anything below it means the
 * redemption succeeded but the ceremony did not prove the binding the door is
 * about to write down — `human-attended` included, because an attention check
 * over an unbound challenge approves no particular claim — and the door fails
 * closed rather than recording a weaker rung it was not asked for.
 *
 * Note this threshold is about a token that WAS supplied. A claim with no token
 * at all is a different case entirely — see `recordAbsent()`.
 */
export const MIN_ACCEPTED_RUNG = "human-authorized";

/** Fields a token may carry. Anything else is a refusal, not something to ignore. */
export const TOKEN_FIELDS = Object.freeze(["authorizationId", "nonce", "issuedAt"]);

const RE_AUTHORIZATION_ID = /^[A-Za-z0-9_-]{1,128}$/;

/**
 * Parse the door's `human_authorization` input.
 *
 * Two spellings accepted, and the reason is ergonomic rather than principled:
 * base64url of the compact JSON is what a relying party would hand a human as
 * one opaque string, and bare JSON is what a human will paste into a
 * `workflow_dispatch` box when they have the object in front of them. Refusing
 * the second would turn a copy-paste into a red production run for no security
 * gain — the fields are validated identically either way.
 *
 * @param raw the input value, already known to be non-empty
 * @returns {{authorizationId: string, nonce: string, issuedAt: string}}
 * @throws {TypeError} with a message naming every problem at once
 */
export function parseAuthorizationToken(raw) {
  if (typeof raw !== "string" || raw.trim() === "") {
    throw new TypeError("authorization token: empty");
  }
  const text = raw.trim();
  let json;
  if (text.startsWith("{")) {
    json = text;
  } else {
    if (!/^[A-Za-z0-9_-]+$/.test(text)) {
      throw new TypeError(
        "authorization token: not JSON and not base64url — expected the token the ceremony returned",
      );
    }
    json = Buffer.from(text, "base64url").toString("utf8");
  }

  let obj;
  try {
    obj = JSON.parse(json);
  } catch {
    throw new TypeError("authorization token: not valid JSON once decoded");
  }
  if (obj === null || typeof obj !== "object" || Array.isArray(obj)) {
    throw new TypeError("authorization token: must decode to an object");
  }

  const errs = [];
  if (typeof obj.authorizationId !== "string" || !RE_AUTHORIZATION_ID.test(obj.authorizationId)) {
    errs.push("authorizationId: missing, or not an id the keeper could have issued");
  }
  // `nonce` and `issuedAt` are only shape-checked here; claim-digest.mjs is the
  // authority on both and will refuse the request outright if they are wrong.
  // Checking them here too means the failure names the TOKEN rather than
  // surfacing later as a mysterious "invalid claim request".
  if (typeof obj.nonce !== "string") errs.push("nonce: missing, or not a string");
  if (typeof obj.issuedAt !== "string") errs.push("issuedAt: missing, or not a string");

  const unknown = Object.keys(obj).filter((k) => !TOKEN_FIELDS.includes(k));
  if (unknown.length > 0) {
    // Same rule as the request format: an ignored field is a field one side
    // signed and the other dropped, invisibly.
    errs.push(`unknown field(s): ${unknown.sort().join(", ")}`);
  }
  if (errs.length > 0) {
    throw new TypeError(`authorization token: ${errs.join("; ")}`);
  }
  return { authorizationId: obj.authorizationId, nonce: obj.nonce, issuedAt: obj.issuedAt };
}

/**
 * Build the claim request THIS door is about to act on.
 *
 * The three capability-naming fields come from the door; the two anti-replay
 * fields come from the token. See the module header for why that split is the
 * whole security argument.
 */
export function claimRequestFrom({ repo, issue, claimant }, { nonce, issuedAt }) {
  return {
    v: CLAIM_REQUEST_V1,
    repo,
    issue,
    claimant,
    policy: CLAIM_POLICY_V1,
    nonce,
    issuedAt,
  };
}

/**
 * The record the door writes when NO token was supplied — today's ordinary
 * claim, stated honestly.
 *
 * `human-associated` is the ceiling here and the door's own source already says
 * why: `github.actor is owner-grade identity and cannot name a guest`
 * (`.github-private`#537, #558). Naming the dispatcher is association. This
 * function exists so that fact is produced by the same ladder that grades a
 * real authorization, rather than by a hardcoded string that could drift from it.
 */
export function recordAbsent(dispatcher) {
  return { dispatcher };
}

/** The keeper returns the digest as base64url of its 32 bytes; the ladder compares hex. */
export function b64urlDigestToHex(b64) {
  if (typeof b64 !== "string") return "";
  const bytes = Buffer.from(b64, "base64url");
  if (bytes.length !== 32) return "";
  return bytes.toString("hex");
}

/**
 * Turn a redemption into the record `authorizationRung()` grades.
 *
 * Three fields deserve a note, because each is a place where a record could
 * quietly claim more than the ceremony proved:
 *
 * - `challenge` is the digest THE KEEPER holds — what the human's authenticator
 *   actually signed over — not the one recomputed here. Populating it from our
 *   own digest would make the ladder's binding check compare a value to itself.
 * - `assertionVerified` is true because the keeper does not mint an
 *   authorization at all unless `verifyAssertion` succeeded; a redemption IS
 *   that verification, at one remove.
 * - `userVerification` is `"required"` because that is what the RP's own
 *   approval page asks for, fixed in its source rather than negotiable per
 *   ceremony. The door cannot observe the request the RP made, so this is the
 *   one field taken on the RP's word — and it is paired with `uvPerformed`,
 *   which is what the authenticator REPORTED doing, precisely because asking is
 *   not evidence (control 5). If the RP ever makes user verification optional,
 *   this line becomes a lie and must change with it.
 */
export function recordFromRedemption(redeemed, { relyingParty }) {
  return {
    assertionVerified: true,
    relyingParty,
    challenge: b64urlDigestToHex(redeemed.digest),
    userVerification: "required",
    uvPerformed: redeemed.uvPerformed === true,
    backupEligible: redeemed.backupEligible,
    // Recorded, not judged. A regressed signature counter is a cloned-credential
    // signal the ladder has no opinion about; surfacing it in the claim record
    // is what lets someone else form one.
    signCountRegressed: redeemed.signCountRegressed === true,
  };
}

/** The RP's identity as the record names it: the host the door actually called. */
export function relyingPartyFor(keeperUrl) {
  return new URL(keeperUrl).host;
}

/** The longest a relying-party string may be before it is truncated. */
export const RP_TEXT_MAX = 200;

/**
 * Everything the relying party says, before it is allowed anywhere near an
 * output. Raised by CodeQL on the first push of #642 (alert 11, network data
 * reaching a file write) and it is a real finding, not a false positive.
 *
 * The keeper is ours, but "ours" is not a boundary — the door talks to whatever
 * answers at `KEEPER_URL`, and the text it returns lands in THREE places that
 * each interpret it:
 *
 *   1. `$GITHUB_OUTPUT`, where a newline starts a new key. The heredoc
 *      delimiter is a fresh UUID, so a value cannot close it — but that is
 *      luck standing in for a check, and a reader cannot see it from here.
 *   2. The runner's log, where a line beginning `::` IS A WORKFLOW COMMAND. A
 *      newline followed by `::add-mask::` or `::error::` in an error string is
 *      executed, not printed. This one was live.
 *   3. The claim comment, which is the permanent record — where backticks and
 *      markdown structure would let the RP's text impersonate the door's own.
 *
 * So: no control characters (which covers 1 and 2 at once), no backticks, and a
 * length cap, applied once at the boundary rather than at each of the three
 * sinks. Truncation is marked rather than silent — a message cut short without
 * saying so is a diagnosis that lies about being complete.
 */
export function sanitizeFromRp(text, max = RP_TEXT_MAX) {
  if (typeof text !== "string") return "";
  // eslint-disable-next-line no-control-regex
  const flat = text
    .replace(/[\u0000-\u001F\u007F-\u009F]/g, " ")
    .replace(/`/g, "'")
    .trim();
  return flat.length > max ? `${flat.slice(0, max)}…(truncated)` : flat;
}

/**
 * Redeem a token at the RP and classify what it proved.
 *
 * Returns `{ ok, rung, reasons, aal, person, credentialId, digest, relyingParty }`.
 * `ok` is false only when the caller should fail the run; `reasons` always says
 * why, because a refusal a run cannot explain is indistinguishable from a bug.
 *
 * @param fetchImpl injected so the suite can drive every branch — including the
 *   refusals, which are the only evidence this door refuses at all — without a
 *   network or a live keeper.
 */
export async function verifyClaimAuthorization(
  { token, repo, issue, claimant, keeperUrl, dispatcher },
  { fetchImpl = fetch } = {},
) {
  const relyingParty = relyingPartyFor(keeperUrl);

  let parsed;
  try {
    parsed = parseAuthorizationToken(token);
  } catch (err) {
    return { ok: false, rung: "unauthenticated", reasons: [err.message], aal: "unknown", relyingParty };
  }

  const request = claimRequestFrom({ repo, issue, claimant }, parsed);
  const errs = validateClaimRequest(request);
  if (errs.length > 0) {
    return {
      ok: false,
      rung: "unauthenticated",
      reasons: [`the request this door would act on is invalid: ${errs.join("; ")}`],
      aal: "unknown",
      relyingParty,
    };
  }

  // Recomputed BEFORE the round trip, from bytes the token did not supply.
  const digest = await claimDigest(request);

  let res;
  let body;
  try {
    res = await fetchImpl(`${keeperUrl.replace(/\/$/, "")}/redeem`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ authorizationId: parsed.authorizationId, requestType: CLAIM_REQUEST_V1, request }),
    });
    body = await res.json();
  } catch (err) {
    // The RP being unreachable is NOT "no authorization was supplied". A token
    // was presented and could not be checked, so this is red — the fail-closed
    // posture the door already takes on a missing broker.
    return {
      ok: false,
      rung: "unauthenticated",
      reasons: [`the relying party could not be reached to verify the token: ${sanitizeFromRp(err.message)}`],
      aal: "unknown",
      relyingParty,
    };
  }

  if (!res.ok || !body || typeof body.redeemed !== "object" || body.redeemed === null) {
    const why = body && typeof body.error === "string" ? sanitizeFromRp(body.error) : `HTTP ${res.status}`;
    return {
      ok: false,
      rung: "unauthenticated",
      reasons: [`the relying party refused the redemption: ${why}`],
      aal: "unknown",
      relyingParty,
    };
  }

  const redeemed = body.redeemed;
  const record = recordFromRedemption(redeemed, { relyingParty });
  const { rung, reasons, aal } = authorizationRung(record, { digest, relyingParty });

  const accepted = RUNG_AT_LEAST(rung, MIN_ACCEPTED_RUNG);
  return {
    ok: accepted,
    rung,
    reasons: accepted
      ? reasons
      : [...reasons, belowFloorReason(rung)],
    aal,
    // Sanitized at the boundary, not at the three sinks that render them.
    person: sanitizeFromRp(redeemed.person),
    credentialId: sanitizeFromRp(redeemed.credentialId),
    signCountRegressed: record.signCountRegressed,
    digest,
    relyingParty,
  };
}

/**
 * Ladder comparison by POSITION in the shared `RUNGS` list, never by a copy of
 * the order kept here. A second copy is a second thing to keep in sync, and the
 * drift would present as a threshold that silently moved.
 */
export function RUNG_AT_LEAST(rung, floor) {
  const a = RUNGS.indexOf(rung);
  const b = RUNGS.indexOf(floor);
  return a >= 0 && b >= 0 && a >= b;
}

/**
 * The one sentence explaining a refusal on the floor.
 *
 * Lives here, once, because the supplied-token path and the no-token path must
 * not drift into describing the same rule differently — a caller reading two
 * wordings cannot tell whether they are two rules.
 */
export function belowFloorReason(rung) {
  return (
    `rung ${rung} is below the ${MIN_ACCEPTED_RUNG} this door requires \u2014 a claim ` +
    "needs a passkey assertion the keeper verified as bound to this exact " +
    "request (#264)"
  );
}

/**
 * The block the door appends to the claim comment.
 *
 * It prints the RUNG and the REASONS, never a tick or a boolean. `reasons` is
 * what `authorizationRung()` returns in order to name what held the rung down,
 * and dropping it here would put the door back to asserting a mechanism without
 * saying which one ran (`claim-boundary.md` P4). It is also what keeps the
 * honest default honest: a claim with no token prints `human-associated` and
 * the sentence explaining that naming a dispatcher is association.
 *
 * When a token was verified, the block also carries the claim-request digest —
 * recomputed HERE from the door's own inputs, never taken from the token or
 * the keeper — in both renderings the keeper uses, so the approver can compare
 * this issue-authored record against the keeper's approval page: two surfaces,
 * two authors, one digest (infra#501). Absent a token there is no request to
 * digest, and the line is absent too.
 */
export function renderClaimAuthorization(verdict) {
  const lines = [`**Authorization:** \`${verdict.rung}\` · assurance \`${verdict.aal}\``];
  if (verdict.person) {
    lines.push(`Authorized by \`${verdict.person}\` with credential \`${verdict.credentialId}\` (relying party \`${verdict.relyingParty}\`).`);
  }
  if (verdict.digest) {
    lines.push(
      `Claim-request digest (the passkey's challenge, recomputed by this door): \`${verdict.digest}\` · base64url \`${Buffer.from(verdict.digest, "hex").toString("base64url")}\``,
    );
  }
  if (verdict.signCountRegressed) {
    lines.push("⚠ The authenticator's signature counter REGRESSED — a possible cloned credential. Recorded, not judged.");
  }
  if (verdict.reasons.length > 0) {
    lines.push("", "Why not higher:", ...verdict.reasons.map((r) => `- ${r}`));
  }
  return lines.join("\n");
}

/**
 * Classify a claim with no token.
 *
 * Runs the same ladder as a real authorization rather than hardcoding the
 * string, so the classification cannot drift away from what the ladder would
 * actually say about a record naming only a dispatcher. That classification is
 * unchanged and still honest: `human-associated` is exactly what a record
 * naming a dispatcher and nothing else is worth.
 *
 * What #264 changed is the VERDICT, not the classification. This returned green
 * until then — a claim with no passkey was the ordinary case, and the floor
 * applied only to tokens that were actually supplied. A door that accepts the
 * bottom of its own ladder whenever nothing is presented is not enforcing the
 * ladder; it is enforcing it against the callers who bothered to try.
 *
 * There is deliberately NO exemption here and no break-glass anywhere in this
 * file. An exemption is the path every caller learns to take, and a floor with
 * an exemption is a guideline (`docs/merge-gate.md`). The accepted cost is
 * stated plainly on #264: while the keeper is unreachable, nothing can be
 * claimed through a mechanized door.
 */
export function verifyAbsent(dispatcher) {
  const { rung, reasons, aal } = authorizationRung(recordAbsent(dispatcher), {});
  const accepted = RUNG_AT_LEAST(rung, MIN_ACCEPTED_RUNG);
  return {
    ok: accepted,
    rung,
    reasons: accepted ? reasons : [...reasons, belowFloorReason(rung)],
    aal,
    relyingParty: null,
  };
}

// ── CLI ──────────────────────────────────────────────────────────────────────
//
// Driven by env rather than argv: every value is caller-controlled text, and an
// env var cannot be mistaken for a flag by a shell that word-splits it.

async function main() {
  const {
    HUMAN_AUTHORIZATION = "",
    CLAIM_REPO = "",
    CLAIM_ISSUE = "",
    CLAIMANT = "",
    KEEPER_URL = "",
    DISPATCHER = "",
    GITHUB_OUTPUT = "",
  } = process.env;

  let verdict;
  if (HUMAN_AUTHORIZATION.trim() === "") {
    verdict = verifyAbsent(DISPATCHER);
  } else if (KEEPER_URL.trim() === "") {
    // A token with nowhere to verify it is the fail-closed case, not a reason to
    // fall back to the honest default: falling back would let anyone turn a
    // refused authorization into a green claim by unsetting a variable.
    verdict = {
      ok: false,
      rung: "unauthenticated",
      reasons: ["an authorization was supplied but KEEPER_URL is unset — nothing could verify it"],
      aal: "unknown",
    };
  } else {
    verdict = await verifyClaimAuthorization({
      token: HUMAN_AUTHORIZATION,
      repo: CLAIM_REPO,
      issue: CLAIM_ISSUE,
      claimant: CLAIMANT,
      keeperUrl: KEEPER_URL,
      dispatcher: DISPATCHER,
    });
  }

  const md = renderClaimAuthorization(verdict);
  if (GITHUB_OUTPUT) {
    const { writeFileSync } = await import("node:fs");
    const delim = `EOF_${crypto.randomUUID()}`;
    writeFileSync(
      GITHUB_OUTPUT,
      `rung=${verdict.rung}\nauthorization<<${delim}\n${md}\n${delim}\n`,
      { flag: "a" },
    );
  }
  if (!verdict.ok) {
    console.error(`::error title=claim-ticket: authorization refused::${verdict.reasons.join("; ")}`);
    process.exit(1);
  }
  console.log(md);
}

// Only when run directly, so the suite can import every function above without
// the CLI reading the runner's environment out from under it.
if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  await main();
}
