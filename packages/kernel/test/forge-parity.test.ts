import { describe, it, expect, beforeAll } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Octokit } from "@octokit/rest";
import { LocalGitForge } from "../src/forge/local-git.js";
import { GitHubForge } from "../src/forge/github.js";
import { parseTreeLeaves, TreeParseError, type RawTreeResponse } from "../src/forge/tree-diff.js";
import { PathNormalizationError } from "../src/tier/glob.js";
import type { DiffEntry } from "../src/diff.js";
import type { ForgeAdapter } from "../src/forge/adapter.js";

// QRM-4.0 conformance suite (design §7) - the parity contract as executable
// bytes. A synthetic fixture repo (built via git PLUMBING so symlink/gitlink/
// chmod/CJK entries are portable on Windows) is read by BOTH LocalGitForge (the
// oracle) and GitHubForge (driven by a git-backed trees-API stand-in with the
// identical fields the real API returns: path, mode, type, sha, truncated). We
// assert: (a) compare parity in canonical Map<path,{base,head}> form, (b)
// listFiles leaf-set parity incl. symlink+gitlink leaves, (c) malformed-tree
// fail-closed. A future forge adapter inherits this oracle for free.

const NUL = String.fromCharCode(0);
const COMMIT_X = "1111111111111111111111111111111111111111";
const COMMIT_Y = "2222222222222222222222222222222222222222";
// An edited-rename pair: 7 of 8 lines shared -> git -M pairs them as R<100.
const EDIT_BASE = "line1\nline2\nline3\nline4\nline5\nline6\nline7\nline8\n";
const EDIT_HEAD = "line1\nline2\nline3\nline4\nCHANGED\nline6\nline7\nline8\n";

interface Entry {
  mode: string;
  /** For blobs: the content to hash. For gitlinks (160000): the referenced
   *  commit sha verbatim. */
  content: string;
}
type Tree = Record<string, Entry>;

// Distinct content per path EXCEPT the intentional pure-rename pair, so git's
// rename detector pairs only what we mean it to (parity holds either way - the
// canonical form is rename-agnostic - but this keeps the axes legible).
const BASE_TREE: Tree = {
  "unchanged.ts": { mode: "100644", content: "unchanged" },
  "deleted.ts": { mode: "100644", content: "deleted" },
  "modified.ts": { mode: "100644", content: "mod-base" },
  "old-name.ts": { mode: "100644", content: "rename-shared-body" }, // pure rename src
  "old-edited.ts": { mode: "100644", content: EDIT_BASE }, // edited rename src
  "script.sh": { mode: "100644", content: "script-body" }, // chmod: 644 here
  "becomes-link": { mode: "100644", content: "was-a-regular-file" }, // typechange src
  "retarget-link": { mode: "120000", content: "link-target-1" }, // symlink modify src
  "sub-bump": { mode: "160000", content: COMMIT_X }, // gitlink sha-bump src
  "sub-absorb": { mode: "160000", content: COMMIT_X }, // gitlink absorb src
  "dir with space/file name.txt": { mode: "100644", content: "spaced-base" },
};
const HEAD_TREE: Tree = {
  "unchanged.ts": { mode: "100644", content: "unchanged" }, // identical -> NO diff entry
  "added.ts": { mode: "100644", content: "added" }, // A
  "modified.ts": { mode: "100644", content: "mod-head" }, // M (sha bump)
  "new-name.ts": { mode: "100644", content: "rename-shared-body" }, // pure rename dst (R100)
  "new-edited.ts": { mode: "100644", content: EDIT_HEAD }, // edited rename dst (R<100)
  "script.sh": { mode: "100755", content: "script-body" }, // chmod: 755, SAME blob -> mode-only
  "becomes-link": { mode: "120000", content: "link-target-1" }, // typechange -> symlink (T)
  "new-link": { mode: "120000", content: "link-target-1" }, // symlink add
  "retarget-link": { mode: "120000", content: "link-target-2" }, // symlink modify (mode-preserving M)
  "sub-add": { mode: "160000", content: COMMIT_X }, // gitlink add
  "sub-bump": { mode: "160000", content: COMMIT_Y }, // gitlink sha bump
  "sub-absorb/file.txt": { mode: "100644", content: "absorbed" }, // gitlink absorbed to a regular dir
  "dir with space/file name.txt": { mode: "100644", content: "spaced-head" }, // M (spaced path)
  "文档/说明.md": { mode: "100644", content: "cjk" }, // non-ASCII CJK add
};

