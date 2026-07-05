import { describe, it, expect, beforeAll } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// QRM-3.4 end-to-end: a PR that edits ONLY a file REFERENCED by a floored agent-
// config (a CLAUDE.md @import or an opencode.json instruction) must be graded at
// the referencing config's floor (T3), not the default (T0) - and `verify` and
// `tier` must AGREE, computing the floor via the one shared enforcement path.
const cliPath = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
const haveBuild = existsSync(cliPath);

interface Run {
  status: number;
  stdout: string;
  stderr: string;
}
function runCli(args: string[], cwd: string): Run {
  const r = spawnSync("node", [cliPath, ...args], { cwd, encoding: "utf8" });
  return { status: r.status ?? 1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}
const git = (args: string[], cwd: string) =>
  execFileSync("git", args, { cwd, stdio: ["ignore", "ignore", "ignore"] });
const hashOf = (content: string): string =>
  createHash("sha256").update(Buffer.from(content, "utf8")).digest("hex");

const POLICY = JSON.stringify({
  schema: "quorum.policy/v1",
  default_floor: "T0",
  rules: [
    { glob: "**/CLAUDE.md", floor: "T3", reference_extractor: "claude-md" },
    { glob: "**/opencode.json", floor: "T3", reference_extractor: "opencode-json" },
  ],
  exempt_paths: [".quorum/claims/**"],
});

const MANIFEST = JSON.stringify({
  schema: "quorum.task/v1",
  id: "QRM-REF",
  title: "reference floor test",
  tier_proposed: "T0", // T0 so the EFFECTIVE tier reveals the referenced floor
  tier_effective: null,
  acceptance: ["x"],
  branch: "feat",
  state: "in_progress",
  agents: { builder: "claude-opus-4-8" },
});

let seq = 0;
const claim = (over: Record<string, unknown>): string =>
  JSON.stringify({
    schema: "quorum.claim/v1",
    id: `clm_ref${String(++seq).padStart(9, "0")}`,
    task: "QRM-REF",
    agent: "builder",
    stated_at: "2026-07-04T00:00:00Z",
    ...over,
  });

describe.skipIf(!haveBuild)("QRM-3.4 CLI: referenced-file floor + verify/tier agreement", () => {
  let repo: string;

  beforeAll(() => {
    repo = mkdtempSync(join(tmpdir(), "quorum-ref-"));
    git(["init", "-b", "main"], repo);
    git(["config", "user.email", "t@t.test"], repo);
    git(["config", "user.name", "Test"], repo);
    mkdirSync(join(repo, "docs"), { recursive: true });
    mkdirSync(join(repo, "shared"), { recursive: true });
    mkdirSync(join(repo, "src"), { recursive: true });
    mkdirSync(join(repo, ".quorum/manifests"), { recursive: true });
    mkdirSync(join(repo, ".quorum/claims"), { recursive: true });
    // A floored CLAUDE.md that IMPORTS docs/guide.md, and an opencode.json whose
    // instructions reference shared/rules.md. Neither referenced file matches any
    // static path glob - their only floor source is the reference.
    writeFileSync(join(repo, "CLAUDE.md"), "# root memory\n@docs/guide.md\n");
    writeFileSync(join(repo, "docs/guide.md"), "# guide\n");
    writeFileSync(join(repo, "opencode.json"), JSON.stringify({ instructions: ["shared/rules.md"] }));
    writeFileSync(join(repo, "shared/rules.md"), "rules\n");
    writeFileSync(join(repo, "src/app.ts"), "export const a = 0;\n");
    writeFileSync(join(repo, ".quorum/policy.json"), POLICY);
    writeFileSync(join(repo, ".quorum/manifests/QRM-REF.json"), MANIFEST);
    git(["add", "-A"], repo);
    git(["commit", "-m", "base: floored configs + referenced files"], repo);
  });

  const onBranch = (name: string, mutate: () => void): void => {
    // -f discards any stray working-tree state from a prior branch; git prunes the
    // now-empty .quorum/claims dir on checkout, so recreate it before each mutate.
    git(["checkout", "-f", "-B", name, "main"], repo);
    mkdirSync(join(repo, ".quorum/claims"), { recursive: true });
    mutate();
    git(["add", "-A"], repo);
    git(["commit", "-m", name], repo);
  };

  it("editing ONLY a CLAUDE.md-imported file floors T3 (tier), and verify agrees", () => {
    onBranch("feat-claude", () => {
      writeFileSync(join(repo, "docs/guide.md"), "# guide edited\n");
      // Existence-only claim: at T3 it does NOT cover (FIX 9), so the path stays
      // uncovered and verify blocks - proving the reference set the T3 floor.
      writeFileSync(
        join(repo, ".quorum/claims/QRM-REF.jsonl"),
        `${claim({ type: "file_modified", subject: { path: "docs/guide.md" } })}\n`,
      );
    });
    const tier = runCli(["tier"], repo);
    const verify = runCli(["verify", "--local", "--task", "QRM-REF"], repo);
    git(["checkout", "main"], repo);

    expect(tier.status).toBe(0);
    expect(tier.stdout.trim()).toBe("T3"); // referenced floor, not default T0

    expect(verify.status).toBe(1); // blocks: uncovered T3 referenced path
    expect(verify.stdout).toContain("T3"); // AGREES with tier
    expect(verify.stdout).toContain("UNCOVERED");
    expect(verify.stdout).toContain("docs/guide.md");
  });

  it("editing ONLY an opencode-instruction file floors T3 (tier)", () => {
    onBranch("feat-opencode", () => {
      writeFileSync(join(repo, "shared/rules.md"), "rules edited\n");
      writeFileSync(
        join(repo, ".quorum/claims/QRM-REF.jsonl"),
        `${claim({ type: "file_modified", subject: { path: "shared/rules.md" } })}\n`,
      );
    });
    const tier = runCli(["tier"], repo);
    const verify = runCli(["verify", "--local", "--task", "QRM-REF"], repo);
    git(["checkout", "main"], repo);

    expect(tier.stdout.trim()).toBe("T3");
    expect(verify.stdout).toContain("T3");
    expect(verify.stdout).toContain("shared/rules.md");
  });

  it("a content-verified claim on the referenced file CLEARS (no over-blocking)", () => {
    const edited = "# guide covered\n";
    onBranch("feat-covered", () => {
      writeFileSync(join(repo, "docs/guide.md"), edited);
      writeFileSync(
        join(repo, ".quorum/claims/QRM-REF.jsonl"),
        `${claim({ type: "file_modified", subject: { path: "docs/guide.md" }, expected: { sha256: hashOf(edited) } })}\n`,
      );
    });
    const verify = runCli(["verify", "--local", "--task", "QRM-REF"], repo);
    git(["checkout", "main"], repo);
    expect(verify.status).toBe(0); // content claim covers the T3 referenced path
    expect(verify.stdout).toContain("clear");
  });

  it("editing an UNREFERENCED, unfloored file stays T0 (no over-broad flooring)", () => {
    onBranch("feat-plain", () => {
      writeFileSync(join(repo, "src/app.ts"), "export const a = 1;\n");
    });
    const tier = runCli(["tier"], repo);
    git(["checkout", "main"], repo);
    expect(tier.stdout.trim()).toBe("T0");
  });
});

// ── Fail-closed: a floored config with an absolute/home reference BLOCKS ───────
describe.skipIf(!haveBuild)("QRM-3.4 CLI: an absolute/home reference fails closed (verify AND tier block)", () => {
  let repo: string;

  beforeAll(() => {
    repo = mkdtempSync(join(tmpdir(), "quorum-refblock-"));
    git(["init", "-b", "main"], repo);
    git(["config", "user.email", "t@t.test"], repo);
    git(["config", "user.name", "Test"], repo);
    mkdirSync(join(repo, "src"), { recursive: true });
    mkdirSync(join(repo, ".quorum/manifests"), { recursive: true });
    mkdirSync(join(repo, ".quorum/claims"), { recursive: true });
    // A floored CLAUDE.md whose @import is a ~-home path: its repo-relative target
    // is not derivable from committed bytes -> hard block (fail closed).
    writeFileSync(join(repo, "CLAUDE.md"), "@~/secret.md\n");
    writeFileSync(join(repo, "src/app.ts"), "export const a = 0;\n");
    writeFileSync(join(repo, ".quorum/policy.json"), POLICY);
    writeFileSync(join(repo, ".quorum/manifests/QRM-REF.json"), MANIFEST);
    git(["add", "-A"], repo);
    git(["commit", "-m", "base: CLAUDE.md with a ~-home import"], repo);

    git(["checkout", "-b", "feat"], repo);
    writeFileSync(join(repo, "src/app.ts"), "export const a = 1;\n");
    writeFileSync(
      join(repo, ".quorum/claims/QRM-REF.jsonl"),
      `${claim({ type: "file_modified", subject: { path: "src/app.ts" } })}\n`,
    );
    git(["add", "-A"], repo);
    git(["commit", "-m", "feat: edit an ordinary file"], repo);
  });

  it("tier blocks (exit 2) with an actionable diagnostic", () => {
    const r = runCli(["tier"], repo);
    expect(r.status).toBe(2);
    const out = r.stderr + r.stdout;
    expect(out).toContain("fail-closed");
    expect(out).toContain("home");
    expect(out).toContain("@~/secret.md");
    expect(out).toContain("CLAUDE.md");
    expect(out).not.toMatch(/^T[0-3]$/m); // never prints a tier value
  });

  it("verify blocks (exit 2) with the same fail-closed diagnostic", () => {
    const r = runCli(["verify", "--local", "--task", "QRM-REF"], repo);
    expect(r.status).toBe(2);
    const out = r.stderr + r.stdout;
    expect(out).toContain("fail-closed");
    expect(out).toContain("@~/secret.md");
  });
});
