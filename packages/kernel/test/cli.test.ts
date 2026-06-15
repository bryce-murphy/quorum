import { describe, it, expect, beforeAll } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, mkdirSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// Exercises the compiled CLI end-to-end. Requires `npm run build` first (CI runs
// build before test); skips with a clear signal if dist is missing.
const cliPath = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
const haveBuild = existsSync(cliPath);

interface Run {
  status: number;
  stdout: string;
  stderr: string;
}

function runCli(args: string[], cwd: string): Run {
  try {
    const stdout = execFileSync("node", [cliPath, ...args], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { status: 0, stdout, stderr: "" };
  } catch (e) {
    const err = e as { status?: number; stdout?: Buffer | string; stderr?: Buffer | string };
    return {
      status: err.status ?? 1,
      stdout: err.stdout?.toString() ?? "",
      stderr: err.stderr?.toString() ?? "",
    };
  }
}

function git(args: string[], cwd: string): void {
  execFileSync("git", args, { cwd, stdio: ["ignore", "ignore", "ignore"] });
}

function gitS(args: string[], cwd: string): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
}

const claim = (over: Record<string, unknown>): string =>
  JSON.stringify({
    schema: "quorum.claim/v1",
    id: "clm_000000000001",
    task: "QRM-T",
    agent: "builder",
    stated_at: "2026-06-12T03:14:00Z",
    ...over,
  });

const POLICY = JSON.stringify({
  schema: "quorum.policy/v1",
  default_floor: "T0",
  rules: [{ glob: "schemas/**", floor: "T3" }],
});

const manifest = (id: string): string =>
  JSON.stringify({
    schema: "quorum.task/v1",
    id,
    title: "test",
    tier_proposed: "T1",
    tier_effective: null,
    acceptance: ["x"],
    branch: "main",
    state: "in_progress",
    agents: { builder: "claude-opus-4-8" },
  });

describe.skipIf(!haveBuild)("quorum CLI", () => {
  let repo: string;

  beforeAll(() => {
    repo = mkdtempSync(join(tmpdir(), "quorum-cli-"));
    git(["init", "-b", "main"], repo);
    git(["config", "user.email", "t@t.test"], repo);
    git(["config", "user.name", "Test"], repo);
    mkdirSync(join(repo, "src"), { recursive: true });
    writeFileSync(join(repo, "src/a.ts"), "hello\n");
    git(["add", "-A"], repo);
    git(["commit", "-m", "init"], repo);

    mkdirSync(join(repo, ".quorum/claims"), { recursive: true });
    mkdirSync(join(repo, ".quorum/manifests"), { recursive: true });
    writeFileSync(join(repo, ".quorum/policy.json"), POLICY);
    writeFileSync(join(repo, ".quorum/manifests/QRM-T.json"), manifest("QRM-T"));
  });

  it("exit 0: empty self-delta (HEAD == merge-base) declines cleanly instead of failing", () => {
    // A branch-delta-scoped claim that WOULD resolve to `failed` on an empty
    // range if verification ran. The repo HEAD sits on `main` with no feature
    // branch, so merge-base(HEAD, main) == HEAD: the M2.1 empty-delta case.
    writeFileSync(
      join(repo, ".quorum/claims/QRM-T.jsonl"),
      `${claim({ type: "file_modified", subject: { path: "src/a.ts" } })}\n`,
    );
    const r = runCli(["verify", "--local", "--task", "QRM-T"], repo);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("no delta to verify");
    expect(r.stdout).not.toContain("FAILED");
  });

  it("exit 0: a truthful claim verifies clean (real delta vs main)", () => {
    git(["checkout", "-B", "feat-ok", "main"], repo);
    writeFileSync(join(repo, "src/created.ts"), "export const c = 1;\n");
    git(["add", "src/created.ts"], repo);
    git(["commit", "-m", "add created.ts"], repo);
    writeFileSync(
      join(repo, ".quorum/claims/QRM-T.jsonl"),
      `${claim({ type: "file_created", subject: { path: "src/created.ts" } })}\n`,
    );
    const r = runCli(["verify", "--local", "--task", "QRM-T"], repo);
    git(["checkout", "main"], repo); // restore shared fixture state
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("verified");
  });

  it("exit 1: a fabricated claim blocks (file does not exist at head)", () => {
    git(["checkout", "-B", "feat-bad", "main"], repo);
    writeFileSync(join(repo, "src/real.ts"), "export const r = 1;\n");
    git(["add", "src/real.ts"], repo);
    git(["commit", "-m", "add real.ts"], repo);
    // Cover the real change truthfully, then assert a fabricated creation too:
    // the verdict must block on the fabricated claim, not on coverage.
    writeFileSync(
      join(repo, ".quorum/claims/QRM-T.jsonl"),
      `${claim({ type: "file_created", subject: { path: "src/real.ts" } })}\n` +
        `${claim({ id: "clm_000000000002", type: "file_created", subject: { path: "src/ghost.ts" } })}\n`,
    );
    const r = runCli(["verify", "--local", "--task", "QRM-T"], repo);
    git(["checkout", "main"], repo);
    expect(r.status).toBe(1);
    expect(r.stdout).toContain("FAILED");
  });

  it("exit 2: a malformed claims file is a protocol error", () => {
    writeFileSync(join(repo, ".quorum/claims/QRM-T.jsonl"), "{ not json\n");
    const r = runCli(["verify", "--local", "--task", "QRM-T"], repo);
    expect(r.status).toBe(2);
  });

  it("tier --diff resolves schemas/** to T3 (pure-local, no token)", () => {
    mkdirSync(join(repo, "schemas"), { recursive: true });
    writeFileSync(join(repo, "schemas/x.json"), "{}\n");
    git(["add", "-A"], repo);
    git(["commit", "-m", "add schema"], repo);
    const r = runCli(["tier", "--diff", "HEAD~1..HEAD"], repo);
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe("T3");
  });

  it("validate: ok artifact exits 0, malformed exits 1", () => {
    const okFile = join(repo, "ok.claim.json");
    writeFileSync(okFile, claim({ type: "file_created", subject: { path: "src/a.ts" } }));
    expect(runCli(["validate", okFile], repo).status).toBe(0);

    const badFile = join(repo, "bad.claim.json");
    writeFileSync(badFile, claim({ type: "commit_pushed", subject: { path: "wrong" } }));
    expect(runCli(["validate", badFile], repo).status).toBe(1);
  });
});