function git(repo: string, args: string[], input?: string): Buffer {
  return execFileSync("git", args, {
    cwd: repo,
    stdio: ["pipe", "pipe", "ignore"],
    ...(input !== undefined ? { input: Buffer.from(input, "utf8") } : {}),
  });
}
const gitStr = (repo: string, args: string[]): string => git(repo, args).toString("utf8").trim();

/** Build one commit from an entry map via plumbing (portable: no working-tree
 *  symlinks/submodules needed). Blobs are hashed into the object store; gitlinks
 *  (160000) reference the sha verbatim (the commit need not exist in this repo). */
function buildCommit(repo: string, tree: Tree, parent: string | null, msg: string): string {
  git(repo, ["read-tree", "--empty"]);
  for (const [path, e] of Object.entries(tree)) {
    const sha =
      e.mode === "160000"
        ? e.content
        : git(repo, ["hash-object", "-w", "--stdin"], e.content).toString("utf8").trim();
    git(repo, ["update-index", "--add", "--cacheinfo", `${e.mode},${sha},${path}`]);
  }
  const treeSha = gitStr(repo, ["write-tree"]);
  const args = ["commit-tree", treeSha, "-m", msg];
  if (parent !== null) args.push("-p", parent);
  return gitStr(repo, args);
}

/**
 * A git-backed trees-API stand-in: getCommit resolves ref->commit+tree; getTree
 * emits the recursive listing (`ls-tree -r -t -z`, identical fields to the real
 * API incl. `tree` directory entries to be filtered); compare computes the true
 * ahead/behind/identical/diverged status from rev-list counts. This is what makes
 * the GitHubForge tree-consumption path testable against real object bytes.
 */
function gitBackedOctokit(repo: string): Octokit {
  const resolve = (ref: string): { commitSha: string; treeSha: string } | null => {
    try {
      const commitSha = gitStr(repo, ["rev-parse", `${ref}^{commit}`]);
      const treeSha = gitStr(repo, ["rev-parse", `${ref}^{tree}`]);
      return { commitSha, treeSha };
    } catch {
      return null;
    }
  };
  const count = (range: string): number => Number(gitStr(repo, ["rev-list", "--count", range]));
  return {
    repos: {
      getCommit: async ({ ref }: { ref: string }) => {
        const r = resolve(ref);
        if (r === null) throw Object.assign(new Error("Not Found"), { status: 404 });
        return { data: { sha: r.commitSha, commit: { tree: { sha: r.treeSha } } } };
      },
      compareCommitsWithBasehead: async ({ basehead }: { basehead: string }) => {
        const [base, head] = basehead.split("...");
        const aheadBy = count(`${base}..${head}`);
        const behindBy = count(`${head}..${base}`);
        const status =
          aheadBy === 0 && behindBy === 0
            ? "identical"
            : behindBy === 0
              ? "ahead"
              : aheadBy === 0
                ? "behind"
                : "diverged";
        return { data: { status, commits: [] } };
      },
    },
    git: {
      getTree: async ({ tree_sha }: { tree_sha: string }) => {
        const out = git(repo, ["ls-tree", "-r", "-t", "-z", tree_sha]).toString("utf8");
        const tree = out
          .split(NUL)
          .filter((r) => r !== "")
          .map((rec) => {
            const tab = rec.indexOf("\t");
            const [mode, type, sha] = rec.slice(0, tab).split(/\s+/);
            return { mode, type, sha, path: rec.slice(tab + 1) };
          });
        return { data: { sha: tree_sha, truncated: false, tree } };
      },
    },
  } as unknown as Octokit;
}

