/**
 * @module
 * The suite for the claim door's verification leg (`.github-private`#642).
 *
 * Every refusal below is the only evidence the door refuses at all. A gate's own
 * claim about itself is not evidence (`agentic-code-hygiene.md` rule 3), so the
 * negative tests are named and specific rather than folded into one "rejects bad
 * input" case: each one breaks exactly one property and asserts the run goes red
 * FOR THAT REASON, because a refusal that fires for the wrong reason passes a
 * loose test and fails the human reading the log.
 *
 * The relying party is injected as `fetchImpl`. No test here touches a network,
 * and none of them needs a keeper to exist — which is what lets the refusals be
 * exercised at all, since a live keeper cannot be asked to misbehave on demand.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { claimDigest, RUNGS } from "./claim-digest.mjs";
import {
  CLAIM_POLICY_V1,
  MIN_ACCEPTED_RUNG,
  RUNG_AT_LEAST,
  b64urlDigestToHex,
  claimRequestFrom,
  parseAuthorizationToken,
  recordAbsent,
  sanitizeFromRp,
  RP_TEXT_MAX,
  renderClaimAuthorization,
  verifyAbsent,
  verifyClaimAuthorization,
} from "./claim-authorization.mjs";

const ROOT = dirname(fileURLToPath(import.meta.url));

const KEEPER = "https://keeper.bounded.tools";
const RP = "keeper.bounded.tools";
const DOOR = { repo: "infra", issue: "478", claimant: "claude-session/some-branch", keeperUrl: KEEPER };
const TOKEN_FIELDS_OK = {
  authorizationId: "auth_01HZZ",
  nonce: "n".repeat(43),
  issuedAt: "2026-08-26T13:00:00Z",
};

const b64url = (s) => Buffer.from(s, "utf8").toString("base64url");
const hexToB64url = (hex) => Buffer.from(hex, "hex").toString("base64url");

/** A keeper that redeems successfully, with fields the caller can override. */
function keeperReturning(redeemed, { status = 200 } = {}) {
  return async () => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => (status >= 200 && status < 300 ? { redeemed } : redeemed),
  });
}

/** The redemption a real ceremony over `request` would produce. */
async function goodRedemption(request, over = {}) {
  return {
    person: "person:bdelanghe",
    credentialId: "cred_abc",
    digest: hexToB64url(await claimDigest(request)),
    requestType: request.v,
    request,
    uvPerformed: true,
    backupEligible: true,
    backupState: true,
    signCountRegressed: false,
    ...over,
  };
}

// ── the token ────────────────────────────────────────────────────────────────

test("a token parses from base64url and from bare JSON, identically", () => {
  const json = JSON.stringify(TOKEN_FIELDS_OK);
  assert.deepEqual(parseAuthorizationToken(json), TOKEN_FIELDS_OK);
  assert.deepEqual(parseAuthorizationToken(b64url(json)), TOKEN_FIELDS_OK);
  assert.deepEqual(parseAuthorizationToken(`  ${b64url(json)}  `), TOKEN_FIELDS_OK);
});

test("a token carrying an unknown field is REFUSED, not quietly trimmed", () => {
  // This is the test that stops the security argument from being undone by a
  // convenience: if a token could carry `repo`, a caller could name the thing
  // being authorized, which is exactly what the door reserves to itself.
  const json = JSON.stringify({ ...TOKEN_FIELDS_OK, repo: "someone-elses-repo" });
  assert.throws(() => parseAuthorizationToken(json), /unknown field\(s\): repo/);
});

test("a token with a digest field is refused for the same reason", () => {
  const json = JSON.stringify({ ...TOKEN_FIELDS_OK, digest: "f".repeat(64) });
  assert.throws(() => parseAuthorizationToken(json), /unknown field\(s\): digest/);
});

test("a malformed authorizationId is refused", () => {
  const json = JSON.stringify({ ...TOKEN_FIELDS_OK, authorizationId: "../../etc/passwd" });
  assert.throws(() => parseAuthorizationToken(json), /authorizationId/);
});

test("garbage that is neither JSON nor base64url is refused by name", () => {
  assert.throws(() => parseAuthorizationToken("not a token!"), /not JSON and not base64url/);
  assert.throws(() => parseAuthorizationToken(b64url("[1,2,3]")), /must decode to an object/);
});

