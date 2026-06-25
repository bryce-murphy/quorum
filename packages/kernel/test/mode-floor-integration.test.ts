import { describe, it, expect, beforeAll } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Policy } from "@quorum/contracts";
import { LocalGitForge } from "../src/forge/local-git.js";
import { computeTierFloor } from "../src/tier/floor.js";
import { parseRawDiff, changedPaths } from "../src/diff.js";
import { verifyClaim } from "../src/verify/index.js";
import { computeUncoveredPaths } from "../src/gate.js";
import { sha256 } from "../src/hash.js";
import { mkClaim } from "./fixtures/amas.js";

// End-to-end against REAL git objects. Symlinks and gitlinks are constructed via
// plumbing (update-index --cacheinfo) so the test is OS-independent - it does not
// rely on filesystem symlink support, only on git's stored object mode.
const SYMLINK_TARGET = "../../some/other/secret"; // the bytes a symlink blob holds
const SYMLINK_PATH = "packages/app/.codex"; // arbitrary path: NO policy glob matches it
const GITLINK_PATH = "vendor/dep";
// QRM-3.1 P1: a MALFORMED gitlink - mode 160000 but its recorded sha points at a
// real BLOB. cat-file -t would answer "blob" and (pre-fix) spuriously cover it.
const BLOBLINK_PATH = "vendor/bloblink";

// Minimal policy: nothing here path-matches the symlink/gitlink paths, so a T3
// result is the MODE floor, not a glob.
const policy: Policy = {
  schema: "quorum.policy/v1",
  default_floor: "T0",
  rules: [{ glob: "schemas/**", floor: "T3" }],
};

const git = (args: string[], cwd: string, input?: string): string =>
  execFileSync("git", args, {
    cwd,
    input,
    encoding: "utf8",
    stdio: ["pipe", "pipe", "ignore"],
  }).trim();