/** Canonicalize a DiffEntry[] to Map<path,{base,head}> with 000000 for absent
 *  (design §3): a LocalGit rename entry (carrying oldPath) expands to its two
 *  sides, so it matches the tree-diff's A+D by construction. */
function canonical(entries: readonly DiffEntry[]): Map<string, { base: string; head: string }> {
  const m = new Map<string, { base: string; head: string }>();
  const set = (path: string, side: "base" | "head", mode: string): void => {
    const cur = m.get(path) ?? { base: "000000", head: "000000" };
    cur[side] = mode;
    m.set(path, cur);
  };
  for (const e of entries) {
    if (e.oldPath !== undefined) {
      set(e.oldPath, "base", e.oldMode); // old side deleted
      set(e.path, "head", e.newMode); // new side added
    } else {
      set(e.path, "base", e.oldMode);
      set(e.path, "head", e.newMode);
    }
  }
  return m;
}

/** A stable, comparable projection of a canonical map. */
function flat(m: Map<string, { base: string; head: string }>): string[] {
  return [...m.entries()].map(([p, v]) => `${p}\t${v.base}\t${v.head}`).sort();
}

async function compareOk(forge: ForgeAdapter, base: string, head: string) {
  const res = await forge.compare(base, head);
  if (res.kind !== "ok") throw new Error(`expected ok compare, got ${res.kind}`);
  return res.value;
}
async function listOk(forge: ForgeAdapter, ref: string): Promise<string[]> {
  const res = await forge.listFiles(ref);
  if (res.kind !== "ok") throw new Error(`expected ok listFiles, got ${res.kind}`);
  return [...res.value].sort();
}

