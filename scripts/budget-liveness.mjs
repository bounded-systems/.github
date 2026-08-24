// Is the org's PRIVATE Actions estate still running? Asked from the PUBLIC repo.
//
// ── Why this lives here, in `.github`, and not in `.github-private` ──────────
// On 2026-08-24T07:34Z the org's Actions budget exhausted for the third time
// (#462, #553, then this one). Every workflow in every private repo stopped:
// runs were still created, then died in ~4s with `runner_id: 0`, no runner
// name, an empty `steps` array, and logs that 404 forever. Nothing reported it.
// It was found 4+ hours later by a session that ran `front-desk.sh` to pick up
// work and got the staleness banner.
//
// #553's acceptance 3 asks for a detector "somewhere GitHub Actions billing
// cannot disable" and names two candidate homes: a Cloudflare Worker, or
// session bootstrap. There is a third, and it was MEASURED during this outage
// rather than reasoned about: THIS REPO IS PUBLIC, and public-repo Actions
// minutes draw the free allowance, which the org budget does not reach. The
// proof is a matched pair three minutes apart —
//
//   .github-private  codeowners-check  2026-08-24T10:07:43Z  failure, 4s, no runner
//   .github          codeowners-check  2026-08-24T10:10:48Z  success
//
// — the same workflow name, opposite outcomes, separated only by repo
// visibility. So a lane here keeps running during precisely the outage that
// stops every lane there. That is the property #462 argues for, obtained
// without new infrastructure.
//
// ── What it actually measures, and what that does NOT prove ─────────────────
// The signal is the age of `generated_at` in `front-desk.json` on the
// `front-desk-projection` branch of `.github-private`. That lane publishes
// hourly, so a stamp older than a few hours means it stopped publishing.
//
// A stopped projection lane is NOT the same proposition as "the Actions budget
// is exhausted", and this file is careful never to conflate them. Budget
// exhaustion is the likeliest cause and the only one with a known recurrence,
// but a broken projection lane, a broker outage or a GitHub incident produce
// the same stale stamp. So the alarm names the observation first and the
// inference second, and sends the reader to the billing page to CONFIRM rather
// than asserting what it cannot see. `docs/agentic-code-hygiene.md` rule 3, and
// the reason #680 gives for refusing a failure that misdirects: a detector that
// says "you are out of budget" when the projection lane merely broke sends the
// next person to the wrong page.
//
// Splitting `assess` from the fetch is the service-status/front-desk split —
// the decision is pure and directly testable at every boundary, and the network
// half stays thin enough to read.

// The projection lane's cron is hourly, and GitHub drops scheduled fires often
// enough that "one missed hour" is normal rather than alarming — front-desk.sh
// sets FRONT_DESK_MAX_AGE=7200 (2h) for exactly that reason, deliberately ~2x
// the cron. This threshold is the READER's, not the board's, and it is set
// wider still: this one wakes a human, and a false alarm here costs more than
// an hour of detection latency. 3h ⇒ two consecutive missed publishes before
// anyone is told, against a 4h+ silence in the outage that motivated it.
export const DEFAULT_MAX_AGE_HOURS = 3;

export const VERDICT = {
  fresh: "fresh",
  stale: "stale",
  unreadable: "unreadable",
};

/**
 * The whole decision, as a pure function of the stamp and the clock.
 *
 * `unreadable` is deliberately a THIRD verdict rather than being folded into
 * `stale`. They call for opposite actions — `stale` sends you to the billing
 * page, `unreadable` means this probe learned nothing and its own plumbing is
 * what needs looking at — and collapsing them would make the alarm lie in the
 * one case where it is least able to tell.
 */
export function assess({ stamp, now, maxAgeHours = DEFAULT_MAX_AGE_HOURS }) {
  const at = Date.parse(stamp ?? "");
  if (!Number.isFinite(at)) {
    return {
      verdict: VERDICT.unreadable,
      ageHours: null,
      detail: `generated_at is not a parseable timestamp (got ${JSON.stringify(stamp)})`,
    };
  }

  const ageHours = (now - at) / 3_600_000;

  // A stamp from the future is a broken clock or a corrupt snapshot, not
  // health. Reporting it as `fresh` would be the false green this lane exists
  // to prevent, so it is unreadable — the verdict that says "look at the
  // plumbing" rather than "go check billing". Tolerance covers ordinary skew
  // between the publisher's clock and this runner's.
  if (ageHours < -0.25) {
    return {
      verdict: VERDICT.unreadable,
      ageHours,
      detail:
        `generated_at is ${Math.abs(ageHours).toFixed(1)}h in the FUTURE (${stamp}). ` +
        `Either the publishing runner's clock or this snapshot is wrong; ` +
        `age cannot be used to judge liveness until that is resolved.`,
    };
  }

  return {
    verdict: ageHours > maxAgeHours ? VERDICT.stale : VERDICT.fresh,
    ageHours,
    detail: `generated_at ${stamp} is ${ageHours.toFixed(1)}h old (threshold ${maxAgeHours}h)`,
  };
}

/** Whole hours and minutes, because "4.7h" reads worse than "4h 42m" at 3am. */
export function humanAge(ageHours) {
  const total = Math.max(0, Math.round(ageHours * 60));
  return `${Math.floor(total / 60)}h ${total % 60}m`;
}

