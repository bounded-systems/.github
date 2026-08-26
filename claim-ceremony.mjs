/**
 * @module
 * Open a claim ceremony at the keeper and wait for the passkey — the half that
 * produces the token `claim-ticket.yml`'s `human_authorization` input consumes.
 * `.github-private`#642.
 *
 * ── Why this ships with the door rather than after it ───────────────────────
 * #642 exists because #225 deliberately did NOT add an input nothing could
 * populate — `claim-boundary.md` P4, a named mechanism that does not resolve.
 * An input that can only be filled by hand-rolling two HTTP calls and a polling
 * loop resolves in the same thin sense: technically reachable, practically
 * decorative, and the first person to try it writes their own version of the
 * digest agreement. So the door's input and the thing that fills it land
 * together, for the same reason the format and its verifier did.
 *
 * ── What this is NOT ────────────────────────────────────────────────────────
 * It is not a credential, and running it proves nothing on its own. It opens a
 * ceremony, prints a URL, and waits; the authorization is created by a human
 * touching a passkey at that URL, on a device this process cannot reach. That
 * asymmetry is the whole design — an approval the requester could produce would
 * be self-attestation (`human-in-loop-authorization.md` control 2).
 *
 * The `nonce` and `issuedAt` are generated HERE and travel in the token, because
 * they are anti-replay values that name no capability. Everything that names a
 * capability — repo, issue, claimant, policy — is in the request the human sees
 * rendered by the keeper, and is recomputed by the door from its own inputs.
 */

import { CLAIM_REQUEST_V1 } from "./claim-digest.mjs";
import { CLAIM_POLICY_V1 } from "./claim-authorization.mjs";

/** The keeper's ceremony window; polling past it can only report a failure. */
export const CEREMONY_WINDOW_MS = 15 * 60 * 1000;
export const POLL_INTERVAL_MS = 5000;

/** 256 bits, base64url, unpadded — the 43 characters `claim-digest.mjs` requires. */
export function freshNonce() {
  return Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url");
}

/** RFC3339 UTC, second precision. No offsets — an offset is a second spelling of one instant. */
export function stampNow(now = Date.now()) {
  return new Date(now).toISOString().replace(/\.\d{3}Z$/, "Z");
}

export function buildRequest({ repo, issue, claimant }, { nonce, issuedAt }) {
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

/** The token the door takes: base64url of the compact JSON, one pasteable string. */
export function encodeToken({ authorizationId, nonce, issuedAt }) {
  return Buffer.from(JSON.stringify({ authorizationId, nonce, issuedAt }), "utf8").toString("base64url");
}

/**
 * Open the ceremony, wait for the human, and return the token.
 *
 * Fails closed in every direction, and the three failures are kept DISTINCT on
 * purpose — the keeper draws the same distinction for the same reason. "The
 * ceremony expired" means nobody approved; "gone" means there is nothing left to
 * wait for; a transport error means we never found out. Collapsing them into one
 * "failed" is what turns a timeout into a shrug.
 *
 * @param onOpen called once with the approval URL, so a caller can print it,
 *   post it, or read it aloud. Injected rather than hardcoded to `console.log`
 *   because in CI this line is the entire user interface.
 */
export async function runCeremony(
  { repo, issue, claimant, keeperUrl },
  { fetchImpl = fetch, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), now = () => Date.now(), onOpen = () => {} } = {},
) {
  const base = keeperUrl.replace(/\/$/, "");
  const nonce = freshNonce();
  const issuedAt = stampNow(now());
  const request = buildRequest({ repo, issue, claimant }, { nonce, issuedAt });

  const startRes = await fetchImpl(`${base}/authorize/start`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ requestType: CLAIM_REQUEST_V1, request }),
  });
  const start = await startRes.json();
  if (!startRes.ok || !start?.ceremonyId) {
    throw new Error(`the keeper refused to open a ceremony: ${start?.error ?? `HTTP ${startRes.status}`}`);
  }
  // `approveUrl` is what the keeper hands back; deriving it here as a fallback
  // keeps a keeper that stops sending it from making the ceremony unusable,
  // rather than silently unapprovable.
  const approveUrl = start.approveUrl ?? `${base}/a/${start.ceremonyId}`;
  onOpen(approveUrl, start.display);

  const deadline = now() + CEREMONY_WINDOW_MS;
  for (;;) {
    const res = await fetchImpl(`${base}/result?id=${encodeURIComponent(start.ceremonyId)}`);
    if (res.status === 410) {
      const body = await res.json().catch(() => ({}));
      throw new Error(`the ceremony ended without an authorization: ${body.error ?? "gone"}. Nobody approved this claim.`);
    }
    if (res.ok) {
      const body = await res.json();
      if (body.authorizationId) {
        return { token: encodeToken({ authorizationId: body.authorizationId, nonce, issuedAt }), request };
      }
    }
    if (now() >= deadline) {
      throw new Error("no passkey approval within the ceremony window — the claim was not authorized.");
    }
    await sleep(POLL_INTERVAL_MS);
  }
}

// ── CLI ──────────────────────────────────────────────────────────────────────

async function main() {
  const { CLAIM_REPO = "", CLAIM_ISSUE = "", CLAIMANT = "", KEEPER_URL = "" } = process.env;
  if (!KEEPER_URL) {
    console.error("KEEPER_URL is unset — there is no relying party to open a ceremony at.");
    process.exit(1);
  }
  const { token } = await runCeremony(
    { repo: CLAIM_REPO, issue: CLAIM_ISSUE, claimant: CLAIMANT, keeperUrl: KEEPER_URL },
    {
      onOpen: (url, display) => {
        console.error(`Approve with your passkey (15 minutes): ${url}`);
        console.error(`The keeper will show you: ${JSON.stringify(display)}`);
      },
    },
  );
  // stdout is the token alone, so this composes into a dispatch without a
  // human copying it out of prose.
  console.log(token);
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  await main();
}
