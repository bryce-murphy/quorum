#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import {
  PolicySchema,
  TaskManifestSchema,
  maxTier,
  type Policy,
  type Tier,
} from "@quorum/contracts";
import { extractClaims } from "./extract/index.js";
import { verifyClaims } from "./run.js";
import { buildLedger } from "./ledger/build.js";
import { renderLedger } from "./ledger/render.js";
import { computeTierFloor } from "./tier/floor.js";
import { validateArtifact } from "./validate.js";
import { LocalGitForge } from "./forge/local-git.js";
import { changedPaths, parseRawDiff } from "./diff.js";
import { applyStrictFailClosed, computeUncoveredPaths } from "./gate.js";

/** Exit codes (SPEC 4): 0 pass - 1 claim failure - 2 protocol/parse failure. */
const EXIT = { pass: 0, claimFailure: 1, protocol: 2 } as const;

function fail(message: string, code: number): never {
  process.stderr.write(`quorum: ${message}\n`);
  process.exit(code);
}

function parseFlags(args: string[]): { flags: Record<string, string>; bools: Set<string> } {
  const flags: Record<string, string> = {};
  const bools = new Set<string>();
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (!a.startsWith("--")) continue;
    const body = a.slice(2);
    // Support `--key=value` (e.g. --policy=head) alongside `--key value`.
    const eq = body.indexOf("=");
    if (eq !== -1) {
      flags[body.slice(0, eq)] = body.slice(eq + 1);
      continue;
    }
    const key = body;
    const next = args[i + 1];
    if (next !== undefined && !next.startsWith("--")) {
      flags[key] = next;
      i++;
    } else {
      bools.add(key);
    }
  }
  return { flags, bools };
}

function gitOut(args: string[], cwd: string): string | null {
  try {
    return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  } catch {
    return null;
  }
}