describe("mode-aware floor - end to end against real git (QRM-3.1)", () => {
  let repo: string;
  let baseSha: string;
  let headSha: string;
  let symlinkBlobSha256: string;

  beforeAll(() => {
    repo = mkdtempSync(join(tmpdir(), "quorum-modefloor-"));
    git(["init", "-b", "main"], repo);
    git(["config", "user.email", "t@t.test"], repo);
    git(["config", "user.name", "Test"], repo);
    git(["config", "core.autocrlf", "false"], repo);
    mkdirSync(join(repo, "src"), { recursive: true });
    writeFileSync(join(repo, "src/base.ts"), "base\n");
    git(["add", "-A"], repo);
    git(["commit", "-m", "C0 base"], repo);
    baseSha = git(["rev-parse", "HEAD"], repo);

    git(["checkout", "-b", "feat"], repo);
    // An ordinary changed file alongside the indirections.
    writeFileSync(join(repo, "src/feature.ts"), "feature\n");
    git(["add", "src/feature.ts"], repo);
    // Symlink: a 120000 blob whose content is the literal target string. We hash
    // the target bytes ourselves to know the expected content hash.
    const blob = git(["hash-object", "-w", "--stdin"], repo, SYMLINK_TARGET);
    symlinkBlobSha256 = sha256(Buffer.from(SYMLINK_TARGET, "utf8"));
    git(["update-index", "--add", "--cacheinfo", `120000,${blob},${SYMLINK_PATH}`], repo);
    // Gitlink: a 160000 entry pointing at a commit (reuse baseSha as the pointer).
    git(["update-index", "--add", "--cacheinfo", `160000,${baseSha},${GITLINK_PATH}`], repo);
    // Malformed gitlink: mode 160000 but pointing at a BLOB (the symlink blob).
    // `cat-file -t` resolves this to "blob"; only the TREE MODE exposes it.
    git(["update-index", "--add", "--cacheinfo", `160000,${blob},${BLOBLINK_PATH}`], repo);
    git(["commit", "-m", "C1 symlink + gitlink + bloblink + ordinary"], repo);
    headSha = git(["rev-parse", "HEAD"], repo);
  });

  const compareEntries = async () => {
    const forge = new LocalGitForge({ cwd: repo, head: headSha, mergeBase: baseSha });
    const cmp = await forge.compare(baseSha, headSha);
    if (cmp.kind !== "ok") throw new Error("compare did not resolve ok");
    return cmp.value.changedPaths;
  };

  it("LocalGitForge.compare surfaces the symlink (120000) and gitlink (160000) modes", async () => {
    const entries = await compareEntries();
    const link = entries.find((e) => e.path === SYMLINK_PATH);
    const sub = entries.find((e) => e.path === GITLINK_PATH);
    expect(link?.newMode).toBe("120000");
    expect(sub?.newMode).toBe("160000");
  });

  it("floors the diff to T3 although NO path glob matches the symlink/gitlink paths", async () => {
    expect(computeTierFloor(await compareEntries(), policy)).toBe("T3");
  });

  // Matrix #8: the CLI raw-exec path and the forge path parse the SAME git output
  // into the SAME changed-path set.
  it("the CLI diff exec and LocalGitForge.compare yield identical changed-path sets", async () => {
    const rawOut = execFileSync("git", ["diff", "--raw", "-M", "-z", `${baseSha}..${headSha}`], {
      cwd: repo,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    const cliPaths = changedPaths(parseRawDiff(rawOut)).sort();
    const forgePaths = changedPaths(await compareEntries()).sort();
    expect(cliPaths).toEqual(forgePaths);
    expect(forgePaths).toContain(SYMLINK_PATH);
    expect(forgePaths).toContain(GITLINK_PATH);
  });

  // COVERAGE - symlinks: getFile reads the blob (the target string) with no
  // dereference, so a content-hash claim over the target bytes verifies at T3.
  it("a symlink claim WITH a matching sha256 covers at T3", async () => {
    const forge = new LocalGitForge({ cwd: repo, head: headSha, mergeBase: baseSha });
    const ctx = { head: headSha, mergeBase: baseSha };
    const claim = mkClaim({
      type: "file_created",
      subject: { path: SYMLINK_PATH },
      expected: { sha256: symlinkBlobSha256 },
    });
    const result = await verifyClaim(claim, forge, ctx);
    expect(result.status).toBe("verified");
    const uncovered = computeUncoveredPaths([claim], [result], [SYMLINK_PATH], [], "T3");
    expect(uncovered).not.toContain(SYMLINK_PATH);
  });

  // COVERAGE - symlinks (b): existence-only is INSUFFICIENT at T2+ (FIX 9). A
  // symlink claim with no expected hash resolves verified_exists and stays uncovered.
  it("a symlink claim WITHOUT an expected hash does NOT cover at T3", async () => {
    const forge = new LocalGitForge({ cwd: repo, head: headSha, mergeBase: baseSha });
    const ctx = { head: headSha, mergeBase: baseSha };
    const claim = mkClaim({ type: "file_created", subject: { path: SYMLINK_PATH } });
    const result = await verifyClaim(claim, forge, ctx);
    expect(result.status).toBe("verified_exists");
    const uncovered = computeUncoveredPaths([claim], [result], [SYMLINK_PATH], [], "T3");
    expect(uncovered).toContain(SYMLINK_PATH);
  });

  // COVERAGE - gitlinks: a 160000 entry has no blob, so a content claim cannot be
  // satisfied (getFile is absent) -> reported uncovered -> blocks. Intentional
  // fail-closed: a submodule change is unmergeable under strict mode until a
  // future gitlink_changed claim type exists.
  it("a gitlink cannot satisfy a content claim and stays uncovered (fail closed)", async () => {
    const forge = new LocalGitForge({ cwd: repo, head: headSha, mergeBase: baseSha });
    const ctx = { head: headSha, mergeBase: baseSha };
    expect((await forge.getFile(headSha, GITLINK_PATH)).kind).toBe("absent"); // not a blob
    const claim = mkClaim({
      type: "file_created",
      subject: { path: GITLINK_PATH },
      expected: { sha256: "0".repeat(64) },
    });
    const result = await verifyClaim(claim, forge, ctx);
    expect(result.status).toBe("failed");
    const uncovered = computeUncoveredPaths([claim], [result], [GITLINK_PATH], [], "T3");
    expect(uncovered).toContain(GITLINK_PATH);
  });

  // P1 regression: a MALFORMED gitlink (mode 160000 pointing at a real blob) must
  // fail closed by TREE MODE. cat-file -t answers "blob" here, so deciding by
  // object type would spuriously content-cover it at T3. getFile must still be
  // absent, the entry floors T3, and a blob-hash claim does NOT cover it.
  it("a gitlink-pointing-at-a-blob is NOT coverable (decided by mode, not object type)", async () => {
    // The hostile premise: the recorded object really is a readable blob.
    expect(git(["cat-file", "-t", `${headSha}:${BLOBLINK_PATH}`], repo)).toBe("blob");
    // ...but the TREE MODE is 160000, so getFile fails closed regardless.
    const forge = new LocalGitForge({ cwd: repo, head: headSha, mergeBase: baseSha });
    const ctx = { head: headSha, mergeBase: baseSha };
    expect((await forge.getFile(headSha, BLOBLINK_PATH)).kind).toBe("absent");

    // (a) it still floors T3 (mode 160000).
    const entries = await compareEntries();
    expect(entries.find((e) => e.path === BLOBLINK_PATH)?.newMode).toBe("160000");
    expect(computeTierFloor(entries, policy)).toBe("T3");

    // (b) a file_created claim with the BLOB's real sha256 does NOT cover it -
    // the claim fails (file_absent_at_head) and the path stays uncovered -> block.
    const claim = mkClaim({
      type: "file_created",
      subject: { path: BLOBLINK_PATH },
      expected: { sha256: symlinkBlobSha256 }, // the blob it points at
    });
    const result = await verifyClaim(claim, forge, ctx);
    expect(result.status).toBe("failed");
    const uncovered = computeUncoveredPaths([claim], [result], [BLOBLINK_PATH], [], "T3");
    expect(uncovered).toContain(BLOBLINK_PATH);
  });

  // Matrix #10: cat-file -t invariant - the stored object type must agree with the
  // mode class (120000 <-> blob, 160000 <-> commit) for WELL-FORMED entries.
  it("object type agrees with mode class for the symlink and gitlink head entries", () => {
    expect(git(["cat-file", "-t", `${headSha}:${SYMLINK_PATH}`], repo)).toBe("blob");
    expect(git(["cat-file", "-t", `${headSha}:${GITLINK_PATH}`], repo)).toBe("commit");
  });
});