/**
 * The operator-facing text. Kept here, beside `assess`, and tested — the
 * message IS the deliverable of an alarm lane, and a message that names the
 * wrong cause is the failure mode this whole file is written against.
 */
export function report({ verdict, ageHours, detail }, { maxAgeHours = DEFAULT_MAX_AGE_HOURS } = {}) {
  if (verdict === VERDICT.fresh) {
    return {
      ok: true,
      title: null,
      body: `Front Desk projection is ${humanAge(ageHours)} old — under the ${maxAgeHours}h threshold. The private estate is publishing.`,
    };
  }

  if (verdict === VERDICT.unreadable) {
    return {
      ok: false,
      title: "Actions liveness probe could NOT determine the estate's state",
      body:
        `${detail}. THIS RUN PROVES NOTHING about whether the org's private ` +
        `Actions are running — do not read it as either an outage or an all-clear. ` +
        `What needs looking at is this probe's own plumbing: the door it mints, ` +
        `the branch it reads, or the shape of the snapshot on it.`,
    };
  }

  return {
    ok: false,
    title: "Front Desk projection has stopped publishing — check the Actions budget FIRST",
    body:
      `${detail}. The lane publishes hourly, so this means it has missed at least ` +
      `two consecutive publishes.\n\n` +
      `MOST LIKELY CAUSE: the org's Actions budget has exhausted with ` +
      `"Stop usage: Yes", which stops every workflow in every PRIVATE repo. It has ` +
      `happened three times (#462, #553, 2026-08-24) and presents as workflow ` +
      `FAILURE with no distinguishable signal: runs are created, then die in ~4s ` +
      `with runner_id 0, no steps, and logs that 404 forever.\n\n` +
      `CONFIRM IT, do not assume it — this probe cannot see billing. Open the org ` +
      `billing page and read Actions "$ spent" against its budget. If it is at ` +
      `100%, raise the budget or set "Stop usage: No" and every private lane ` +
      `resumes within seconds.\n\n` +
      `IF BILLING IS FINE, the other causes of a stale stamp are: the ` +
      `front-desk-projection lane itself broken, the OIDC broker down, or a ` +
      `GitHub incident. Check them in that order. A quick discriminator: if runs ` +
      `in a PUBLIC org repo are also failing, it is not the budget — the budget ` +
      `does not reach public repos, which is the whole reason this probe can run ` +
      `at all.`,
  };
}

// ── the network half ────────────────────────────────────────────────────────

const OWNER = "bounded-systems";
const REPO = ".github-private";
const REF = "front-desk-projection";
const FILE = "front-desk.json";

/**
 * Reads the snapshot's stamp WITHOUT downloading the whole board. The private
 * file is ~1.9MB and only one string is wanted, so this asks the contents API
 * for the raw blob and pulls `generated_at` out of the leading bytes rather
 * than parsing megabytes of items. The projection writes the stamp as a
 * top-level key ahead of `items`, which is what makes this safe; if that ever
 * stops holding the regex simply misses and the verdict is `unreadable`,
 * which is the honest answer rather than a wrong one.
 */
export function stampFrom(raw) {
  const m = /"generated_at"\s*:\s*"([^"]+)"/.exec(raw);
  return m?.[1] ?? null;
}

export async function fetchStamp({ token, fetchImpl = fetch }) {
  const res = await fetchImpl(
    `https://api.github.com/repos/${OWNER}/${REPO}/contents/${FILE}?ref=${REF}`,
    {
      headers: {
        authorization: `Bearer ${token}`,
        accept: "application/vnd.github.raw+json",
        "user-agent": "bounded-systems-budget-liveness",
        "x-github-api-version": "2022-11-28",
      },
    },
  );

  if (!res.ok) {
    // 404 here is ambiguous in a way worth spelling out: it is what both "the
    // branch does not exist" and "this token cannot see the repo" return, and
    // the second is the arrival state until the door is minted.
    throw new Error(
      `GET ${REF}:${FILE} returned ${res.status}. ` +
        (res.status === 404
          ? "That is BOTH what a missing branch and an unauthorized token return, " +
            "so it does not by itself mean the projection is gone — check the door first."
          : "The contents API refused the read."),
    );
  }

  return stampFrom(await res.text());
}

export async function main({
  token = process.env.GITHUB_TOKEN,
  maxAgeHours = Number(process.env.MAX_AGE_HOURS || DEFAULT_MAX_AGE_HOURS),
  now = Date.now(),
  fetchImpl = fetch,
  log = console.log,
} = {}) {
  let outcome;
  try {
    if (!token) throw new Error("no token was supplied to the probe");
    outcome = assess({ stamp: await fetchStamp({ token, fetchImpl }), now, maxAgeHours });
  } catch (err) {
    outcome = { verdict: VERDICT.unreadable, ageHours: null, detail: err.message };
  }

  const { ok, title, body } = report(outcome, { maxAgeHours });
  // One line per line of body: ::error:: swallows everything after a newline,
  // so a multi-line annotation loses exactly the remediation steps that make
  // it worth reading.
  if (ok) log(body);
  else {
    log(`::error title=${title}::${body.split("\n").join(" ")}`);
    for (const line of body.split("\n")) log(line);
  }
  return ok;
}

// Only when run as a script, so the tests can import every export freely.
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  process.exit((await main()) ? 0 : 1);
}