/** True iff `git <args>` exits 0 (used for predicate commands like is-ancestor). */
function gitOk(args: string[], cwd: string): boolean {
  try {
    execFileSync("git", args, { cwd, stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolve the delta base = the FORK POINT, or REFUSE to run (FIX 7 + FIX 8 + 11).
 *
 * `--base` names the TARGET REF (the PR base branch), never a raw diff base. The
 * kernel always computes `merge-base(HEAD, target)` itself, so an attacker cannot
 * hand-pick a carving point. Default target is `main`.
 *
 * Carving guard (FIX 11): an attacker can put a bad change in an early commit,
 * leave HEAD empty, and name a LATER ancestor so the change falls outside the
 * delta (coverage sees nothing, tier drops to T0). So when `main` is resolvable,
 * the computed base must be at or before the canonical fork point against `main`;
 * a base that is a *descendant* of that fork point is a carve => refuse.
 */
function resolveMergeBase(explicitBase: string | undefined, cwd: string): string {
  const target = explicitBase ?? "main";
  const mb = gitOut(["merge-base", "HEAD", target], cwd)?.trim();
  if (!mb) {
    fail(
      `could not resolve merge-base against '${target}'; pass the PR base branch via --base <ref>`,
      EXIT.protocol,
    );
  }
  // The delta base must be anchored to a TRUSTED fork point. `main` is that
  // anchor for Phase 1 --local.
  const canonical = gitOut(["merge-base", "HEAD", "main"], cwd)?.trim();
  if (canonical) {
    // Carving guard (FIX 11): the chosen base must be at or before the main fork
    // point; a descendant carves changes out of the delta => refuse.
    if (!gitOk(["merge-base", "--is-ancestor", mb, canonical], cwd)) {
      fail(
        `--base '${target}' carves the delta: its fork point is ahead of the fork against 'main'; refusing`,
        EXIT.protocol,
      );
    }
  } else if (explicitBase !== undefined) {
    // FIX 13: no `main` anchor AND an explicit --base. We have no trusted fork
    // point to detect carving, so we must NOT trust an arbitrary target ref -
    // fail closed rather than compute an unanchored delta. (In M3 the Gate
    // supplies an authenticated, immutable PR base from the forge event; that is
    // the trust source that makes --base safe without a local `main`.)
    fail(
      "refusing --base without a 'main' anchor: no trusted fork point to guard against delta carving",
      EXIT.protocol,
    );
  }
  return mb;
}

/**
 * QRM-3.2 (red-team R1): the CANONICAL trusted fork point, decoupled from the
 * `--base`-overridable diff base. `--base` legitimately WIDENS the diff range,
 * but it must never select WHICH POLICY grades the PR: the diff base and the
 * policy ref are otherwise the same attacker-influenceable ref, so `--base
 * <older>` would pick an older, WEAKER policy (e.g. from before `main` tightened
 * a floor) and grade the PR against it - a clean clear on a file `main` now
 * floors to T3. This always anchors to `main` (no `--base` override), exactly as
 * the no-flag path does, and fails closed when there is no `main` anchor.
 */
function canonicalForkPoint(cwd: string): string {
  return resolveMergeBase(undefined, cwd);
}

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8"));
}

function loadPolicy(cwd: string): Policy {
  const path = join(cwd, ".quorum", "policy.json");
  if (!existsSync(path)) fail(`policy not found at ${path}`, EXIT.protocol);
  let json: unknown;
  try {
    json = readJson(path);
  } catch {
    fail(`policy.json is not valid JSON`, EXIT.protocol);
  }
  const parsed = PolicySchema.safeParse(json);
  if (!parsed.success) fail(`policy.json invalid: ${parsed.error.issues[0]?.message}`, EXIT.protocol);
  return parsed.data;
}

/**
 * QRM-3.2 - load the WHOLE policy object from a git REF, not the working tree.
 *
 * The verify enforcement path grades a PR against the policy at the MERGE-BASE,
 * never the PR head: a PR's own .quorum/policy.json (working tree / head) can
 * delete a floor rule to self-lower its tier AND add itself to exempt_paths to
 * self-exempt from coverage. loadPolicy(cwd) reads the head's policy and is the
 * vulnerable source; this reads the blob at `ref` via git and validates it with
 * the SAME rules as loadPolicy.
 *
 * FAIL CLOSED: if the blob is absent at `ref` (gitOut null) we refuse - never
 * fall back to the head policy or a permissive default. Invalid JSON or a
 * schema-rejected policy at the base is a fatal protocol error, identical to
 * loadPolicy (a base policy the current schema rejects fails closed by design -
 * a schema-evolution mismatch must block, not silently pass).
 */
function loadPolicyAtRef(ref: string, cwd: string): Policy {
  const raw = gitOut(["show", `${ref}:.quorum/policy.json`], cwd);
  if (raw === null) fail(`policy not found at ${ref}:.quorum/policy.json`, EXIT.protocol);
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    fail(`policy.json at ${ref} is not valid JSON`, EXIT.protocol);
  }
  const parsed = PolicySchema.safeParse(json);
  if (!parsed.success) {
    fail(`policy.json at ${ref} invalid: ${parsed.error.issues[0]?.message}`, EXIT.protocol);
  }
  return parsed.data;
}

// -- quorum verify -------------------------------------------------------------
async function cmdVerify(args: string[]): Promise<void> {
  const { flags, bools } = parseFlags(args);
  const task = flags["task"];
  if (!task) fail("verify requires --task <id>", EXIT.protocol);
  const mode = (flags["mode"] ?? "strict") as "strict" | "salvage";
  if (mode !== "strict" && mode !== "salvage") fail(`unknown --mode ${mode}`, EXIT.protocol);
  const cwd = process.cwd();

  if (!bools.has("local")) {
    // Phase 1 CLI ships the offline path. GitHubForge is wired by the Gate (M3).
    fail("Phase 1 CLI supports --local only; pass --local", EXIT.protocol);
  }

  // Manifest (tier proposal + branch). Optional but expected for dogfooding.
  const manifestPath = join(cwd, ".quorum", "manifests", `${task}.json`);
  let tierProposed: Tier = "T0";
  let branch: string | undefined;
  if (existsSync(manifestPath)) {
    const parsed = TaskManifestSchema.safeParse(readJson(manifestPath));
    if (!parsed.success) fail(`manifest invalid: ${parsed.error.issues[0]?.message}`, EXIT.protocol);
    tierProposed = parsed.data.tier_proposed;
    branch = parsed.data.branch;
  }

  // Claims (strict: required file).
  const claimsPath = join(cwd, ".quorum", "claims", `${task}.jsonl`);
  const claimsJsonl = existsSync(claimsPath) ? readFileSync(claimsPath, "utf8") : undefined;
  if (mode === "strict" && claimsJsonl === undefined) {
    fail(`strict mode: claims file not found at ${claimsPath}`, EXIT.claimFailure);
  }

  const extracted = extractClaims({ claimsJsonl, task }, mode);
  if (mode === "strict" && extracted.errors.length > 0) {
    for (const e of extracted.errors) {
      process.stderr.write(`quorum: claim parse error (${e.source}${e.line ? `:${e.line}` : ""}): ${e.message}\n`);
    }
    fail("strict mode: claims failed to parse", EXIT.protocol);
  }

  // Repo state + tier floor.
  const head = "HEAD";
  // The DIFF base may honor --base (legitimate diff-widening, guarded against
  // carving by resolveMergeBase). QRM-3.2 (red-team R1): the POLICY ref is a
  // SEPARATE, canonical fork point that --base CANNOT move - see below.
  const diffBase = resolveMergeBase(flags["base"], cwd); // FIX 7/8/11/13

  // M2.1: empty self-delta. When HEAD *is* the merge-base (running on `main`, or
  // re-running a squash-merged task whose branch commits are no longer in
  // history), there is no branch delta to verify. Branch-delta-scoped claims
  // (file_modified, commit_pushed) would resolve to `failed` against the empty
  // range and emit a blocking verdict that actually means "nothing to check" -
  // alarm-fatigue noise we are told to ignore, which is itself a bug. Verification
  // is a PRE-MERGE gate against a base, so the correct behavior on an empty delta
  // is to DECLINE cleanly (exit 0, distinct message), not to run claims and fail.
  const headSha = gitOut(["rev-parse", head], cwd)?.trim();
  if (headSha && headSha === diffBase) {
    process.stdout.write(
      `Quorum: no delta to verify for ${task} - HEAD is at the merge-base ` +
        `(empty self-delta). Verification is a pre-merge gate run against a base; ` +
        `there is nothing to check here. Run it on a feature branch against its base.\n`,
    );
    process.exit(EXIT.pass);
  }

  // FIX 10 + FIX 12 + QRM-3.1: --raw -M surfaces both sides of a rename AND the
  // per-side git object mode (so the floor can react to symlink/gitlink modes);
  // -z gives raw NUL-delimited paths so non-ASCII names aren't C-quoted (which
  // would mis-split and understate the tier floor). parseRawDiff fails closed.
  const diffRaw = gitOut(["diff", "--raw", "-M", "-z", `${diffBase}..${head}`], cwd) ?? "";
  const diffEntries = parseRawDiff(diffRaw);
  const diffPaths = changedPaths(diffEntries);
  // QRM-3.2: grade against the BASE policy, not the PR head. This SAME object
  // feeds BOTH the tier floor (below) AND coverage (policy.exempt_paths, further
  // down) - a PR cannot self-lower its floor or self-exempt by editing its own
  // working-tree .quorum/policy.json. Loaded AFTER the empty-self-delta decline
  // so a run on `main` still declines before any policy read.
  //
  // QRM-3.2 (red-team R1): the policy ref is the CANONICAL fork point, NOT the
  // --base-overridable diffBase - otherwise `--base <older>` could select an
  // older, weaker policy. The diff still spans diffBase..HEAD (so --base's
  // legitimate diff-widening is preserved); only the POLICY ref is pinned.
  const policyRef = canonicalForkPoint(cwd);
  const policy = loadPolicyAtRef(policyRef, cwd);
  const tierEffective = maxTier(tierProposed, computeTierFloor(diffEntries, policy));

  const forge = new LocalGitForge({ cwd, head, mergeBase: diffBase });
  const rawResults = await verifyClaims(extracted.claims, forge, { head, mergeBase: diffBase, branch });
  // FIX 4: fail closed on unverifiable forge-only claims in strict mode.
  const results = applyStrictFailClosed(rawResults, mode);
  // FIX 1 + FIX 9: every changed path must be covered by a qualifying claim
  // (content-verified at T2+) or a policy exemption.
  const uncovered = computeUncoveredPaths(
    extracted.claims,
    results,
    diffPaths,
    policy.exempt_paths ?? [],
    tierEffective,
  );

  const ledger = buildLedger(results, {
    task,
    head,
    mode,
    tier_effective: tierEffective,
    uncovered_paths: uncovered,
    diff_non_empty: diffPaths.length > 0,
  });

  process.stdout.write(`${renderLedger(ledger)}\n`);
  process.exit(ledger.verdict === "fail" ? EXIT.claimFailure : EXIT.pass);
}

// -- quorum tier ---------------------------------------------------------------
// Pure-local: derives changed paths from git and the policy. No forge, no token.
//
// QRM-3.2: enforcement-consistent by DEFAULT. tier resolves a merge-base exactly
// like verify (--base <target>, default `main`, via resolveMergeBase), diffs
// diffBase..HEAD, and reads the policy from the CANONICAL fork point
// (loadPolicyAtRef(canonicalForkPoint)) - so `tier` reports what the gate would
// enforce, not what the PR head wishes, and --base cannot swap in a weaker policy
// (red-team R1: the policy ref is decoupled from the --base-overridable diff base).
//
// We do NOT parse a base side out of an arbitrary `--diff <range>`: an attacker-
// chosen carving point is exactly the trust ambiguity resolveMergeBase exists to
// remove. Head-policy inspection survives ONLY as `--policy=head`: an explicit,
// labeled, NON-DEFAULT diagnostic that reads the working-tree policy and warns on
// stderr that it does not reflect enforcement.
function cmdTier(args: string[]): void {
  const { flags, bools } = parseFlags(args);
  const cwd = process.cwd();
  const head = "HEAD";

  // QRM-3.2 (Codex P2/P3): --diff is no longer supported and must be rejected, not
  // silently ignored. Accepting it would appear to grade the requested range while
  // actually grading mergeBase..HEAD - e.g. `tier --diff HEAD~1..HEAD` on main
  // returns T0 for the empty self-delta, hiding a high-tier change in HEAD~1.
  // P3: also catch the valueless spelling (`tier --diff`, `tier --diff --base main`)
  // which parseFlags routes into bools, not flags.
  if (flags["diff"] !== undefined || bools.has("diff")) {
    fail(
      "tier no longer supports --diff <range>; the diff is computed over <base>..HEAD. " +
        "Use --base <target> to widen the diff, or --policy=head for a non-enforcement working-tree reading.",
      EXIT.protocol,
    );
  }

  const policySource = flags["policy"];
  if (policySource !== undefined && policySource !== "head") {
    fail(`unknown --policy '${policySource}' (only --policy=head is supported)`, EXIT.protocol);
  }

  const diffBase = resolveMergeBase(flags["base"], cwd); // FIX 7/8/11/13
  // FIX 10 + FIX 12 + QRM-3.1: rename-aware, mode-bearing (--raw), NUL-delimited
  // (non-ASCII paths intact). parseRawDiff fails closed on a malformed stream.
  const diffOut = gitOut(["diff", "--raw", "-M", "-z", `${diffBase}..${head}`], cwd);
  if (diffOut === null) fail(`could not compute diff for ${diffBase}..${head}`, EXIT.protocol);
  const diffEntries = parseRawDiff(diffOut);

  let policy: Policy;
  if (policySource === "head") {
    process.stderr.write(
      "quorum: --policy=head is a NON-ENFORCEMENT diagnostic: it grades against the " +
        "working-tree policy (which a PR can edit), NOT the merge-base policy the gate " +
        "enforces. Do not rely on this output for a merge decision.\n",
    );
    policy = loadPolicy(cwd);
  } else {
    // QRM-3.2 (red-team R1): policy from the CANONICAL fork point, never the
    // --base-overridable diffBase, so --base cannot select a weaker policy.
    policy = loadPolicyAtRef(canonicalForkPoint(cwd), cwd);
  }
  process.stdout.write(`${computeTierFloor(diffEntries, policy)}\n`);
  process.exit(EXIT.pass);
}

// -- quorum validate ---------------------------------------------------------
function cmdValidate(args: string[]): void {
  const file = args.find((a) => !a.startsWith("--"));
  if (!file) fail("validate requires a <file>", EXIT.protocol);
  if (!existsSync(file)) fail(`file not found: ${file}`, EXIT.protocol);

  const validateOne = (json: unknown, label: string): boolean => {
    const schemaId =
      json && typeof json === "object" && "schema" in json
        ? String((json as { schema: unknown }).schema)
        : undefined;
    if (!schemaId) {
      process.stderr.write(`quorum: ${label}: missing "schema" field\n`);
      return false;
    }
    const result = validateArtifact(json, schemaId);
    if (result.ok) {
      process.stdout.write(`ok: ${label} (${schemaId})\n`);
      return true;
    }
    for (const err of result.errors) process.stderr.write(`quorum: ${label}: ${err}\n`);
    return false;
  };

  let allValid = true;
  if (file.endsWith(".jsonl")) {
    const lines = readFileSync(file, "utf8").split("\n");
    for (let i = 0; i < lines.length; i++) {
      const raw = lines[i]!.trim();
      if (raw === "") continue;
      let json: unknown;
      try {
        json = JSON.parse(raw);
      } catch {
        fail(`${file}:${i + 1}: invalid JSON`, EXIT.protocol);
      }
      if (!validateOne(json, `${file}:${i + 1}`)) allValid = false;
    }
  } else {
    let json: unknown;
    try {
      json = readJson(file);
    } catch {
      fail(`${file}: invalid JSON`, EXIT.protocol);
    }
    if (!validateOne(json, file)) allValid = false;
  }
  process.exit(allValid ? EXIT.pass : EXIT.claimFailure);
}

async function main(): Promise<void> {
  const [sub, ...rest] = process.argv.slice(2);
  switch (sub) {
    case "verify":
      return cmdVerify(rest);
    case "tier":
      return cmdTier(rest);
    case "validate":
      return cmdValidate(rest);
    default:
      fail(`usage: quorum <verify|tier|validate> [options]`, EXIT.protocol);
  }
}

main().catch((err: unknown) => {
  fail(err instanceof Error ? err.message : String(err), EXIT.protocol);
});
