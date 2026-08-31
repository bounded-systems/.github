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

/**
 * FALLBACK CAP, not the ceremony's own window. The keeper sets the real window
 * per request type (infra#487) and names it in the `authorize/start` response
 * (`expiresAt`/`ttlSeconds`); when it does, polling stops there. This value
 * bounds polling only against a keeper that names no expiry — and even then it
 * is how long WE wait, never a promise about how long the ceremony lives:
 * #256 is three ceremonies dead at the keeper's 2 minutes while this file
 * printed 15.
 */
export const CEREMONY_WINDOW_MS = 15 * 60 * 1000;
/** Slack past the keeper's stated expiry, so a poll at the boundary still collects. */
export const EXPIRY_GRACE_MS = 10 * 1000;
export const POLL_INTERVAL_MS = 5000;

/**
 * The window the keeper's start response actually names, in ms — or null when
 * it names none (an older keeper). `ttlSeconds` outranks `expiresAt` because a
 * duration cannot be skewed by either side's clock. Defensive on both fields:
 * a malformed or already-elapsed value must read as "absent", never become a
 * NaN deadline. Capped at CEREMONY_WINDOW_MS — past that, polling can only
 * report a failure slowly.
 */
export function ceremonyWindowMs(start, nowMs) {
  const ttl = Number(start?.ttlSeconds);
  if (Number.isFinite(ttl) && ttl > 0) return Math.min(ttl * 1000, CEREMONY_WINDOW_MS);
  const at = typeof start?.expiresAt === "string" ? Date.parse(start.expiresAt) : NaN;
  if (Number.isFinite(at) && at > nowMs) return Math.min(at - nowMs, CEREMONY_WINDOW_MS);
  return null;
}

/**
 * The sentence printed beside the approval URL. With a keeper-named window it
 * states that window; without one it must not invent a number — the keeper
 * sets the TTL per request type, and a claim's may be as short as 2 minutes
 * (#256).
 */
export function approvalPrompt(windowMs) {
  if (windowMs == null) {
    return "Approve with your passkey — the keeper sets the window per request type, and it may be as short as 2 minutes:";
  }
  const minutes = windowMs / 60_000;
  const n = Number.isInteger(minutes) ? minutes : Math.round(minutes * 10) / 10;
  return `Approve with your passkey (${n} minute${n === 1 ? "" : "s"}):`;
}

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
 * @param onOpen called once with the approval URL, the keeper's display object,
 *   and the window in ms the keeper's response named (null when it named none),
 *   so a caller can print it, post it, or read it aloud. Injected rather than
 *   hardcoded to `console.log` because in CI this line is the entire user
 *   interface.
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
  const windowMs = ceremonyWindowMs(start, now());
  onOpen(approveUrl, start.display, windowMs);

  // The keeper's own expiry (plus grace for a boundary poll) when it named
  // one; the fallback cap only when it did not. Polling past the keeper's
  // window can only report a failure — see CEREMONY_WINDOW_MS.
  const deadline = now() + (windowMs == null ? CEREMONY_WINDOW_MS : windowMs + EXPIRY_GRACE_MS);
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

/**
 * The lane that turns an open ceremony into a notification on a phone (#305).
 *
 * A session cannot POST desk's `/approval` itself: that endpoint is authorized
 * by an Actions OIDC token pinned to NOTIFY_WORKFLOW_REFS, and a session is not
 * a workflow. So it asks a workflow to do it. The workflow is pinned there; this
 * process is not, and never becomes so.
 *
 * The notice is not the decision and cannot become one — desk refuses any URL
 * whose host is not the keeper, so the only thing a caller can do is point a
 * human at the page where the Face ID happens.
 */
export const ANNOUNCE_REPO = "bounded-systems/.github";
export const ANNOUNCE_WORKFLOW = "announce-ceremony.yml";

/**
 * BEST EFFORT, ALWAYS. It returns a reason and never throws, because the
 * ceremony is the gate and this is a convenience: a session with no GitHub
 * token, or an API that refuses, must still print the URL exactly as before.
 * Reporting "not announced" is the honest outcome; failing the claim over an
 * undelivered notification would make the convenience load-bearing.
 */
export async function announceCeremony(
  { repo, issue, claimant, approveUrl },
  { fetchImpl = fetch, env = process.env } = {},
) {
  const token = env.GH_TOKEN || env.GITHUB_TOKEN || "";
  if (!token) return { announced: false, reason: "no GitHub token in this session" };
  try {
    const res = await fetchImpl(
      `https://api.github.com/repos/${ANNOUNCE_REPO}/actions/workflows/${ANNOUNCE_WORKFLOW}/dispatches`,
      {
        method: "POST",
        headers: {
          accept: "application/vnd.github+json",
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
          "user-agent": "claim-ceremony",
        },
        // The text names the repo and issue. "An approval is waiting" is
        // unactionable on a phone — the reader cannot tell a claim from a
        // deploy, and the only way to find out is to open the thing the notice
        // exists to save them opening.
        body: JSON.stringify({
          ref: "main",
          inputs: {
            title: `Approve a claim on ${repo}#${issue}`,
            body: `${claimant} wants to claim ${repo}#${issue}. Approving opens the claim window; the Face ID at the keeper is the approval.`,
            url: approveUrl,
          },
        }),
      },
    );
    if (res.status === 204) return { announced: true };
    return { announced: false, reason: `dispatch answered HTTP ${res.status}` };
  } catch (e) {
    return { announced: false, reason: e.message };
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
      onOpen: (url, display, windowMs) => {
        console.error(`${approvalPrompt(windowMs)} ${url}`);
        console.error(`The keeper will show you: ${JSON.stringify(display)}`);
        // Fire and forget, and say which happened. The URL above is printed
        // FIRST and unconditionally: it is the interface that has always
        // worked, and it stays the one that does not depend on a runner.
        announceCeremony({ repo: CLAIM_REPO, issue: CLAIM_ISSUE, claimant: CLAIMANT, approveUrl: url })
          .then((r) => console.error(r.announced
            ? "Announced to subscribed devices."
            : `Not announced (${r.reason}) — approve at the URL above.`));
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
