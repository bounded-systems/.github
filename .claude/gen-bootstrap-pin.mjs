#!/usr/bin/env node
/**
 * Generator for the bootstrap pin and its digests.
 *
 * ── Why this is generated and not hand-edited ────────────────────────────────
 * boot.sh (the fetched stage-1 bootstrap; the setup-script field is one line
 * that fetches and digest-checks it — see README.md) fetches a few files from
 * a pinned commit and refuses any whose SHA-256 does not match a recorded
 * digest. `PIN` and the `SUM_*` lines are therefore ONE ATOMIC PAIR: the
 * digests describe the files as they exist at that specific commit, and a pin
 * bumped without re-recording the digests bricks the bootstrap for everyone
 * without `.github` attached.
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
 * ── The OUTER value ──────────────────────────────────────────────────────────
 * The chain gained a link above this file (.github#125): the one-line field
 * verifies boot.sh itself against a dialog-recorded ORG_BOOT_SHA256, recorded
 * in `.github-private` → `.claude/cloud-environment.json` and gated there by
 * env-record.yml. Since 2026-08-10 the fetch URL is DERIVED from that digest in
 * the field text itself (boot.bounded.tools/<sha256>.sh, content-addressed) —
 * there is no separate URL variable, so the two halves cannot disagree. Any
 * change to boot.sh's BYTES — including the inner PIN/SUM_* rewrite a bump
 * performs — moves ORG_BOOT_SHA256, so every bump implies: publish the new
 * payload (infra cloudflare/boot + boot-deploy), PROBE the derived URL for a
 * 200 whose bytes hash to the new digest (step zero — the record's procedure),
 * then the record PR + dialog edit. `--outer` is run AFTER the bump lands,
 * against main, and prints both the digest and the derived URL to probe.
 *
 * ── Usage ────────────────────────────────────────────────────────────────────
 *   node .claude/gen-bootstrap-pin.mjs --check            # verify; exit 1 on drift
 *   node .claude/gen-bootstrap-pin.mjs <commit>           # rewrite PIN + digests
 *   node .claude/gen-bootstrap-pin.mjs --outer [commit]   # print the dialog pair at commit (default HEAD)
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const BOOT = join(HERE, "boot.sh");
const README_MD = join(HERE, "README.md");

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
 * something durable — `cat >`, `cp` or `mv` landing outside the fetch cache,
 * `node`, `chmod` — plus the `CLAUDE_SESSION_ROOT=` prefix, which is a step
 * without a file of its own. Guards (`[ … ]`) and FIELD_PLUMBING are ignored.
 * Anything else REFUSES to parse: a verb this function does not know is by
 * definition a step nobody has classified, and skipping it silently would
 * re-open exactly the gap the gate exists to close.
 */
