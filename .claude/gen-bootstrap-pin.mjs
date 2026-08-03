#!/usr/bin/env node
/**
 * Generator for the bootstrap pin and its digests.
 *
 * ── Why this is generated and not hand-edited ────────────────────────────────
 * README.md's setup script fetches a few files from a pinned commit and refuses
 * any whose SHA-256 does not match a recorded digest. `PIN` and the `SUM_*`
 * lines are therefore ONE ATOMIC PAIR: the digests describe the files as they
 * exist at that specific commit, and a pin bumped without re-recording the
 * digests bricks the bootstrap for everyone without `.github` attached.
 *
 * Both halves were hand-maintained and both went wrong within one afternoon
 * (2026-07-31): #71 recorded a pin predating the file it existed to install, and
 * #72 changed a pinned file without re-pinning at all. bootstrap-pin.test.mjs
 * was written to catch that, and it does — but a gate that only says "wrong"
 * still leaves a human to hand-copy 64 hex characters three times.
 *
 * So the gate and the fix now share this one implementation. `--check` verifies;
 * no flag rewrites. They cannot disagree about what "correct" means, which is
 * the failure mode that produced #71 and #72 in the first place.
 *
 * ── Why the pin can only be correct AFTER a merge ────────────────────────────
 * `SUM_*` is content-addressed and knowable on a branch. `PIN` is a COMMIT and
 * cannot name the merge commit until that commit exists. The pair must agree
 * with each other, so on a PR that touches a fetched file the pair is
 * necessarily inconsistent — there is no honest way to make it green before the
 * merge. Recording the new digests early only moves the failure from FRESHNESS
 * to INTEGRITY.
 *
 * That is why org-defaults.yml runs this in `--check` on pull_request (where it
 * reports, and cannot block on a fact no PR can fix) and regenerates on push to
 * main, opening the bump PR automatically.
 *
 * ── Why this terminates ──────────────────────────────────────────────────────
 * Because a bump is written only when the pin is WRONG, never when it is merely
 * older. That distinction IS the termination argument, and the first version of
 * this file did not make it: it rewrote whenever the rendered document differed
 * from the current one, and it always differs, because PIN names a commit. Each
 * bump landed on main as a new commit, the next push found PIN naming that
 * commit's parent, and opened another bump — indefinitely, with no fetched file
 * ever having changed.
 *
 * The argument this shipped with — "the bump only edits README.md, which is
 * deliberately not in the fetch set, so it cannot invalidate the pin it just
 * wrote" — is true, and was not sufficient. It establishes that the CONTENT
 * stays consistent across a bump; it says nothing about the commit id, and the
 * commit id was what the rewrite keyed on. Running the loop found that in two
 * commits; reasoning about it had already missed it once.
 *
 * So freshness is judged as a claim about content (`planBump`): an older pin
 * that still serves byte-identical files is correct, and correct is a no-op.
 *
 * ── Usage ────────────────────────────────────────────────────────────────────
 *   node .claude/gen-bootstrap-pin.mjs --check     # verify; exit 1 on drift
 *   node .claude/gen-bootstrap-pin.mjs <commit>    # rewrite PIN + digests
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const README = join(HERE, "README.md");

export const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");

/**
 * What the setup script says it will fetch, and what it will accept.
 *
 * The (file, digest-variable) pairs come from the `fetch_verified` CALL SITES
 * rather than from the `SUM_` names, because the name mangling is lossy — both
 * `-` and `.` become `_`, so `SUM_session_start_dispatch_mjs` cannot be turned
 * back into a filename unambiguously. The call site states both halves.
 */
export function parseBootstrap(source) {
  // `[ \t]*`, never `\s*`: JS `\s` matches newlines, so with `m` a trailing
  // `\s*$` runs past the end of the line and swallows the blank line after it.
  // Harmless when only capturing, destructive when the same shape is reused to
  // REPLACE — renderBootstrap deleted a line that way until this was pinned.
  const pin = source.match(/^PIN=([0-9a-f]{40})[ \t]*$/m)?.[1] ?? null;

  const digests = {};
  for (const [, name, value] of source.matchAll(/^(SUM_\w+)=([0-9a-f]{64})[ \t]*$/gm)) {
    digests[name] = value;
  }

  const fetches = [...source.matchAll(/^\s*fetch_verified\s+(\S+)\s+"\$(SUM_\w+)"/gm)]
    .map(([, file, sumVar]) => ({ file, sumVar }));

  return { pin, digests, fetches };
}

