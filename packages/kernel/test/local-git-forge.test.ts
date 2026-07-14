import { describe, it, expect, beforeAll } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalGitForge } from "../src/forge/local-git.js";

// The raw-diff parse matrix (rename-aware, mode-bearing, NUL-delimited, fail
// closed) lives in diff.test.ts. This file covers the LocalGitForge integration.

describe("LocalGitForge - blob requirement (FIX 2) and in-delta commits (FIX 3)", () => {
  let repo: string;
  let baseSha: string; // C0, on main (the merge-base)
  let deltaSha: string; // C1, on the feature branch (in mergeBase..head)

  const git = (args: string[], cwd: string): string =>
    execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();

  beforeAll(() => {
    repo = mkdtempSync(join(tmpdir(), "quorum-localgit-"));
    git(["init", "-b", "main"], repo);
    git(["config", "user.email", "t@t.test"], repo);
    git(["config", "user.name", "Test"], repo);
    mkdirSync(join(repo, "src"), { recursive: true });
    writeFileSync(join(repo, "src/base.ts"), "base\n");
    git(["add", "-A"], repo);
    git(["commit", "-m", "C0 base"], repo);
    baseSha = git(["rev-parse", "HEAD"], repo);

    git(["checkout", "-b", "feat"], repo);
    writeFileSync(join(repo, "src/feature.ts"), "feature\n");
    git(["add", "-A"], repo);
    git(["commit", "-m", "C1 feature"], repo);
    deltaSha = git(["rev-parse", "HEAD"], repo);
  });

  it("FIX 2: a directory (tree) path does not verify a file claim", async () => {
    const forge = new LocalGitForge({ cwd: repo, head: "HEAD" });
    expect((await forge.getFile("HEAD", "src")).kind).toBe("absent"); // tree, not blob
    expect((await forge.getFile("HEAD", "src/feature.ts")).kind).toBe("ok"); // real blob
  });

  it("FIX 3: an ancestor/base commit is NOT in-delta (fails)", async () => {
    const forge = new LocalGitForge({ cwd: repo, head: deltaSha, mergeBase: baseSha });
    expect((await forge.resolveCommit(baseSha)).kind).toBe("absent");
  });

  it("FIX 3: an in-delta commit verifies", async () => {
    const forge = new LocalGitForge({ cwd: repo, head: deltaSha, mergeBase: baseSha });
    expect((await forge.resolveCommit(deltaSha)).kind).toBe("ok");
  });

  it("FIX 3: a fabricated SHA still fails", async () => {
    const forge = new LocalGitForge({ cwd: repo, head: deltaSha, mergeBase: baseSha });
    expect((await forge.resolveCommit("deadbeefdeadbeefdeadbeefdeadbeefdeadbeef")).kind).toBe("absent");
  });

  // QRM-4.0-branch-freshness [2], design §3.1: resolveRefCommit resolves a ref to
  // its certified 40-hex tip commit sha (the local analog of GitHubForge's
  // getCommit-based resolver). Honest for plain git - NOT `unsupported`.
  it("resolveRefCommit resolves a branch to its certified 40-hex tip commit sha", async () => {
    const forge = new LocalGitForge({ cwd: repo, head: "HEAD" });
    const onMain = await forge.resolveRefCommit("main");
    expect(onMain).toEqual({ kind: "ok", value: baseSha }); // main's tip is C0
    const onFeat = await forge.resolveRefCommit("feat");
    expect(onFeat).toEqual({ kind: "ok", value: deltaSha }); // feat's tip is C1
    if (onMain.kind === "ok") expect(/^[0-9a-f]{40}$/.test(onMain.value)).toBe(true);
  });

  it("resolveRefCommit returns absent for an unresolvable ref (bad ref never freshness)", async () => {
    const forge = new LocalGitForge({ cwd: repo, head: "HEAD" });
    expect((await forge.resolveRefCommit("no-such-branch")).kind).toBe("absent");
  });
});
