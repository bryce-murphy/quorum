import { describe, it, expect, beforeAll } from "vitest";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const hashOf = (content: string): string =>
  createHash("sha256").update(Buffer.from(content, "utf8")).digest("hex");

// End-to-end repro of the red-team's headline gap: a clean ledger covering a
// malicious change. The verifier must verify the CHANGE (FIX 1), so an unclaimed
// changed path blocks strict mode even when every present claim verifies.
const cliPath = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
const haveBuild = existsSync(cliPath);

interface Run {
  status: number;
  stdout: string;
}
function runCli(args: string[], cwd: string): Run {
  try {
    const stdout = execFileSync("node", [cliPath, ...args], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    return { status: 0, stdout };
  } catch (e) {
    const err = e as { status?: number; stdout?: Buffer | string };
    return { status: err.status ?? 1, stdout: err.stdout?.toString() ?? "" };
  }
}
const git = (args: string[], cwd: string) => execFileSync("git", args, { cwd, stdio: ["ignore", "ignore", "ignore"] });

let seq = 0;
const claim = (path: string, sha256?: string): string =>
  JSON.stringify({
    schema: "quorum.claim/v1",
    id: `clm_cov${String(++seq).padStart(9, "0")}`,
    task: "QRM-C",
    agent: "builder",
    type: "file_created",
    subject: { path },
    ...(sha256 ? { expected: { sha256 } } : {}),
    stated_at: "2026-06-13T10:00:00Z",
  });

const POLICY = JSON.stringify({
  schema: "quorum.policy/v1",
  default_floor: "T0",
  rules: [{ glob: "schemas/**", floor: "T3" }],
  exempt_paths: [".quorum/**"],
});
const MANIFEST = JSON.stringify({
  schema: "quorum.task/v1",
  id: "QRM-C",
  title: "coverage repro",
  tier_proposed: "T1",
  tier_effective: null,
  acceptance: ["x"],
  branch: "feat",
  state: "in_progress",
  agents: { builder: "claude-opus-4-8" },
});

describe.skipIf(!haveBuild)("quorum verify - diff coverage (FIX 1)", () => {
  let repo: string;
  const claimsFile = () => join(repo, ".quorum/claims/QRM-C.jsonl");
  const writeClaims = (paths: string[]) => writeFileSync(claimsFile(), paths.map((p) => claim(p)).join("\n") + "\n");
  const writeClaimsRaw = (lines: string[]) => writeFileSync(claimsFile(), lines.join("\n") + "\n");

  // Content written into the feature commit (must match for hashed claims).
  const CONTENT: Record<string, string> = {
    "src/app.ts": "export const app = 1;\n",
    "src/backdoor.ts": "export const evil = 1;\n",
    "schemas/evil.schema.json": "{}\n",
  };
  const hashedClaim = (p: string) => claim(p, hashOf(CONTENT[p]!));

  beforeAll(() => {
    repo = mkdtempSync(join(tmpdir(), "quorum-cov-"));
    git(["init", "-b", "main"], repo);
    git(["config", "user.email", "t@t.test"], repo);
    git(["config", "user.name", "Test"], repo);
    writeFileSync(join(repo, "README.md"), "base\n");
    git(["add", "-A"], repo);
    git(["commit", "-m", "base"], repo);

    git(["checkout", "-b", "feat"], repo);
    mkdirSync(join(repo, "src"), { recursive: true });
    mkdirSync(join(repo, "schemas"), { recursive: true });
    mkdirSync(join(repo, ".quorum/claims"), { recursive: true });
    mkdirSync(join(repo, ".quorum/manifests"), { recursive: true });
    writeFileSync(join(repo, "src/app.ts"), "export const app = 1;\n");
    writeFileSync(join(repo, "src/backdoor.ts"), "export const evil = 1;\n");
    writeFileSync(join(repo, "schemas/evil.schema.json"), "{}\n");
    writeFileSync(join(repo, ".quorum/policy.json"), POLICY);
    writeFileSync(join(repo, ".quorum/manifests/QRM-C.json"), MANIFEST);
    writeClaims(["src/app.ts"]); // placeholder; rewritten per test
    git(["add", "-A"], repo);
    git(["commit", "-m", "feature"], repo);
  });

  it("blocks: an unclaimed src/backdoor.ts (clean claims can't cover a hidden change)", () => {
    writeClaims(["src/app.ts", "schemas/evil.schema.json"]); // backdoor.ts NOT claimed
    const r = runCli(["verify", "--local", "--task", "QRM-C"], repo);
    expect(r.status).toBe(1);
    expect(r.stdout).toContain("UNCOVERED");
    expect(r.stdout).toContain("src/backdoor.ts");
  });

  it("blocks at T3: an unclaimed schemas/evil.schema.json", () => {
    writeClaims(["src/app.ts", "src/backdoor.ts"]); // evil schema NOT claimed
    const r = runCli(["verify", "--local", "--task", "QRM-C"], repo);
    expect(r.status).toBe(1);
    expect(r.stdout).toContain("T3");
    expect(r.stdout).toContain("schemas/evil.schema.json");
  });

  // FIX 9 - at T3 existence-only is not enough: content-hash-checked claims are
  // required to cover. No-hash claims over every path still BLOCK at T3.
  it("blocks at T3: verified_exists (no-hash) claims do not cover", () => {
    writeClaims(["src/app.ts", "src/backdoor.ts", "schemas/evil.schema.json"]);
    const r = runCli(["verify", "--local", "--task", "QRM-C"], repo);
    expect(r.status).toBe(1);
    expect(r.stdout).toContain("UNCOVERED");
  });

  it("passes at T3 only when every changed path is content-verified", () => {
    writeClaimsRaw(["src/app.ts", "src/backdoor.ts", "schemas/evil.schema.json"].map(hashedClaim));
    const r = runCli(["verify", "--local", "--task", "QRM-C"], repo);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("clear");
    expect(r.stdout).toContain("T3");
  });
});

// FIX 10 - a rename must not hide a floored source path. Renaming a file away
// from schemas/** still floors T3 (the old path counts).
describe.skipIf(!haveBuild)("quorum tier - rename-aware floor (FIX 10)", () => {
  let repo: string;

  beforeAll(() => {
    repo = mkdtempSync(join(tmpdir(), "quorum-rename-"));
    git(["init", "-b", "main"], repo);
    git(["config", "user.email", "t@t.test"], repo);
    git(["config", "user.name", "Test"], repo);
    mkdirSync(join(repo, "schemas"), { recursive: true });
    mkdirSync(join(repo, ".quorum"), { recursive: true });
    writeFileSync(join(repo, ".quorum/policy.json"), POLICY);
    writeFileSync(join(repo, "schemas/x.schema.json"), "{}\n");
    git(["add", "-A"], repo);
    git(["commit", "-m", "base"], repo);

    git(["checkout", "-b", "feat"], repo);
    mkdirSync(join(repo, "docs"), { recursive: true });
    git(["mv", "schemas/x.schema.json", "docs/x.schema.json"], repo);
    git(["commit", "-m", "rename schema out of schemas/"], repo);
  });

  it("floors T3 from the renamed-away schemas/** path", () => {
    const r = runCli(["tier", "--diff", "main..HEAD"], repo);
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe("T3");
  });
});