/** Command words in the canonical script that stage, observe or report rather
 *  than install. `curl`/`sha256sum`/`cut` are the fetch_verified transport, and
 *  `fetch_verified` calls themselves are gated by the digest parse above — an
 *  unverified fetch already fails bootstrap-pin.test.mjs. */
const FIELD_PLUMBING = new Set([
  "set", "echo", "mkdir", "rm", "local", "return", "true",
  "curl", "sha256sum", "cut", "fetch_verified",
]);

/**
 * The STEPS of the canonical setup script — the installs it performs, keyed by
 * the artifact each touches.
 *
 * ── Why this parse exists (#91 / I1 in docs/session-capability-invariants.md) ─
 * The setup-script field lives where no reviewer and no gate can see it; the
 * text in README.md is its canonical form. Some of its steps the dispatcher can
 * re-do when the field has not; some it cannot — and the mapping between the
 * field's contents and that coverage used to exist only as prose, so a step
 * added to the field with no fallback was invisible until it went missing in
 * production (#85). bootstrap-steps.test.mjs asserts every step this parse
 * finds maps to a MANIFEST entry or an IRREDUCIBLE declaration in
 * session-start-dispatch.mjs.
 *
 * A "step" is mechanical, not judged: a command that writes or invokes
 * something durable — `cat >`, `cp`/`mv` landing outside the fetch cache,
 * `node`, `chmod` — plus the `CLAUDE_SESSION_ROOT=` prefix, which is a step
 * without a file of its own. Guards (`[ … ]`) and FIELD_PLUMBING are ignored.
 * Anything else REFUSES to parse: a verb this function does not know is by
 * definition a step nobody has classified, and skipping it silently would
 * re-open exactly the gap the gate exists to close.
 */