export function parseSteps(source) {
  // boot.sh is the canonical script and parses whole; a fenced ```sh block is
  // still accepted so a fixture (or a doc embedding the script) parses the same.
  const block = source.startsWith("#!")
    ? source
    : source.match(/```sh\n#!\/usr\/bin\/env bash\n[\s\S]*?\n```/)?.[0];
  if (!block) throw new Error("no canonical setup-script block found — nothing to enumerate");

  const steps = new Map();
  const claim = (artifact, line) => {
    if (!artifact) throw new Error(`cannot name the artifact of: "${line}"`);
    if (!steps.has(artifact)) steps.set(artifact, { artifact, lines: [] });
    steps.get(artifact).lines.push(line);
  };
  const unquote = (w = "") => w.replace(/^["']|["']$/g, "");
  const basename = (p) => unquote(p).split("/").pop();
  // Landing INSIDE the fetch cache is staging, not installing — see the `cat`
  // and `cp`/`mv` branches below, which share this test.
  const inFetchCache = (path) => unquote(path).startsWith("$BOOT/");

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
    // `${…}` parameter expansions are masked first: their braces are syntax
    // inside a word, not compound-command delimiters, and splitting on them
    // turns `ROOT="${CLAUDE_SESSION_ROOT:-}"` into a phantom fragment.
    for (let frag of line.replace(/\$\{[^}]*\}/g, "$X").replace(/\$\(/g, "; ").split(/&&|\|\||[;|{}]/)) {
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
        // Same exemption as `cp`/`mv`, and for the same reason — it just took a
        // second writer into the cache to notice the rule was stated once per
        // verb rather than once (#325). boot.sh writes the `.mcp.json` that
        // DECLARES the fetched verb server into $BOOT, alongside the fetched
        // files themselves: inert content, made live by the `node
        // $BOOT/register-mcp.mjs` line further down, which IS a step and IS
        // covered by the manifest. Counting it would demand a fallback for the
        // cache populating itself — the same demand the `.unverified` staging
        // path would make, and the reason that one is exempt too.
        if (inFetchCache(target)) continue;
        claim(basename(target), raw.trim());
      } else if (verb === "cp" || verb === "mv") {
        const paths = words.slice(1).filter((w) => !w.startsWith("-"));
        const dest = unquote(paths[paths.length - 1]);
        if (inFetchCache(dest)) continue;
        claim(basename(dest), raw.trim());
      } else if (verb === "node" || verb === "bash") {
        // `bash` joins `node` rather than FIELD_PLUMBING because running a
        // fetched script IS installing something — `setup-toolpath.sh` puts
        // `path` on the session (#522). Classifying it as plumbing would let a
        // step into the field with no fallback and no declaration, which is the
        // single thing this parse exists to prevent.
        const script = words.slice(1).find((w) => !unquote(w).startsWith("-"));
        if (!script) throw new Error(`"${verb}" with no script in the canonical setup script: "${frag}"`);
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
 * Anchored line rewrites rather than a whole-file render: boot.sh is mostly
 * comments explaining this mechanism, including a hand-verify snippet whose
 * loop interpolates `$PIN`. Regenerating the document would destroy that; the
 * `^PIN=<40 hex>$` and `^SUM_x=<64 hex>$` anchors match only the live
 * assignments.
 */
export function renderBootstrap(source, { pin, digests }) {
  let out = source.replace(/^PIN=[0-9a-f]{40}[ \t]*$/m, `PIN=${pin}`);
  for (const [name, value] of Object.entries(digests)) {
    const line = new RegExp(`^${name}=[0-9a-f]{64}[ \\t]*$`, "m");
    if (!line.test(out)) throw new Error(`${name} is not declared in boot.sh — cannot rewrite it`);
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
 * The OUTER pair the one-line field verifies boot.sh against: the values the
 * operator records in the dialog (and `.github-private`'s
 * cloud-environment.json records in-repo). Computed AT A COMMIT, never from
 * the working tree, because the URL half names a commit — the same
 * content-vs-commit distinction the inner pair lives with.
 */
export function outerPair(commit, { read = fileAtCommit } = {}) {
  const bytes = read(commit, "boot.sh");
  const sha = sha256(bytes);
  return {
    // Derived, not stored: since 2026-08-10 the field text computes this from
    // $ORG_BOOT_SHA256 itself, so only the SHA is a dialog variable. Printed
    // here because step zero (probe BEFORE writing the record) needs the URL,
    // and deriving it in two places is how the pair drifted apart before.
    ORG_BOOT_URL: `https://boot.bounded.tools/${sha}.sh`,
    ORG_BOOT_SHA256: sha,
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

/**
 * The canonical field line in README — the one text an operator hand-types.
 *
 * Matched on `curl` + the host rather than by line number, the same way
 * bootstrap-pin.test.mjs finds it, so both agree on which line is the field.
 */
const fieldLine = (readme) => readme.split("\n").find((l) => l.includes("curl") && l.includes("boot.bounded.tools"));

/** The 64-hex literal the field currently names, or null if it carries none. */
export function fieldDigestOf(readme) {
  return fieldLine(readme)?.match(/boot\.bounded\.tools\/([0-9a-f]{64})\.sh/)?.[1] ?? null;
}

/**
 * Point the field at `digest`, on that line only.
 *
 * ── Why the bump has to do this (#184 → #185) ────────────────────────────────
 * Until #506 the field derived its URL from `$ORG_BOOT_SHA256`, so README named
 * no digest and a bump touching only boot.sh was complete. #506 made the digest a
 * LITERAL — the init phase has no dialog variables, so a field that reads the
 * variable fetches "…/.sh" and 404s into a hookless session. That made README's
 * field a second copy of boot.sh's identity, and the bump was never taught about
 * it: the first bump after #506 rewrote boot.sh, left the field naming the
 * pre-bump payload, and went red on its own gate. Every later bump would have.
 *
 * Scoped to the field line because README legitimately quotes other digests in
 * prose (worked examples, the old value in a bump note); a file-wide replace
 * would rewrite the documentation along with the instruction.
 *
 * No fixpoint problem: README is deliberately outside the fetch set and is not
 * hashed into boot.sh, so rewriting it cannot invalidate the digest just written.
 */
export function renderField(readme, digest) {
  const line = fieldLine(readme);
  if (!line) return readme;
  return readme.replace(line, line.replace(/[0-9a-f]{64}/g, digest));
}

function main(argv) {
  const source = readFileSync(BOOT, "utf8");
  const check = argv.includes("--check");
  const outer = argv.includes("--outer");
  const commit = argv.find((a) => !a.startsWith("--")) ?? "HEAD";

  if (outer) {
    // Run after a bump merges, against main: prints what the dialog (and the
    // .github-private record PR) should say. Warns rather than errors when the
    // working tree has drifted past the named commit — the pair is still
    // internally consistent; it just doesn't describe what you are looking at.
    const resolved = execFileSync("git", ["rev-parse", commit], { cwd: HERE, encoding: "utf8" }).trim();
    const pair = outerPair(resolved);
    for (const [k, v] of Object.entries(pair)) console.log(`${k}=${v}`);
    if (pair.ORG_BOOT_SHA256 !== sha256(source)) {
      console.error(
        `bootstrap-pin: NOTE — boot.sh in this working tree differs from ${resolved.slice(0, 12)}; ` +
          `the pair above describes the commit, not your tree. If a bump PR is pending, merge it ` +
          `first and re-run against the merge commit.`,
      );
    }
    return 0;
  }

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
    // The outer half of the same question. INTEGRITY above asks whether the
    // pinned files match the pin; this asks whether the field names the payload
    // an operator would actually be told to fetch. A field pointing at a digest
    // no longer on disk fails closed at boot — sha256sum -c refuses and the
    // session starts hookless — so it is exit 1 with the others, not a warning.
    const readmeText = readFileSync(README_MD, "utf8");
    const named = fieldDigestOf(readmeText);
    // Since #192 the canonical field is CHANNEL-BASED and names no digest at
    // all — the digest rides channel/front-desk.json, written by the
    // OIDC-pinned boot-manifest lane on merge. A digest-free field is
    // therefore the correct steady state, checked for its channel URL; a field
    // that DOES name a digest is the pre-#192 form and is held to the old rule
    // (it must name this tree's boot.sh) so a stale legacy paste stays caught.
    if (named === null) {
      if (!readmeText.includes("channel/front-desk.json")) {
        console.error(
          "bootstrap-pin: FIELD — README's field names no digest AND no channel manifest; " +
            "it fetches nothing verifiable. Restore the canonical channel-based field (#192).",
        );
        return 1;
      }
    } else if (named !== sha256(source)) {
      console.error(
        `bootstrap-pin: FIELD — README names ${named.slice(0, 12)} but boot.sh hashes to ` +
          `${sha256(source).slice(0, 12)}. The one-line field would fetch a payload it then refuses. ` +
          `Regenerate: node .claude/gen-bootstrap-pin.mjs ${pin}`,
      );
      return 1;
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
  writeFileSync(BOOT, next);
  console.log(`bootstrap-pin: ${reason}`);
  // The field names the payload by digest, and the bytes just changed. Written
  // in the same run as boot.sh so the pair cannot land half-updated — that split
  // is exactly what left #185 red.
  const readme = readFileSync(README_MD, "utf8");
  const rendered = renderField(readme, sha256(next));
  if (rendered !== readme) {
    writeFileSync(README_MD, rendered);
    console.log(`bootstrap-pin: field digest re-pointed — ${sha256(next).slice(0, 12)}…`);
  }
  // The outer half, stated as far as it can be stated today: the SHA-256 is
  // final (it hashes the bytes just written), but the URL's commit can only be
  // the merge commit this bump lands as. `--outer` completes it after merge.
  console.log(
    `bootstrap-pin: this bump's payload digest — ${sha256(next)}. Publish it (infra ` +
      `cloudflare/boot gen-payloads --add + boot-deploy) BEFORE merging here; on merge, ` +
      `boot-manifest.yml flips channel/front-desk to it (and 409s, naming the fix, if the ` +
      `payload is missing — no dialog edit at any step since #192)`,
  );
  return 0;
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  process.exit(main(process.argv.slice(2)));
}