// FIX 7 - an unresolvable merge-base must REFUSE to run (exit 2), never fall back
// to HEAD and pass over an empty delta.
describe.skipIf(!haveBuild)("quorum verify - merge-base resolution (FIX 7)", () => {
  let repo: string;

  beforeAll(() => {
    repo = mkdtempSync(join(tmpdir(), "quorum-base-"));
    git(["init", "-b", "trunk"], repo); // NO `main` branch exists
    git(["config", "user.email", "t@t.test"], repo);
    git(["config", "user.name", "Test"], repo);
    mkdirSync(join(repo, "src"), { recursive: true });
    writeFileSync(join(repo, "src/a.ts"), "hello\n");
    mkdirSync(join(repo, ".quorum/claims"), { recursive: true });
    mkdirSync(join(repo, ".quorum/manifests"), { recursive: true });
    writeFileSync(join(repo, ".quorum/policy.json"), POLICY);
    writeFileSync(join(repo, ".quorum/manifests/QRM-T.json"), manifest("QRM-T"));
    writeFileSync(
      join(repo, ".quorum/claims/QRM-T.jsonl"),
      `${claim({ type: "file_created", subject: { path: "src/a.ts" } })}\n`,
    );
    git(["add", "-A"], repo);
    git(["commit", "-m", "init (ancestor)"], repo);
    // A second commit so trunk~1 is a real ancestor to supply as --base.
    writeFileSync(join(repo, "src/b.ts"), "world\n");
    git(["add", "-A"], repo);
    git(["commit", "-m", "second"], repo);
  });

  it("exit 2: default base 'main' absent and no --base => refuse to run", () => {
    const r = runCli(["verify", "--local", "--task", "QRM-T"], repo);
    expect(r.status).toBe(2);
  });

  // FIX 13: with no `main` anchor, even an ancestor --base is refused - there is
  // no trusted fork point to guard against carving. (M3's Gate supplies an
  // authenticated PR base; Phase 1 --local fails closed.)
  it("exit 2: an explicit --base without a 'main' anchor is refused", () => {
    const r = runCli(["verify", "--local", "--task", "QRM-T", "--base", "trunk~1"], repo);
    expect(r.status).toBe(2);
  });
});