// ── what gets authorized comes from the door ─────────────────────────────────

test("the request names the DOOR's repo, issue and claimant, and the door's policy", () => {
  const req = claimRequestFrom(DOOR, TOKEN_FIELDS_OK);
  assert.equal(req.repo, "infra");
  assert.equal(req.issue, "478");
  assert.equal(req.claimant, "claude-session/some-branch");
  assert.equal(req.policy, CLAIM_POLICY_V1);
  // and only the anti-replay values came from the token
  assert.equal(req.nonce, TOKEN_FIELDS_OK.nonce);
  assert.equal(req.issuedAt, TOKEN_FIELDS_OK.issuedAt);
});

test("the door's policy version is a constant the caller cannot reach", () => {
  // Not a style point: `policy` is inside the digest, so a caller who could set
  // it could choose which policy the human's signature is read against.
  const req = claimRequestFrom(DOOR, { ...TOKEN_FIELDS_OK, policy: "attacker-chosen" });
  assert.equal(req.policy, CLAIM_POLICY_V1);
});

// ── the happy path ───────────────────────────────────────────────────────────

test("a valid authorization is accepted, names the credential, and stops at human-attended", async () => {
  const request = claimRequestFrom(DOOR, TOKEN_FIELDS_OK);
  const verdict = await verifyClaimAuthorization(
    { token: JSON.stringify(TOKEN_FIELDS_OK), ...DOOR },
    { fetchImpl: keeperReturning(await goodRedemption(request)) },
  );
  assert.equal(verdict.ok, true);
  // human-attended, not human-authorized: the keeper's ceremony carries no
  // operation-specific attention check, and the ladder caps the claim there.
  assert.equal(verdict.rung, "human-attended");
  assert.equal(verdict.person, "person:bdelanghe");
  assert.equal(verdict.credentialId, "cred_abc");
  assert.equal(verdict.relyingParty, RP);
  // A synced passkey is exportable, so aal2 — recorded, never rounded up.
  assert.equal(verdict.aal, "aal2");
  assert.match(verdict.reasons.join(" "), /attention check/);
});

test("a device-bound credential reports aal3-eligible, never aal3", async () => {
  const request = claimRequestFrom(DOOR, TOKEN_FIELDS_OK);
  const verdict = await verifyClaimAuthorization(
    { token: JSON.stringify(TOKEN_FIELDS_OK), ...DOOR },
    { fetchImpl: keeperReturning(await goodRedemption(request, { backupEligible: false })) },
  );
  assert.equal(verdict.aal, "aal3-eligible");
});

// ── the refusals ─────────────────────────────────────────────────────────────

test("an authorization bound to a DIFFERENT claim is refused, and the run says why", async () => {
  // #642's second done-when, verbatim. The keeper refuses first — this is the
  // door reporting that refusal rather than swallowing it.
  const verdict = await verifyClaimAuthorization(
    { token: JSON.stringify(TOKEN_FIELDS_OK), ...DOOR },
    {
      fetchImpl: keeperReturning(
        { error: "authorization is bound to a different request" },
        { status: 403 },
      ),
    },
  );
  assert.equal(verdict.ok, false);
  assert.match(verdict.reasons.join(" "), /bound to a different request/);
});

