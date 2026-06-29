import { describe, it, expect, beforeAll } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// QRM-3.2 - verify/tier must grade a PR against the policy at the MERGE-BASE, not
// the PR head. A PR's own .quorum/policy.json (working tree) can delete a floor
// rule to self-lower its tier AND add itself to exempt_paths to self-exempt from
// coverage. These end-to-end tests build real git repos and assert the BASE
// policy governs both axes (tier floor and coverage/exempt_paths), and that the
// base-policy read fails closed when the base policy is missing or unusable.
const cliPath = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
const haveBuild = existsSync(cliPath);

const hashOf = (content: string): string =>
  createHash("sha256").update(Buffer.from(content, "utf8")).digest("hex");

interface Run {
  status: number;
  stdout: string;
  stderr: string;
}
function runCli(args: string[], cwd: string): Run {
  // spawnSync (not execFileSync) so stderr is captured on the SUCCESS path too -
  // the --policy=head diagnostic warning is emitted to stderr with exit 0.
  const r = spawnSync("node", [cliPath, ...args], { cwd, encoding: "utf8" });
  return { status: r.status ?? 1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}
const git = (args: string[], cwd: string) =>
  execFileSync("git", args, { cwd, stdio: ["ignore", "ignore", "ignore"] });
const initRepo = (slug: string): string => {
  const repo = mkdtempSync(join(tmpdir(), `quorum-${slug}-`));
  git(["init", "-b", "main"], repo);
  git(["config", "user.email", "t@t.test"], repo);
  git(["config", "user.name", "Test"], repo);
  return repo;
};

let seq = 0;
const fileClaim = (path: string, sha256?: string): string =>
  JSON.stringify({
    schema: "quorum.claim/v1",
    id: `clm_base${String(++seq).padStart(8, "0")}`,
    task: "QRM-3.2",
    agent: "builder",
    type: "file_modified",
    subject: { path },
    ...(sha256 ? { expected: { sha256 } } : {}),
    stated_at: "2026-06-29T10:00:00Z",
  });

const manifest = (tierProposed: string): string =>
  JSON.stringify({
    schema: "quorum.task/v1",
    id: "QRM-3.2",
    title: "policy-from-base test",
    tier_proposed: tierProposed,
    tier_effective: null,
    acceptance: ["x"],
    branch: "feat",
    state: "in_progress",
    agents: { builder: "claude-opus-4-8" },
  });

// Base policy: floors src/secret.ts to T3 and exempts only .quorum/**.
const BASE_POLICY = JSON.stringify({
  schema: "quorum.policy/v1",
  default_floor: "T0",
  rules: [{ glob: "src/secret.ts", floor: "T3" }],
  exempt_paths: [".quorum/**"],
});
// Head policy the PR rewrites into its OWN tree: deletes the secret floor rule
// (self-lower) AND adds src/** to exempt_paths (self-exempt). Must be IGNORED.
const HEAD_POLICY_SELF_LOWER = JSON.stringify({
  schema: "quorum.policy/v1",
  default_floor: "T0",
  rules: [],
  exempt_paths: [".quorum/**", "src/**"],
});

// ── Test 1 (CORE) + Test 7 (tier default vs --policy=head) ───────────────────
// One repo: a PR that changes a T3-floored, non-exempt file AND rewrites its own
// policy to delete the floor + self-exempt. The base policy must govern both.
describe.skipIf(!haveBuild)("QRM-3.2: a self-lowering / self-exempting PR is graded by the base policy", () => {
  let repo: string;

  beforeAll(() => {
    repo = initRepo("pfb-core");
    mkdirSync(join(repo, "src"), { recursive: true });
    mkdirSync(join(repo, ".quorum/manifests"), { recursive: true });
    writeFileSync(join(repo, "src/secret.ts"), "export const secret = 'base';\n");
    writeFileSync(join(repo, ".quorum/policy.json"), BASE_POLICY);
    // tier_proposed T0 so the EFFECTIVE tier reveals the floor: base floor T3 =>
    // T3; if the head policy (rule deleted) were used the floor would be T0.
    writeFileSync(join(repo, ".quorum/manifests/QRM-3.2.json"), manifest("T0"));
    git(["add", "-A"], repo);
    git(["commit", "-m", "base: floor src/secret.ts T3"], repo);

    git(["checkout", "-b", "feat"], repo);
    writeFileSync(join(repo, "src/secret.ts"), "export const secret = 'evil';\n");
    // The PR rewrites its OWN policy to self-lower and self-exempt.
    writeFileSync(join(repo, ".quorum/policy.json"), HEAD_POLICY_SELF_LOWER);
    mkdirSync(join(repo, ".quorum/claims"), { recursive: true });
    // A bare existence claim (no content hash) for the changed secret - this must
    // NOT cover at T3 (FIX 9), and the head self-exempt must NOT apply either.
    writeFileSync(join(repo, ".quorum/claims/QRM-3.2.jsonl"), `${fileClaim("src/secret.ts")}\n`);
    git(["add", "-A"], repo);
    git(["commit", "-m", "feat: change secret + self-lower/self-exempt policy"], repo);
  });

  it("verify floors T3 from the BASE rule (head's deleted rule is ignored)", () => {
    const r = runCli(["verify", "--local", "--task", "QRM-3.2"], repo);
    expect(r.status).toBe(1); // blocks: uncovered T3 path
    expect(r.stdout).toContain("T3"); // NOT T0 - base rule binds
  });

  it("verify leaves src/secret.ts UNCOVERED (head's src/** self-exempt is ignored)", () => {
    const r = runCli(["verify", "--local", "--task", "QRM-3.2"], repo);
    expect(r.stdout).toContain("UNCOVERED");
    expect(r.stdout).toContain("src/secret.ts");
  });

  it("tier reports T3 by default (base policy)", () => {
    const r = runCli(["tier"], repo);
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe("T3");
  });

  it("tier --policy=head reads the working-tree policy (T0) and is a labeled, non-default diagnostic", () => {
    const r = runCli(["tier", "--policy=head"], repo);
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe("T0"); // head policy deleted the rule
    // The diagnostic must announce that it is NON-enforcement.
    expect(r.stderr).toContain("NON-ENFORCEMENT");
    expect(r.stderr.toLowerCase()).toContain("diagnostic");
  });
});

// ── Test 2: an ADDED floor does not bind the PR that adds it ─────────────────
describe.skipIf(!haveBuild)("QRM-3.2: a floor a PR ADDS does not bind that same PR", () => {
  let repo: string;
  // Base has NO rule for src/app.ts; default T0.
  const BASE = JSON.stringify({
    schema: "quorum.policy/v1",
    default_floor: "T0",
    rules: [],
    exempt_paths: [".quorum/**"],
  });
  // The PR tries to tighten: add a T3 rule for the very file it is changing.
  const HEAD_ADDS_FLOOR = JSON.stringify({
    schema: "quorum.policy/v1",
    default_floor: "T0",
    rules: [{ glob: "src/app.ts", floor: "T3" }],
    exempt_paths: [".quorum/**"],
  });

  beforeAll(() => {
    repo = initRepo("pfb-add");
    mkdirSync(join(repo, "src"), { recursive: true });
    mkdirSync(join(repo, ".quorum"), { recursive: true });
    writeFileSync(join(repo, "src/app.ts"), "export const app = 0;\n");
    writeFileSync(join(repo, ".quorum/policy.json"), BASE);
    git(["add", "-A"], repo);
    git(["commit", "-m", "base: no floor for src/app.ts"], repo);

    git(["checkout", "-b", "feat"], repo);
    writeFileSync(join(repo, "src/app.ts"), "export const app = 1;\n");
    writeFileSync(join(repo, ".quorum/policy.json"), HEAD_ADDS_FLOOR);
    git(["add", "-A"], repo);
    git(["commit", "-m", "feat: add a T3 floor for src/app.ts"], repo);
  });

  it("tier stays T0 - the added floor is graded against the base, so it does not bind this PR", () => {
    const r = runCli(["tier"], repo);
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe("T0"); // base default; the new rule is non-binding here
  });
});

// ── Tests 3/4/5: fail closed when the base policy is absent / malformed /
// schema-rejected. No head fallback, no permissive default. ──────────────────
describe.skipIf(!haveBuild)("QRM-3.2: verify fails closed when the base policy is unusable", () => {
  // Build a repo whose BASE commit carries `basePolicy` (or none) and a feature
  // commit with a real delta + a present (valid) head policy + claims/manifest.
  const buildRepo = (slug: string, basePolicy: string | null): string => {
    const repo = initRepo(slug);
    mkdirSync(join(repo, "src"), { recursive: true });
    mkdirSync(join(repo, ".quorum"), { recursive: true });
    writeFileSync(join(repo, "src/a.ts"), "export const a = 0;\n");
    if (basePolicy !== null) writeFileSync(join(repo, ".quorum/policy.json"), basePolicy);
    git(["add", "-A"], repo);
    git(["commit", "-m", "base"], repo);

    git(["checkout", "-b", "feat"], repo);
    writeFileSync(join(repo, "src/a.ts"), "export const a = 1;\n");
    // A perfectly valid head policy is present - it must NOT be used as a fallback.
    writeFileSync(join(repo, ".quorum/policy.json"), BASE_POLICY);
    mkdirSync(join(repo, ".quorum/manifests"), { recursive: true });
    mkdirSync(join(repo, ".quorum/claims"), { recursive: true });
    writeFileSync(join(repo, ".quorum/manifests/QRM-3.2.json"), manifest("T0"));
    writeFileSync(
      join(repo, ".quorum/claims/QRM-3.2.jsonl"),
      `${fileClaim("src/a.ts", hashOf("export const a = 1;\n"))}\n`,
    );
    git(["add", "-A"], repo);
    git(["commit", "-m", "feat"], repo);
    return repo;
  };

  it("Test 3: policy ABSENT at base => protocol error, no head fallback", () => {
    const repo = buildRepo("pfb-absent", null);
    const r = runCli(["verify", "--local", "--task", "QRM-3.2"], repo);
    expect(r.status).toBe(2); // EXIT.protocol - fail closed
    expect(r.stderr + r.stdout).toContain("policy not found");
    expect(r.stdout).not.toContain("clear"); // never passes via head fallback
  });

  it("Test 4: MALFORMED base policy (invalid JSON) => fatal protocol error", () => {
    const repo = buildRepo("pfb-malformed", "{ this is not json\n");
    const r = runCli(["verify", "--local", "--task", "QRM-3.2"], repo);
    expect(r.status).toBe(2);
    expect(r.stdout).not.toContain("clear");
  });

  it("Test 5: schema-REJECTED base policy (invalid tier) => fail-closed protocol error", () => {
    // Valid JSON, but default_floor is not a known tier - models a base policy the
    // CURRENT schema rejects (e.g. schema evolution). Failing closed is by design.
    const rejected = JSON.stringify({
      schema: "quorum.policy/v1",
      default_floor: "T9",
      rules: [],
    });
    const repo = buildRepo("pfb-schema", rejected);
    const r = runCli(["verify", "--local", "--task", "QRM-3.2"], repo);
    expect(r.status).toBe(2);
    expect(r.stdout).not.toContain("clear");
  });

  it("Test 5b: schema-evolution - an UNKNOWN extra field is rejected (strict schema), fail closed", () => {
    // A future policy with a field this schema version does not know. `.strict()`
    // rejects it; the gate must fail closed rather than silently pass.
    const evolved = JSON.stringify({
      schema: "quorum.policy/v1",
      default_floor: "T0",
      rules: [],
      future_field: { mode: "deny" },
    });
    const repo = buildRepo("pfb-evolve", evolved);
    const r = runCli(["verify", "--local", "--task", "QRM-3.2"], repo);
    expect(r.status).toBe(2);
    expect(r.stdout).not.toContain("clear");
  });
});

// ── Test 6: an empty self-delta on `main` declines BEFORE any policy read ─────
// Proven by making the base policy ABSENT: if the decline did not come first, the
// fail-closed base-policy read would turn this into a protocol error (exit 2).
describe.skipIf(!haveBuild)("QRM-3.2: empty self-delta declines before any policy read", () => {
  let repo: string;

  beforeAll(() => {
    repo = initRepo("pfb-empty");
    mkdirSync(join(repo, "src"), { recursive: true });
    mkdirSync(join(repo, ".quorum/manifests"), { recursive: true });
    mkdirSync(join(repo, ".quorum/claims"), { recursive: true });
    writeFileSync(join(repo, "src/a.ts"), "export const a = 0;\n");
    // Deliberately NO .quorum/policy.json committed anywhere: if a policy read
    // happened here it would fail closed (exit 2). The decline must precede it.
    writeFileSync(join(repo, ".quorum/manifests/QRM-3.2.json"), manifest("T0"));
    writeFileSync(join(repo, ".quorum/claims/QRM-3.2.jsonl"), `${fileClaim("src/a.ts")}\n`);
    git(["add", "-A"], repo);
    git(["commit", "-m", "init on main"], repo);
  });

  it("declines cleanly (exit 0, 'no delta') without reading the policy", () => {
    const r = runCli(["verify", "--local", "--task", "QRM-3.2"], repo);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("no delta to verify");
    expect(r.stderr).not.toContain("policy not found"); // no policy read attempted
  });
});

// ── Red-team R1: --base must NOT select a weaker policy ──────────────────────
// The exact repro: the policy ref was the --base-overridable diff base, so
// `--base <pre-tightening-commit>` graded the PR against an OLDER, WEAKER policy.
// The fix decouples them: the policy ref is the CANONICAL fork point (pinned to
// main), while --base still legitimately WIDENS the diff range.
//
//   C0 (main): weak policy (no src floor)          <- branch `oldbase` pins here
//   C1 (main): tighten policy to src/** -> T3, add src/widened.ts
//   feat (from C1): change src/a.ts, only a no-hash claim
describe.skipIf(!haveBuild)("QRM-3.2 (R1): --base widens the diff but cannot weaken the policy", () => {
  let repo: string;
  const WEAK = JSON.stringify({
    schema: "quorum.policy/v1",
    default_floor: "T0",
    rules: [],
    exempt_paths: [".quorum/**"],
  });
  const STRONG = JSON.stringify({
    schema: "quorum.policy/v1",
    default_floor: "T0",
    rules: [{ glob: "src/**", floor: "T3" }],
    exempt_paths: [".quorum/**"],
  });

  beforeAll(() => {
    repo = initRepo("pfb-r1");
    mkdirSync(join(repo, "src"), { recursive: true });
    mkdirSync(join(repo, ".quorum/manifests"), { recursive: true });
    mkdirSync(join(repo, ".quorum/claims"), { recursive: true });
    // C0 on main: weak policy. `oldbase` will pin here.
    writeFileSync(join(repo, "src/a.ts"), "export const a = 0;\n");
    writeFileSync(join(repo, ".quorum/policy.json"), WEAK);
    writeFileSync(join(repo, ".quorum/manifests/QRM-3.2.json"), manifest("T0"));
    git(["add", "-A"], repo);
    git(["commit", "-m", "C0 weak policy (no src floor)"], repo);
    git(["branch", "oldbase"], repo); // oldbase -> C0

    // C1 on main: main advances and TIGHTENS the policy + adds a file that exists
    // only from C1 onward (used to prove --base widens the diff).
    writeFileSync(join(repo, ".quorum/policy.json"), STRONG);
    writeFileSync(join(repo, "src/widened.ts"), "export const w = 1;\n");
    git(["add", "-A"], repo);
    git(["commit", "-m", "C1 tighten: src/** -> T3 + add src/widened.ts"], repo);

    // feat forks from C1 (canonical fork point) and changes src/a.ts. Only a
    // no-hash (existence) claim is provided - insufficient to cover at T3.
    git(["checkout", "-b", "feat"], repo);
    writeFileSync(join(repo, "src/a.ts"), "export const a = 99;\n");
    writeFileSync(join(repo, ".quorum/claims/QRM-3.2.jsonl"), `${fileClaim("src/a.ts")}\n`);
    git(["add", "-A"], repo);
    git(["commit", "-m", "feat: change src/a.ts"], repo);
  });

  it("default verify blocks at T3 with src/a.ts uncovered (canonical policy binds)", () => {
    const r = runCli(["verify", "--local", "--task", "QRM-3.2"], repo);
    expect(r.status).toBe(1);
    expect(r.stdout).toContain("T3");
    expect(r.stdout).toContain("UNCOVERED");
    expect(r.stdout).toContain("src/a.ts");
    // Default diff is C1..feat, so the C1-introduced file is NOT in the delta.
    expect(r.stdout).not.toContain("src/widened.ts");
  });

  it("verify --base oldbase STILL blocks at T3 with src/a.ts uncovered (bypass closed)", () => {
    const r = runCli(["verify", "--local", "--task", "QRM-3.2", "--base", "oldbase"], repo);
    expect(r.status).toBe(1); // pre-fix this cleared against the weak C0 policy
    expect(r.stdout).toContain("T3"); // policy came from the canonical fork (C1), not oldbase
    expect(r.stdout).toContain("src/a.ts");
    // Sanity: --base WIDENS the diff - a path changed only between oldbase(C0) and
    // C1 now appears in the delta, even though it did not under the default base.
    expect(r.stdout).toContain("src/widened.ts");
  });

  it("default tier is T3 and tier --base oldbase is STILL T3 (policy ref pinned to canonical)", () => {
    const def = runCli(["tier"], repo);
    expect(def.status).toBe(0);
    expect(def.stdout.trim()).toBe("T3");
    const widened = runCli(["tier", "--base", "oldbase"], repo);
    expect(widened.status).toBe(0);
    expect(widened.stdout.trim()).toBe("T3"); // weak C0 policy would have said T0
  });
});

// ── Codex P2: --diff must be rejected, not silently ignored ──────────────────
// `tier --diff <range>` previously returned output for the wrong range (graded
// mergeBase..HEAD, not the requested range). Fail closed with a protocol error.
describe.skipIf(!haveBuild)("QRM-3.2 (Codex P2): tier --diff is rejected, not silently ignored", () => {
  let repo: string;

  beforeAll(() => {
    // Minimal repo: main + one commit ahead so there IS a real HEAD~1..HEAD range.
    repo = initRepo("pfb-p2");
    mkdirSync(join(repo, "src"), { recursive: true });
    mkdirSync(join(repo, ".quorum"), { recursive: true });
    writeFileSync(join(repo, "src/a.ts"), "export const a = 0;\n");
    writeFileSync(join(repo, ".quorum/policy.json"), BASE_POLICY);
    git(["add", "-A"], repo);
    git(["commit", "-m", "base"], repo);

    git(["checkout", "-b", "feat"], repo);
    writeFileSync(join(repo, "src/a.ts"), "export const a = 1;\n");
    git(["add", "-A"], repo);
    git(["commit", "-m", "feat"], repo);
  });

  it("tier --diff <range> exits 2 (protocol error) naming --diff as unsupported", () => {
    const r = runCli(["tier", "--diff", "HEAD~1..HEAD"], repo);
    expect(r.status).toBe(2);
    expect(r.stderr + r.stdout).toMatch(/--diff/);
    // Must NOT print a tier value - reject before any computation.
    expect(r.stdout).not.toMatch(/^T[0-3]$/m);
  });

  // Codex P3: valueless --diff spellings are routed into bools by parseFlags, not
  // flags - the P2 guard must also check bools.has("diff") to reject these.
  it("tier --diff (bare, no value) exits 2 - P3 valueless spelling", () => {
    const r = runCli(["tier", "--diff"], repo);
    expect(r.status).toBe(2);
    expect(r.stderr + r.stdout).toMatch(/--diff/);
    expect(r.stdout).not.toMatch(/^T[0-3]$/m);
  });

  it("tier --diff --base main (--diff followed by a flag, so valueless) exits 2 - P3", () => {
    const r = runCli(["tier", "--diff", "--base", "main"], repo);
    expect(r.status).toBe(2);
    expect(r.stderr + r.stdout).toMatch(/--diff/);
    expect(r.stdout).not.toMatch(/^T[0-3]$/m);
  });

  it("tier (no --diff) still works correctly after the guard", () => {
    const r = runCli(["tier"], repo);
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toMatch(/^T[0-3]$/);
  });

  it("tier --base <ref> still works correctly after the guard", () => {
    const r = runCli(["tier", "--base", "main"], repo);
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toMatch(/^T[0-3]$/);
  });
});
