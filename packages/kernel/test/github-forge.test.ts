import { describe, it, expect } from "vitest";
import type { Octokit } from "@octokit/rest";
import { GitHubForge } from "../src/forge/github.js";
import { verifyClaim } from "../src/verify/index.js";
import { mkClaim } from "./fixtures/amas.js";

// Minimal fake Octokit that simulates real pagination: each endpoint returns a
// page slice keyed on (page, per_page), and `paginate` walks pages until a short
// one - exactly how octokit.paginate follows Link headers. This proves the forge
// aggregates ALL pages across ALL THREE endpoints, not just the first.
interface FakeConfig {
  reviews?: Array<{ id: number; user?: { login: string }; submitted_at: string | null }>;
  issueComments?: Array<{ id: number; user?: { login: string }; created_at: string }>;
  lineComments?: Array<{ id: number; user?: { login: string }; created_at: string }>;
}

function makeFakeOctokit(config: FakeConfig): Octokit {
  const pageOf = <T>(items: T[], params: { page?: number; per_page?: number }) => {
    const per = params.per_page ?? 30;
    const page = params.page ?? 1;
    return { data: items.slice((page - 1) * per, (page - 1) * per + per) };
  };
  const fake = {
    pulls: {
      listReviews: (p: { page?: number; per_page?: number }) =>
        Promise.resolve(pageOf(config.reviews ?? [], p)),
      listReviewComments: (p: { page?: number; per_page?: number }) =>
        Promise.resolve(pageOf(config.lineComments ?? [], p)),
    },
    issues: {
      listComments: (p: { page?: number; per_page?: number }) =>
        Promise.resolve(pageOf(config.issueComments ?? [], p)),
    },
    async paginate(
      fn: (p: { page: number; per_page?: number }) => Promise<{ data: unknown[] }>,
      params: { per_page?: number },
    ): Promise<unknown[]> {
      const per = params.per_page ?? 30;
      const out: unknown[] = [];
      for (let page = 1; ; page++) {
        const res = await fn({ ...params, page });
        out.push(...res.data);
        if (res.data.length < per) break;
      }
      return out;
    },
  };
  return fake as unknown as Octokit;
}

const forgeWith = (config: FakeConfig): GitHubForge =>
  new GitHubForge({ token: "x", owner: "o", repo: "r", head: "HEAD", octokit: makeFakeOctokit(config) });

describe("GitHubForge.getReviewsAllEndpoints", () => {
  it("paginates past the first page on every endpoint", async () => {
    // 150 issue comments across two pages of 100; must collect all 150.
    const issueComments = Array.from({ length: 150 }, (_, i) => ({
      id: i + 1,
      user: { login: "gpt-codex" },
      created_at: `2026-06-12T00:00:${String(i % 60).padStart(2, "0")}Z`,
    }));
    const res = await forgeWith({ issueComments }).getReviewsAllEndpoints(7);
    expect(res.kind).toBe("ok");
    if (res.kind !== "ok") return;
    expect(res.value).toHaveLength(150);
  });

  it("drops a null-submitted_at review and never lets it pollute the tie-break", async () => {
    const res = await forgeWith({
      reviews: [
        { id: 1, user: { login: "gpt-codex" }, submitted_at: null }, // PENDING - not posted
        { id: 2, user: { login: "gpt-codex" }, submitted_at: "2026-06-12T03:14:00Z" },
      ],
    }).getReviewsAllEndpoints(7);
    expect(res.kind).toBe("ok");
    if (res.kind !== "ok") return;
    expect(res.value).toHaveLength(1);
    expect(res.value[0]?.id).toBe("review:2");
    // The dropped null review must not appear first with an empty timestamp.
    expect(res.value.some((r) => r.submitted_at === "")).toBe(false);
  });
});

// QRM-4.0: mode-bearing compare + authenticated listFiles, tree-diff-primary.
// The COMPREHENSIVE parity + malformed-tree fail-closed matrix lives in the
// conformance suite (forge-parity.test.ts, driven by a git-backed trees API).
// These unit tests cover the Octokit WIRING GitHubForge adds on top: commit->tree
// resolution, the 404->absent envelope, and the status-vocab fail-closed check.
type TreeEntry = { path: string; mode: string; type: string; sha: string };
interface TreeOctokitData {
  /** ref -> tree sha (getCommit resolves the ref's commit + tree). */
  commits?: Record<string, string>;
  /** tree sha -> recursive tree response. */
  trees?: Record<string, { truncated?: boolean; tree?: TreeEntry[] }>;
  status?: string;
}
function notFound(): never {
  throw Object.assign(new Error("Not Found"), { status: 404 });
}
function treeOctokit(data: TreeOctokitData): Octokit {
  return {
    repos: {
      getCommit: async ({ ref }: { ref: string }) => {
        const treeSha = data.commits?.[ref];
        if (treeSha === undefined) notFound();
        return { data: { sha: ref, commit: { tree: { sha: treeSha } } } };
      },
      compareCommitsWithBasehead: async () => {
        if (data.status === undefined) notFound();
        // `commits: []` keeps resolveCommit's delta-membership check well-formed
        // (empty delta -> the claimed sha is not "pushed" -> absent); compareStatus
        // reads only `.status`.
        return { data: { status: data.status, commits: [] } };
      },
    },
    git: {
      getTree: async ({ tree_sha }: { tree_sha: string }) => {
        const t = data.trees?.[tree_sha];
        if (t === undefined) notFound();
        return { data: { sha: tree_sha, truncated: t.truncated ?? false, tree: t.tree ?? [] } };
      },
    },
  } as unknown as Octokit;
}
const treeForge = (data: TreeOctokitData): GitHubForge =>
  new GitHubForge({ token: "x", owner: "o", repo: "r", head: "HEAD", octokit: treeOctokit(data) });