describe("QRM-4.0 conformance: GitHubForge vs LocalGitForge parity (tree-diff-primary)", () => {
  let repo: string;
  let baseSha: string;
  let headSha: string;
  let local: LocalGitForge;
  let github: GitHubForge;

  beforeAll(() => {
    repo = mkdtempSync(join(tmpdir(), "quorum-forge-parity-"));
    git(repo, ["init", "-b", "main", "-q", "."]);
    git(repo, ["config", "user.email", "t@t.test"]);
    git(repo, ["config", "user.name", "Test"]);
    baseSha = buildCommit(repo, BASE_TREE, null, "base");
    headSha = buildCommit(repo, HEAD_TREE, baseSha, "head");
    local = new LocalGitForge({ cwd: repo });
    github = new GitHubForge({
      token: "x",
      owner: "o",
      repo: "r",
      head: "HEAD",
      octokit: gitBackedOctokit(repo),
    });
  });

  it("(a) compare: identical changed-path SET and per-path MODES across every axis", async () => {
    const l = await compareOk(local, baseSha, headSha);
    const g = await compareOk(github, baseSha, headSha);
    expect(flat(canonical(g.changedPaths))).toEqual(flat(canonical(l.changedPaths)));
  });

  it("(a) compare: the canonical form actually carries the security-critical modes", async () => {
    // Guard against a vacuous parity pass (two empty maps are equal). Assert the
    // symlink/gitlink modes the QRM-3.1 floor keys on are present on the head side.
    const g = await compareOk(github, baseSha, headSha);
    const c = canonical(g.changedPaths);
    expect(c.get("new-link")?.head).toBe("120000"); // symlink add
    expect(c.get("becomes-link")).toEqual({ base: "100644", head: "120000" }); // typechange
    expect(c.get("sub-add")?.head).toBe("160000"); // gitlink add
    expect(c.get("sub-bump")).toEqual({ base: "160000", head: "160000" }); // gitlink sha bump
    expect(c.get("script.sh")).toEqual({ base: "100644", head: "100755" }); // mode-only chmod
    expect(c.get("retarget-link")).toEqual({ base: "120000", head: "120000" }); // symlink retarget
    // gitlink absorbed into a regular dir: gitlink D + regular-file A.
    expect(c.get("sub-absorb")).toEqual({ base: "160000", head: "000000" });
    expect(c.get("sub-absorb/file.txt")).toEqual({ base: "000000", head: "100644" });
    // Non-ASCII path survives raw (not C-quoted) on both sides.
    expect(c.get("文档/说明.md")?.head).toBe("100644");
    // An unchanged path never appears.
    expect(c.has("unchanged.ts")).toBe(false);
  });

  it("(a) compare: status parity (ahead) and empty self-diff (identical, no entries)", async () => {
    const l = await compareOk(local, baseSha, headSha);
    const g = await compareOk(github, baseSha, headSha);
    expect(g.status).toBe("ahead");
    expect(l.status).toBe("ahead");
    const gEmpty = await compareOk(github, headSha, headSha);
    expect(gEmpty.status).toBe("identical");
    expect(gEmpty.changedPaths).toHaveLength(0);
    const lEmpty = await compareOk(local, headSha, headSha);
    expect(lEmpty.status).toBe("identical");
    expect(lEmpty.changedPaths).toHaveLength(0);
  });

  it("(b) listFiles: identical leaf-path set incl. symlink+gitlink leaves (head)", async () => {
    const l = await listOk(local, headSha);
    const g = await listOk(github, headSha);
    expect(g).toEqual(l);
    // The leaf set must actually contain the indirection leaves, else this is vacuous.
    expect(g).toContain("new-link"); // symlink leaf
    expect(g).toContain("sub-add"); // gitlink leaf
    expect(g).toContain("sub-absorb/file.txt");
    expect(g).toContain("文档/说明.md");
    expect(g).not.toContain("deleted.ts"); // absent at head
  });

  it("(b) listFiles: parity at the base ref too (gitlink leaves present)", async () => {
    const l = await listOk(local, baseSha);
    const g = await listOk(github, baseSha);
    expect(g).toEqual(l);
    expect(g).toContain("sub-absorb"); // gitlink leaf at base
    expect(g).toContain("retarget-link"); // symlink leaf at base
  });
});