// FIX 8 - an attacker-supplied --base must be a TRUE ancestor of HEAD. A base
// that equals HEAD, is a descendant/sibling, or an unrelated orphan would shrink
// or forge the delta and let an unverified change ride in => refuse (exit 2).
describe.skipIf(!haveBuild)("quorum verify - --base ancestor validation (FIX 8)", () => {
  let repo: string;
  const POLICY_EXEMPT = JSON.stringify({
    schema: "quorum.policy/v1",
    default_floor: "T0",
    rules: [{ glob: "schemas/**", floor: "T3" }],
    exempt_paths: [".quorum/**"],
  });

  beforeAll(() => {
    repo = mkdtempSync(join(tmpdir(), "quorum-base8-"));
    git(["init", "-b", "main"], repo);
    git(["config", "user.email", "t@t.test"], repo);
    git(["config", "user.name", "Test"], repo);
    mkdirSync(join(repo, "src"), { recursive: true });
    writeFileSync(join(repo, "src/a.ts"), "export const a = 1;\n");
    git(["add", "-A"], repo);
    git(["commit", "-m", "base (ancestor)"], repo); // main = true ancestor

    git(["checkout", "-b", "feat"], repo);
    writeFileSync(join(repo, "src/b.ts"), "export const b = 1;\n");
    mkdirSync(join(repo, ".quorum/claims"), { recursive: true });
    mkdirSync(join(repo, ".quorum/manifests"), { recursive: true });
    writeFileSync(join(repo, ".quorum/policy.json"), POLICY_EXEMPT);
    writeFileSync(join(repo, ".quorum/manifests/QRM-T.json"), manifest("QRM-T"));
    writeFileSync(
      join(repo, ".quorum/claims/QRM-T.jsonl"),
      `${claim({ type: "file_created", subject: { path: "src/b.ts" } })}\n`,
    );
    git(["add", "-A"], repo);
    git(["commit", "-m", "feature (HEAD)"], repo);

    // An unrelated orphan with no common ancestor (identical-ish tree).
    git(["checkout", "--orphan", "orphan"], repo);
    git(["add", "-A"], repo);
    git(["commit", "-m", "orphan"], repo);
    git(["checkout", "feat"], repo);
  });

  it("exit 2: --base HEAD (empty delta)", () => {
    expect(runCli(["verify", "--local", "--task", "QRM-T", "--base", "HEAD"], repo).status).toBe(2);
  });

  it("exit 2: --base on an unrelated orphan (no common ancestor)", () => {
    expect(runCli(["verify", "--local", "--task", "QRM-T", "--base", "orphan"], repo).status).toBe(2);
  });

  it("a legitimate ancestor --base is accepted (not refused)", () => {
    const r = runCli(["verify", "--local", "--task", "QRM-T", "--base", "main"], repo);
    expect(r.status).not.toBe(2);
  });

  it("normal run with main present (no --base) is unchanged", () => {
    const r = runCli(["verify", "--local", "--task", "QRM-T"], repo);
    expect(r.status).not.toBe(2);
  });
});

// FIX 13 - the carving guard must not silently disable when `main` is absent.
// Repro: no main; bad change in C1; HEAD (C2) clean; attacker passes --base C1
// to carve C1 out of the delta. Without an anchor, the kernel must REFUSE.
describe.skipIf(!haveBuild)("quorum verify - unanchored --base carving (FIX 13)", () => {
  let repo: string;
  let c1: string;

  beforeAll(() => {
    repo = mkdtempSync(join(tmpdir(), "quorum-noanchor-"));
    git(["init", "-b", "work"], repo); // deliberately NOT main
    git(["config", "user.email", "t@t.test"], repo);
    git(["config", "user.name", "Test"], repo);
    writeFileSync(join(repo, "README.md"), "c0\n");
    git(["add", "-A"], repo);
    git(["commit", "-m", "C0"], repo);

    mkdirSync(join(repo, "schemas"), { recursive: true });
    mkdirSync(join(repo, ".quorum/claims"), { recursive: true });
    mkdirSync(join(repo, ".quorum/manifests"), { recursive: true });
    writeFileSync(join(repo, ".quorum/policy.json"), POLICY);
    writeFileSync(join(repo, ".quorum/manifests/QRM-T.json"), manifest("QRM-T"));
    writeFileSync(join(repo, ".quorum/claims/QRM-T.jsonl"), `${claim({ type: "file_created", subject: { path: "README.md" } })}\n`);
    writeFileSync(join(repo, "schemas/evil.schema.json"), "{}\n"); // malicious
    git(["add", "-A"], repo);
    git(["commit", "-m", "C1 malicious"], repo);
    c1 = gitS(["rev-parse", "HEAD"], repo);

    writeFileSync(join(repo, "README.md"), "c2\n"); // clean head
    git(["add", "-A"], repo);
    git(["commit", "-m", "C2"], repo);
  });

  it("refuses an unanchored --base (no main) instead of carving (exit 2)", () => {
    const r = runCli(["verify", "--local", "--task", "QRM-T", "--base", c1], repo);
    expect(r.status).toBe(2);
    expect(r.stdout).not.toContain("clear");
  });
});
