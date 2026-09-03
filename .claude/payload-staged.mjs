#!/usr/bin/env node
/**
 * payload-staged.mjs — a PR that changes boot.sh may not merge until the bytes it
 * produces are already SERVABLE from the boot store.
 *
 * ── Why this exists ──────────────────────────────────────────────────────────
 * boot.sh reaches a session through a chain: its digest must be in the store
 * (infra, cloudflare/boot/src/payloads.mjs), the store deployed (boot-deploy),
 * and only THEN can boot-manifest on main flip the channel to it. boot-manifest
 * refuses a digest the store does not hold — correctly (#192's publish-race
 * guard). So merging a boot.sh change BEFORE its payload is staged puts main red
 * and leaves every detached session on the previous bytes until someone notices.
 *
 * That happened three times in one day (2026-09-03). Twice the retrospective said
 * "pre-stage first" and once it said "the ordering discipline did not survive one
 * lap". Prose lost every time. This is the check.
 *
 * ── What it asserts, and what it deliberately does not ───────────────────────
 * If boot.sh is unchanged against the base, there is nothing to stage: green.
 * If it changed, GET <store>/<sha256 of the branch's boot.sh>.sh must be 200.
 * A 404 is the exact red this exists for, and its message is the remedy. Any
 * OTHER answer — a 5xx, a network failure — is ALSO red: a check that cannot
 * establish the property must not report it held. Fail closed.
 *
 * It does not check that the channel serves this digest (that is boot-manifest's
 * job, after merge) and it does not check the pin (bootstrap-pin.test.mjs).
 */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
export const STORE = "https://boot.bounded.tools";

export const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

/** boot.sh's digest at a git ref, or `null` if that ref does not carry it. */
export function digestAt(ref, { cwd = HERE } = {}) {
  try {
    return sha256(execFileSync("git", ["show", `${ref}:.claude/boot.sh`], { cwd, stdio: ["ignore", "pipe", "ignore"] }));
  } catch {
    return null;
  }
}

/**
 * The decision, pure so it can be tested without a store or a git tree.
 *   changed  — boot.sh differs between base and head
 *   status   — the store's HTTP status for <digest>.sh, or `null` for no answer
 */
export function verdict({ changed, digest, status, headRef = "<your branch>" }) {
  if (!changed) return { ok: true, message: "boot.sh is unchanged against the base — nothing to stage." };
  if (status === 200) return { ok: true, message: `payload ${digest.slice(0, 12)}… is servable from the store — safe to merge.` };
  if (status === 404) {
    return {
      ok: false,
      message:
        `payload ${digest.slice(0, 12)}… is NOT in the boot store. Merging now would turn boot-manifest red on\n` +
        `main and leave every detached session on the previous bytes.\n` +
        `\n` +
        `Stage it first, in bounded-systems/infra:\n` +
        `  node cloudflare/boot/gen-payloads.mjs --add ${headRef}\n` +
        `then merge that, run boot-deploy, and re-run this check. The store is append-only, so staging a\n` +
        `digest this branch later changes costs nothing but a few KB.`,
    };
  }
  return {
    ok: false,
    message: `the boot store answered ${status ?? "nothing"} for ${digest.slice(0, 12)}… — cannot establish that it is staged, so not reporting that it is.`,
  };
}

export async function probe(digest, { fetchImpl = fetch, store = STORE } = {}) {
  try {
    const res = await fetchImpl(`${store}/${digest}.sh`, { method: "GET", redirect: "manual" });
    // Drain so the socket is released; the body is not what is being asserted.
    await res.arrayBuffer().catch(() => {});
    return res.status;
  } catch {
    return null;
  }
}

export async function main({ base = process.env.BASE_SHA, headRef = process.env.HEAD_REF, env = process.env } = {}) {
  if (!base) throw new Error("BASE_SHA is unset — nothing to compare boot.sh against");
  const head = sha256(readFileSync(join(HERE, "boot.sh")));
  const atBase = digestAt(base);
  const changed = atBase !== head;
  const status = changed ? await probe(head, { store: env.BOOT_STORE_URL || STORE }) : null;
  const v = verdict({ changed, digest: head, status, headRef });
  console.log(`payload-staged: ${v.message}`);
  return v.ok;
}

if (process.argv[1] && process.argv[1].endsWith("payload-staged.mjs")) {
  main().then((ok) => process.exit(ok ? 0 : 1), (e) => { console.error(`payload-staged: ${e.message}`); process.exit(2); });
}