// ── (c) malformed tree-response fixtures: each MUST fail closed ───────────────
// Every case runs BOTH through the pure parser AND through the forge path
// (compare + listFiles), so the hard-rejection layer is proven to fire at the
// GitHubForge trust boundary, not only in an isolated unit.
describe("QRM-4.0 conformance: malformed tree-response fail-closed", () => {
  const cases: Array<{ name: string; resp: RawTreeResponse; error: unknown }> = [
    // `truncated` must be a CERTIFIED boolean: `=== true`-only would let a mistyped
    // or missing flag fall through and accept a partial tree (fail-OPEN -> dropped
    // symlink/gitlink leaves -> under-floor). Every non-boolean spelling throws.
    { name: "truncated:true (sole overflow signal)", resp: { truncated: true, tree: [] }, error: TreeParseError },
    { name: "truncated missing entirely", resp: { tree: [{ path: "a", mode: "100644", type: "blob", sha: "s" }] }, error: TreeParseError },
    { name: 'truncated:"true" (string, truthy)', resp: { truncated: "true", tree: [] }, error: TreeParseError },
    { name: 'truncated:"false" (string)', resp: { truncated: "false", tree: [] }, error: TreeParseError },
    { name: "truncated:null", resp: { truncated: null, tree: [] }, error: TreeParseError },
    { name: "truncated:0", resp: { truncated: 0, tree: [] }, error: TreeParseError },
    { name: "truncated:1", resp: { truncated: 1, tree: [] }, error: TreeParseError },
    // Content malformations - `truncated: false` so each reaches its intended check.
    { name: "missing path", resp: { truncated: false, tree: [{ mode: "100644", type: "blob", sha: "s" }] }, error: TreeParseError },
    { name: "missing mode", resp: { truncated: false, tree: [{ path: "a", type: "blob", sha: "s" }] }, error: TreeParseError },
    { name: "missing type", resp: { truncated: false, tree: [{ path: "a", mode: "100644", sha: "s" }] }, error: TreeParseError },
    { name: "missing sha", resp: { truncated: false, tree: [{ path: "a", mode: "100644", type: "blob" }] }, error: TreeParseError },
    { name: "unknown type", resp: { truncated: false, tree: [{ path: "a", mode: "100644", type: "weird", sha: "s" }] }, error: TreeParseError },
    { name: "unknown mode", resp: { truncated: false, tree: [{ path: "a", mode: "123456", type: "blob", sha: "s" }] }, error: TreeParseError },
    { name: "invalid pair blob+160000", resp: { truncated: false, tree: [{ path: "a", mode: "160000", type: "blob", sha: "s" }] }, error: TreeParseError },
    { name: "invalid pair commit+100644", resp: { truncated: false, tree: [{ path: "a", mode: "100644", type: "commit", sha: "s" }] }, error: TreeParseError },
    { name: "invalid pair tree+100644", resp: { truncated: false, tree: [{ path: "a", mode: "100644", type: "tree", sha: "s" }] }, error: TreeParseError },
    {
      name: "duplicate raw path",
      resp: { truncated: false, tree: [ { path: "a", mode: "100644", type: "blob", sha: "s1" }, { path: "a", mode: "100755", type: "blob", sha: "s2" } ] },
      error: TreeParseError,
    },
    { name: "missing tree array entirely (well-formed truncated)", resp: { truncated: false }, error: TreeParseError },
    // normalizePath-rejected paths must fire the repo's hard-rejection layer.
    { name: "path traversal (..)", resp: { truncated: false, tree: [{ path: "../evil", mode: "100644", type: "blob", sha: "s" }] }, error: PathNormalizationError },
    { name: "absolute path", resp: { truncated: false, tree: [{ path: "/etc/passwd", mode: "100644", type: "blob", sha: "s" }] }, error: PathNormalizationError },
    { name: "NUL in path", resp: { truncated: false, tree: [{ path: `a${NUL}b`, mode: "100644", type: "blob", sha: "s" }] }, error: PathNormalizationError },
  ];

  /** A forge whose getTree ALWAYS returns `resp` (getCommit/compare resolve fine),
   *  so a malformed tree is exercised through the real GitHubForge code path. */
  function forgeReturning(resp: RawTreeResponse): GitHubForge {
    const octo = {
      repos: {
        getCommit: async ({ ref }: { ref: string }) => ({
          data: { sha: ref, commit: { tree: { sha: `tree-${ref}` } } },
        }),
        compareCommitsWithBasehead: async () => ({ data: { status: "ahead", commits: [] } }),
      },
      git: { getTree: async () => ({ data: resp }) },
    } as unknown as Octokit;
    return new GitHubForge({ token: "x", owner: "o", repo: "r", head: "HEAD", octokit: octo });
  }

  for (const c of cases) {
    it(`parseTreeLeaves throws on ${c.name}`, () => {
      expect(() => parseTreeLeaves(c.resp)).toThrow(c.error as never);
    });
    it(`GitHubForge.compare fails closed on ${c.name}`, async () => {
      await expect(forgeReturning(c.resp).compare("BASE", "HEAD")).rejects.toThrow(c.error as never);
    });
    it(`GitHubForge.listFiles fails closed on ${c.name}`, async () => {
      await expect(forgeReturning(c.resp).listFiles("REF")).rejects.toThrow(c.error as never);
    });
  }
});
