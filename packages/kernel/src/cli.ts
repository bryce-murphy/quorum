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
    const key = a.slice(2);
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
  const mergeBase = (gitOut(["merge-base", "HEAD", "main"], cwd) ?? gitOut(["rev-parse", "HEAD"], cwd) ?? "HEAD").trim();
  const diffOut = gitOut(["diff", "--name-only", `${mergeBase}..${head}`], cwd) ?? "";
  const diffPaths = diffOut.split("\n").map((s) => s.trim()).filter(Boolean);
  const policy = loadPolicy(cwd);
  const tierEffective = maxTier(tierProposed, computeTierFloor(diffPaths, policy));

  const forge = new LocalGitForge({ cwd, head, mergeBase });
  const rawResults = await verifyClaims(extracted.claims, forge, { head, mergeBase, branch });
  // FIX 4: fail closed on unverifiable forge-only claims in strict mode.
  const results = applyStrictFailClosed(rawResults, mode);
  // FIX 1: every changed path must be covered by a verified claim or exemption.
  const uncovered = computeUncoveredPaths(extracted.claims, results, diffPaths, policy.exempt_paths ?? []);

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
// Pure-local: derives changed paths from git and the committed policy. No forge,
// no token (SPEC 6 acceptance invokes it exactly this way).
function cmdTier(args: string[]): void {
  const { flags } = parseFlags(args);
  const range = flags["diff"];
  if (!range) fail("tier requires --diff <range>", EXIT.protocol);
  const cwd = process.cwd();
  const diffOut = gitOut(["diff", "--name-only", range], cwd);
  if (diffOut === null) fail(`could not compute diff for range '${range}'`, EXIT.protocol);
  const diffPaths = diffOut.split("\n").map((s) => s.trim()).filter(Boolean);
  const policy = loadPolicy(cwd);
  process.stdout.write(`${computeTierFloor(diffPaths, policy)}\n`);
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