describe("GitHubForge.compare - tree-diff-primary (QRM-4.0)", () => {
  it("derives mode-bearing DiffEntry[] from base+head trees, status from the compare call", async () => {
    const res = await treeForge({
      commits: { BASE: "tb", HEAD: "th" },
      trees: {
        tb: { tree: [{ path: "a.ts", mode: "100644", type: "blob", sha: "s1" }] },
        th: {
          tree: [
            { path: "a.ts", mode: "100644", type: "blob", sha: "s2" }, // modified (sha bump)
            { path: "link", mode: "120000", type: "blob", sha: "sl" }, // symlink ADDED (floors T3)
            { path: "sub", mode: "160000", type: "commit", sha: "sc" }, // gitlink ADDED (floors T3)
          ],
        },
      },
      status: "ahead",
    }).compare("BASE", "HEAD");
    expect(res.kind).toBe("ok");
    if (res.kind !== "ok") return;
    expect(res.value.status).toBe("ahead");
    const byPath = new Map(res.value.changedPaths.map((e) => [e.path, e]));
    expect(byPath.get("a.ts")).toMatchObject({ oldMode: "100644", newMode: "100644" });
    expect(byPath.get("link")?.newMode).toBe("120000"); // mode preserved -> floor holds
    expect(byPath.get("sub")?.newMode).toBe("160000");
    expect(res.value.changedPaths).toHaveLength(3);
  });

  it("returns absent when the base (or head) commit does not resolve (404)", async () => {
    const res = await treeForge({
      commits: { HEAD: "th" }, // BASE missing -> getCommit 404
      trees: { th: { tree: [] } },
      status: "ahead",
    }).compare("BASE", "HEAD");
    expect(res.kind).toBe("absent"); // §4.6: unresolvable base/head -> absent, never a partial diff
  });

  it("throws (fail closed) on a truncated tree - the sole overflow signal", async () => {
    await expect(
      treeForge({
        commits: { BASE: "tb", HEAD: "th" },
        trees: { tb: { tree: [] }, th: { truncated: true, tree: [] } },
        status: "ahead",
      }).compare("BASE", "HEAD"),
    ).rejects.toThrow(/truncated/);
  });

  it("throws (fail closed) on an unknown compare status - malformed first-party vocab", async () => {
    await expect(
      treeForge({
        commits: { BASE: "tb", HEAD: "th" },
        trees: { tb: { tree: [] }, th: { tree: [] } },
        status: "sideways", // not ahead|behind|identical|diverged
      }).compare("BASE", "HEAD"),
    ).rejects.toThrow(/unknown status/);
  });

  it("a compare throw is swallowed by findContentMatch: commit_pushed resolves failed, not an unhandled exception", async () => {
    // Sub-shape B: a commit_pushed with expected.sha256 triggers findContentMatch,
    // which calls forge.compare(). A malformed (truncated) tree makes compare throw;
    // the throw must be swallowed (null = no match) and the claim resolve to a
    // normal `failed` verdict - not an unhandled exception that crashes verify.
    const octo = {
      ...(treeOctokit({
        commits: { BASE: "tb", HEAD: "th" },
        trees: { tb: { tree: [] }, th: { truncated: true, tree: [] } },
        status: "ahead",
      }) as unknown as Record<string, unknown>),
    } as unknown as Octokit;
    // resolveCommit (separate path) needs getCommit to resolve the claimed sha AND
    // the fallback compare-for-status; treeOctokit already provides both.
    const forge = new GitHubForge({ token: "x", owner: "o", repo: "r", head: "HEAD", octokit: octo });
    const claim = mkClaim({
      type: "commit_pushed",
      subject: { sha: "deadbeefdeadbeef" }, // not in commits -> resolveCommit absent
      expected: { sha256: "a".repeat(64) }, // triggers findContentMatch -> compare()
    });
    const result = await verifyClaim(claim, forge, { head: "HEAD", mergeBase: "BASE" });
    expect(result.status).toBe("failed");
    expect(result.evidence["content_match"]).toBe(false);
  });
});

describe("GitHubForge.listFiles - authenticated tree listing (QRM-4.0 [11])", () => {
  it("returns the blob+commit leaf set (directories filtered), matching ls-tree -r", async () => {
    const res = await treeForge({
      commits: { HEAD: "th" },
      trees: {
        th: {
          tree: [
            { path: "dir", mode: "040000", type: "tree", sha: "td" }, // directory - filtered
            { path: "dir/a.ts", mode: "100644", type: "blob", sha: "s1" },
            { path: "link", mode: "120000", type: "blob", sha: "sl" }, // symlink leaf kept
            { path: "sub", mode: "160000", type: "commit", sha: "sc" }, // gitlink leaf kept
          ],
        },
      },
    }).listFiles("HEAD");
    expect(res.kind).toBe("ok");
    if (res.kind !== "ok") return;
    expect([...res.value].sort()).toEqual(["dir/a.ts", "link", "sub"]);
  });

  it("returns absent when the ref does not resolve (404)", async () => {
    const res = await treeForge({ commits: {}, trees: {} }).listFiles("nope");
    expect(res.kind).toBe("absent");
  });
});