test("a redemption whose challenge is not this request's digest is refused by the LADDER", async () => {
  // Defence in depth, and the reason the door recomputes instead of trusting the
  // RP's yes: if the keeper ever redeemed something whose challenge did not
  // match, the binding check here still catches it, and the rung says so.
  const request = claimRequestFrom(DOOR, TOKEN_FIELDS_OK);
  const wrong = await goodRedemption(request, { digest: hexToB64url("a".repeat(64)) });
  const verdict = await verifyClaimAuthorization(
    { token: JSON.stringify(TOKEN_FIELDS_OK), ...DOOR },
    { fetchImpl: keeperReturning(wrong) },
  );
  assert.equal(verdict.ok, false);
  assert.equal(verdict.rung, "human-authenticated");
  assert.match(verdict.reasons.join(" "), /not this request's recomputed digest/);
});

test("an assertion the authenticator did not user-verify is refused", async () => {
  const request = claimRequestFrom(DOOR, TOKEN_FIELDS_OK);
  const verdict = await verifyClaimAuthorization(
    { token: JSON.stringify(TOKEN_FIELDS_OK), ...DOOR },
    { fetchImpl: keeperReturning(await goodRedemption(request, { uvPerformed: false })) },
  );
  assert.equal(verdict.ok, false);
  assert.match(verdict.reasons.join(" "), /uvPerformed/);
});

test("an unreachable relying party is RED, not a silent fall back to the honest default", async () => {
  // The fail-closed line that matters most: if this returned the no-token
  // verdict, anyone could turn a refused authorization green by breaking the
  // network to the keeper.
  const verdict = await verifyClaimAuthorization(
    { token: JSON.stringify(TOKEN_FIELDS_OK), ...DOOR },
    {
      fetchImpl: async () => {
        throw new Error("getaddrinfo ENOTFOUND");
      },
    },
  );
  assert.equal(verdict.ok, false);
  assert.match(verdict.reasons.join(" "), /could not be reached/);
});

test("a malformed token fails the run rather than being ignored", async () => {
  const verdict = await verifyClaimAuthorization(
    { token: "not a token!", ...DOOR },
    {
      fetchImpl: async () => {
        throw new Error("the keeper must never be called for a token that did not parse");
      },
    },
  );
  assert.equal(verdict.ok, false);
  assert.equal(verdict.rung, "unauthenticated");
});

test("a repo name the door's own preflight would refuse never reaches the keeper", async () => {
  const verdict = await verifyClaimAuthorization(
    { token: JSON.stringify(TOKEN_FIELDS_OK), ...DOOR, repo: "owner/repo" },
    {
      fetchImpl: async () => {
        throw new Error("the keeper must never be called with an invalid request");
      },
    },
  );
  assert.equal(verdict.ok, false);
  assert.match(verdict.reasons.join(" "), /invalid/);
});

// ── the honest default ───────────────────────────────────────────────────────

test("no token records human-associated and stays green", () => {
  const verdict = verifyAbsent("bdelanghe");
  assert.equal(verdict.ok, true);
  assert.equal(verdict.rung, "human-associated");
  assert.match(verdict.reasons.join(" "), /association, not authorization/);
});

test("the honest default is produced by the ladder, not hardcoded", () => {
  // If someone replaces the ladder call with a string literal, this goes red:
  // the record shape and the rung have to agree.
  assert.deepEqual(recordAbsent("bdelanghe"), { dispatcher: "bdelanghe" });
  assert.ok(RUNGS.includes(verifyAbsent("bdelanghe").rung));
});

// ── the rendered record ──────────────────────────────────────────────────────

test("the claim comment carries the rung and the reasons, never a bare tick", () => {
  const md = renderClaimAuthorization(verifyAbsent("bdelanghe"));
  assert.match(md, /\*\*Authorization:\*\* `human-associated`/);
  assert.match(md, /Why not higher:/);
  assert.doesNotMatch(md, /^✅/m);
});

test("a regressed signature counter is surfaced, not judged away", async () => {
  const request = claimRequestFrom(DOOR, TOKEN_FIELDS_OK);
  const verdict = await verifyClaimAuthorization(
    { token: JSON.stringify(TOKEN_FIELDS_OK), ...DOOR },
    { fetchImpl: keeperReturning(await goodRedemption(request, { signCountRegressed: true })) },
  );
  assert.equal(verdict.ok, true); // the ladder has no opinion about it
  assert.match(renderClaimAuthorization(verdict), /counter REGRESSED/);
});

// ── the ladder threshold ─────────────────────────────────────────────────────

test("the accepted rung is compared by position in the shared RUNGS list", () => {
  assert.ok(RUNGS.includes(MIN_ACCEPTED_RUNG));
  assert.ok(RUNG_AT_LEAST("human-authorized", MIN_ACCEPTED_RUNG));
  assert.ok(RUNG_AT_LEAST(MIN_ACCEPTED_RUNG, MIN_ACCEPTED_RUNG));
  assert.ok(!RUNG_AT_LEAST("human-authenticated", MIN_ACCEPTED_RUNG));
  assert.ok(!RUNG_AT_LEAST("human-associated", MIN_ACCEPTED_RUNG));
  assert.ok(!RUNG_AT_LEAST("nonsense", MIN_ACCEPTED_RUNG));
});

test("a digest that is not 32 bytes converts to nothing rather than to a short hex string", () => {
  assert.equal(b64urlDigestToHex(Buffer.from("short").toString("base64url")), "");
  assert.equal(b64urlDigestToHex(undefined), "");
  assert.equal(b64urlDigestToHex(hexToB64url("ab".repeat(32))).length, 64);
});

// ── the cross-file ratchets ──────────────────────────────────────────────────

test("org-defaults.yml actually runs this suite", () => {
  // The repo enumerates its test files one `run:` step at a time, and that has
  // already shipped a suite that never executed in CI. A suite nobody runs is
  // the author's assertion about their own work, so the suite asserts its own
  // wiring.
  const wf = readFileSync(join(ROOT, ".github/workflows/org-defaults.yml"), "utf8");
  assert.match(wf, /node --test claim-authorization\.test\.mjs/);
});

test("claim-ticket.yml carries a real keeper URL, not an empty variable", () => {
  // #253. This was `vars.KEEPER_URL` when the leg landed, and the variable did not
  // exist — so every supplied token failed on "KEEPER_URL is unset" and the input
  // was decorative. The literal cannot be un-set by a settings page; this asserts
  // it cannot quietly become empty again either.
  const wf = readFileSync(join(ROOT, ".github/workflows/claim-ticket.yml"), "utf8");
  const m = wf.match(/^\s*KEEPER_URL:\s*(.+)$/m);
  assert.ok(m, "claim-ticket.yml no longer sets KEEPER_URL for the authorization step");
  assert.match(m[1].trim(), /^"https:\/\/\S+"$/, `KEEPER_URL is ${m[1].trim()}, not an https literal`);
});

test("claim-ticket.yml passes the door's own inputs to this module, not the token's", () => {
  // The security argument lives half in this file and half in the workflow. If
  // the door ever started sourcing CLAIM_REPO from anywhere but its own input,
  // every test above would still pass and the property would be gone.
  const wf = readFileSync(join(ROOT, ".github/workflows/claim-ticket.yml"), "utf8");
  assert.match(wf, /CLAIM_REPO:\s*\$\{\{\s*inputs\.repo\s*\}\}/);
  assert.match(wf, /CLAIM_ISSUE:\s*\$\{\{\s*inputs\.issue\s*\}\}/);
  assert.match(wf, /CLAIMANT:\s*\$\{\{\s*inputs\.claimant\s*\}\}/);
});

// ── what the relying party says is not trusted to be text ────────────────────

test("control characters from the relying party never survive to an output", async () => {
  // CodeQL alert 11 on the first push of #642, and it was a real finding. The
  // RP's text reaches three sinks that each interpret it: $GITHUB_OUTPUT (a
  // newline starts a new key), the runner log (a line beginning `::` IS a
  // workflow command), and the permanent claim comment.
  const evil = "ok\n::add-mask::hunter2\n::error::owned";
  const verdict = await verifyClaimAuthorization(
    { token: JSON.stringify(TOKEN_FIELDS_OK), ...DOOR },
    { fetchImpl: keeperReturning({ error: evil }, { status: 403 }) },
  );
  assert.equal(verdict.ok, false);
  const rendered = renderClaimAuthorization(verdict);
  assert.doesNotMatch(rendered, /\n::/);
  assert.match(rendered, /add-mask/); // flattened, not dropped — the diagnosis survives
});

test("a person or credential the RP names cannot break out of its markdown span", async () => {
  const request = claimRequestFrom(DOOR, TOKEN_FIELDS_OK);
  const verdict = await verifyClaimAuthorization(
    { token: JSON.stringify(TOKEN_FIELDS_OK), ...DOOR },
    {
      fetchImpl: keeperReturning(
        await goodRedemption(request, { person: "a`x`b", credentialId: "c\nd" }),
      ),
    },
  );
  assert.equal(verdict.person, "a'x'b");
  assert.equal(verdict.credentialId, "c d");
});

test("an overlong relying-party string is truncated, and says so", () => {
  const out = sanitizeFromRp("z".repeat(RP_TEXT_MAX + 50));
  assert.equal(out.length, RP_TEXT_MAX + "…(truncated)".length);
  assert.match(out, /…\(truncated\)$/);
});

test("sanitizeFromRp refuses to invent text for a non-string", () => {
  assert.equal(sanitizeFromRp(undefined), "");
  assert.equal(sanitizeFromRp({ toString: () => "::error::" }), "");
});