export function parseSteps(source) {
  const block = source.match(/```sh\n#!\/usr\/bin\/env bash\n[\s\S]*?\n```/)?.[0];
  if (!block) throw new Error("no canonical setup-script block found — nothing to enumerate");

  const steps = new Map();
  const claim = (artifact, line) => {
    if (!artifact) throw new Error(`cannot name the artifact of: "${line}"`);
    if (!steps.has(artifact)) steps.set(artifact, { artifact, lines: [] });
    steps.get(artifact).lines.push(line);
  };
  const unquote = (w = "") => w.replace(/^["']|["']$/g, "");
  const basename = (p) => unquote(p).split("/").pop();

  // The env prefix is a step without a file. Scanned on the RAW block because
  // one of its two spellings sits inside the heredoc body stripped below.
  if (/\bCLAUDE_SESSION_ROOT=/.test(block)) claim("CLAUDE_SESSION_ROOT", "the CLAUDE_SESSION_ROOT=… prefix");

  // Join continuation lines, then drop heredoc BODIES — they are content being
  // written, not commands being run. The settings heredoc contains a
  // `node …session-start-dispatch.mjs` command STRING; enumerating it would
  // demand a fallback for the dispatcher installing itself, which is the
  // declared-irreducible case, not a step of its own.
  const lines = [];
  let terminator = null;
  for (const raw of block.replace(/\\\n\s*/g, " ").split("\n")) {
    if (terminator) {
      if (raw.trim() === terminator) terminator = null;
      continue;
    }
    terminator = raw.match(/<<-?'?(\w+)'?/)?.[1] ?? null;
    lines.push(raw);
  }

  for (const raw of lines) {
    // `(^|\s)#`, not a bare `#`: `echo "… (infra#112)"` carries a # that is not
    // a comment, and it is not preceded by whitespace.
    const line = raw.replace(/(^|\s)#.*$/, "").trim();
    if (!line || line.startsWith("```")) continue;
    if (/^\w+\(\)\s*\{?/.test(line)) continue; // a function definition; its body parses line by line

    // Flatten `$( … )` command substitutions into fragments of their own, then
    // split compound lines; each fragment is classified by its first word.
    for (let frag of line.replace(/\$\(/g, "; ").split(/&&|\|\||[;|{}]/)) {
      frag = frag.replace(/^\s*(?:if|then|elif|else|fi|do|done|while|until)\b/, "").trim();
      if (!frag.replace(/["')]/g, "").trim()) continue;
      if (frag.startsWith("[")) continue; // guards observe; they do not install
      const cmd = frag.replace(/^(?:\w+=(?:"[^"]*"|'[^']*'|\S*)[ \t]+)+/, "");
      if (/^\w+=/.test(cmd)) continue; // an assignment — its command subs were flattened out above
      const words = cmd.split(/\s+/);
      const verb = words[0];
      if (FIELD_PLUMBING.has(verb)) continue;

      if (verb === "cat") {
        const target = cmd.match(/>\s*"?([^"\s]+)/)?.[1];
        if (!target) throw new Error(`"cat" with no redirect target in the canonical setup script: "${frag}"`);
        claim(basename(target), raw.trim());
      } else if (verb === "cp" || verb === "mv") {
        const paths = words.slice(1).filter((w) => !w.startsWith("-"));
        const dest = unquote(paths[paths.length - 1]);
        if (dest.startsWith("$BOOT/")) continue; // landing INSIDE the fetch cache is staging, not installing
        claim(basename(dest), raw.trim());
      } else if (verb === "node") {
        const script = words.slice(1).find((w) => !unquote(w).startsWith("-"));
        if (!script) throw new Error(`"node" with no script in the canonical setup script: "${frag}"`);
        claim(basename(script), raw.trim());
      } else if (verb === "chmod") {
        claim(basename(words[words.length - 1]), raw.trim());
      } else {
        throw new Error(
          `unrecognized command in the canonical setup script: "${frag}"\n` +
            `  Every line of the field is either plumbing or a step, and this parse does not\n` +
            `  know which this one is. If it stages or reports, add its verb to FIELD_PLUMBING\n` +
            `  with a reason. If it installs something, it is a STEP: give it a MANIFEST entry\n` +
            `  in session-start-dispatch.mjs (the dispatcher re-does it when the field has\n` +
            `  not) or an IRREDUCIBLE declaration (why nothing can), and teach this parse its\n` +
            `  verb. Skipping it silently is how the next #85 happens.`,
        );
      }
    }
  }
  return [...steps.values()];
}

/**
 * Rewrite the pin and digests in place.
 *
 * Anchored line rewrites rather than a whole-file render: README.md is mostly
 * prose explaining this mechanism, including a worked example of a REFUSED
 * digest and a `PIN=<the pin>` placeholder in a copy-paste snippet. Regenerating
 * the document would destroy that; the `^PIN=<40 hex>$` and `^SUM_x=<64 hex>$`
 * anchors match only the live assignments, and the placeholder is not 40 hex.
 */
export function renderBootstrap(source, { pin, digests }) {
  let out = source.replace(/^PIN=[0-9a-f]{40}[ \t]*$/m, `PIN=${pin}`);
  for (const [name, value] of Object.entries(digests)) {
    const line = new RegExp(`^${name}=[0-9a-f]{64}[ \\t]*$`, "m");
    if (!line.test(out)) throw new Error(`${name} is not declared in README.md — cannot rewrite it`);
    out = out.replace(line, `${name}=${value}`);
  }
  return out;
}

/** Read a fetched file as it exists at a commit. */
export function fileAtCommit(commit, file, { cwd = HERE } = {}) {
  try {
    return execFileSync("git", ["show", `${commit}:.claude/${file}`], { cwd, maxBuffer: 8 * 1024 * 1024 });
  } catch (e) {
    throw new Error(
      `cannot read ${file} at ${String(commit).slice(0, 12)} — if this is CI, the checkout needs ` +
        `fetch-depth: 0, since the pin is usually not the tip commit.\n${e.message}`,
    );
  }
}

/** The digests a given commit's contents imply, keyed by SUM_ variable. */
export function digestsAt(commit, fetches, { read = fileAtCommit } = {}) {
  const out = {};
  for (const { file, sumVar } of fetches) out[sumVar] = sha256(read(commit, file));
  return out;
}

/**
 * The two independent properties, evaluated separately because they fail for
 * different reasons and — crucially — have different fixes.
 *
 *   INTEGRITY — the recorded digests describe the file AT THE RECORDED PIN.
 *     Violated means the bootstrap REFUSES a legitimate file: it is broken right
 *     now, for anyone without `.github` attached. Always a bug, always fixable
 *     on the branch that caused it.
 *
 *   FRESHNESS — the file at the pin matches the file HERE. Violated means the
 *     bootstrap still works but serves older code than reviewers see. On a PR
 *     this is expected and unfixable; on main it is a real, if brief, divergence.
 */
export function inspect(source, { commit = "HEAD", read = fileAtCommit } = {}) {
  const { pin, digests, fetches } = parseBootstrap(source);
  if (!pin) throw new Error("no PIN=<40 hex> found — the setup script lost its pin");
  if (!fetches.length) throw new Error("no fetch_verified calls found — nothing is being pinned");

  const atPin = digestsAt(pin, fetches, { read });
  const atHere = digestsAt(commit, fetches, { read });

  return {
    pin,
    fetches,
    integrity: fetches.filter(({ sumVar }) => digests[sumVar] !== atPin[sumVar]).map((f) => f.file),
    stale: fetches.filter(({ sumVar }) => atPin[sumVar] !== atHere[sumVar]).map((f) => f.file),
  };
}

/**
 * What a bump should write at `commit`, if anything.
 *
 * Split out of main() because this is the termination argument in code, and the
 * termination argument is the part that was wrong — it belongs somewhere a test
 * can reach without a git repository to push around.
 *
 * Two independent reasons to write nothing, kept separate because they mean
 * different things: the pin is already CORRECT (older, still serving these
 * bytes — the steady state after a bump lands), or the pin is already THIS
 * commit (a re-run of the same bump).
 */
export function planBump(source, { commit, read = fileAtCommit } = {}) {
  const { pin, fetches } = parseBootstrap(source);
  const { integrity, stale } = inspect(source, { commit, read });

  if (!integrity.length && !stale.length) {
    return { write: false, next: source, reason: `${pin.slice(0, 12)} already serves this content` };
  }

  const next = renderBootstrap(source, { pin: commit, digests: digestsAt(commit, fetches, { read }) });
  if (next === source) return { write: false, next, reason: `already at ${commit.slice(0, 12)}` };

  return { write: true, next, reason: `pinned ${commit.slice(0, 12)} (${fetches.length} digest(s) re-recorded)` };
}

function main(argv) {
  const source = readFileSync(README, "utf8");
  const check = argv.includes("--check");
  const commit = argv.find((a) => !a.startsWith("--")) ?? "HEAD";

  if (check) {
    const { pin, integrity, stale } = inspect(source);
    if (integrity.length) {
      console.error(
        `bootstrap-pin: INTEGRITY — recorded digests do not match ${integrity.join(", ")} at ` +
          `${pin.slice(0, 12)}. The bootstrap would REFUSE these files. Regenerate: ` +
          `node .claude/gen-bootstrap-pin.mjs ${pin}`,
      );
      return 1;
    }
    if (stale.length) {
      console.error(`bootstrap-pin: STALE — the pin ${pin.slice(0, 12)} predates ${stale.join(", ")}.`);
      return 2; // distinct from 1: expected on a PR, actionable only after merge
    }
    console.log(`bootstrap-pin: ok — ${pin.slice(0, 12)} serves what this tree contains`);
    return 0;
  }

  const resolved = execFileSync("git", ["rev-parse", commit], { cwd: HERE, encoding: "utf8" }).trim();
  const { write, next, reason } = planBump(source, { commit: resolved });

  if (!write) {
    console.log(`bootstrap-pin: ${reason} — nothing to write`);
    return 0;
  }
  writeFileSync(README, next);
  console.log(`bootstrap-pin: ${reason}`);
  return 0;
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  process.exit(main(process.argv.slice(2)));
}
