import { describe, it, expect, beforeAll } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalGitForge, parseNameStatus } from "../src/forge/local-git.js";

// FIX 10 + FIX 12 - NUL-delimited (-z) records; rename/copy carry old + new.
const NUL = String.fromCharCode(0);
const z = (...tokens: string[]) => tokens.join(NUL) + NUL;

describe("parseNameStatus (rename-aware, NUL-delimited)", () => {
  it("includes both old and new paths for a rename", () => {
    const out = z("A", "src/new.ts", "M", "src/edited.ts", "R100", "schemas/x.json", "docs/x.json");
    expect(parseNameStatus(out)).toEqual([
      "src/new.ts",
      "src/edited.ts",
      "schemas/x.json",
      "docs/x.json",
    ]);
  });

  it("handles deletes and copies", () => {
    const out = z("D", "old.ts", "C75", "a.ts", "b.ts");
    expect(parseNameStatus(out)).toEqual(["old.ts", "a.ts", "b.ts"]);
  });

  it("keeps non-ASCII paths intact (no C-quoting / mis-split)", () => {
    const cafe = `schemas/caf${String.fromCharCode(0xe9)}.schema.json`; // U+00E9
    const out = z("A", cafe);
    expect(parseNameStatus(out)).toEqual([cafe]);
  });
});

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
});
