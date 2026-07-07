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

  it("binds the triple to RESOLVED commit SHAs: compareStatus gets the resolved SHAs, not the raw refs", async () => {
    // A mutable ref resolves to a FIXED commit. The status call must be pinned to
    // the SAME resolved commits the trees came from, so a ref moving mid-sequence
    // cannot yield a head tree from one commit and a status from another.
    let seenBasehead: string | undefined;
    const octo = {
      repos: {
        getCommit: async ({ ref }: { ref: string }) => {
          const map: Record<string, string> = { BASE: "basecommitsha40", HEAD: "headcommitsha40" };
          const sha = map[ref];
          if (sha === undefined) throw Object.assign(new Error("Not Found"), { status: 404 });
          return { data: { sha, commit: { tree: { sha: `tree-of-${sha}` } } } };
        },
        compareCommitsWithBasehead: async ({ basehead }: { basehead: string }) => {
          seenBasehead = basehead;
          return { data: { status: "ahead", commits: [] } };
        },
      },
      git: {
        getTree: async ({ tree_sha }: { tree_sha: string }) => ({
          data: { sha: tree_sha, truncated: false, tree: [] },
        }),
      },
    } as unknown as Octokit;
    const forge = new GitHubForge({ token: "x", owner: "o", repo: "r", head: "HEAD", octokit: octo });
    const res = await forge.compare("BASE", "HEAD");
    expect(res.kind).toBe("ok");
    // The status is bound to the resolved commit SHAs, NOT the caller's raw refs.
    expect(seenBasehead).toBe("basecommitsha40...headcommitsha40");
    expect(seenBasehead).not.toBe("BASE...HEAD");
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

// QRM-4.0-policy-read §4.1: `getFile` must certify `data.encoding === "base64"`
// BEFORE decoding, rather than falling through to `Buffer.from("", "base64")`
// on the contents API's `encoding:"none"` shape (blobs > 1MB). Pinned for BOTH
// a policy file and a reference-bearing config: for policy.json today's gap is
// an ACCIDENTAL block (empty content -> JSON.parse throws), but for a
// reference-bearing CLAUDE.md, empty content resolves to ZERO references (no
// throw) - a silent under-floor. The guard converts both into an explicit throw.
function contentOctokit(shapeByPath: Record<string, { encoding?: string; content?: string; type?: string }>): Octokit {
  return {
    repos: {
      getContent: async ({ path }: { path: string }) => {
        const shape = shapeByPath[path];
        if (shape === undefined) throw Object.assign(new Error("Not Found"), { status: 404 });
        return { data: { type: shape.type ?? "file", encoding: shape.encoding, content: shape.content } };
      },
    },
  } as unknown as Octokit;
}
const contentForge = (shapeByPath: Record<string, { encoding?: string; content?: string; type?: string }>) =>
  new GitHubForge({ token: "x", owner: "o", repo: "r", head: "HEAD", octokit: contentOctokit(shapeByPath) });

describe("GitHubForge.getFile - strict content-encoding certification (QRM-4.0-policy-read §4.1)", () => {
  it("throws on encoding:'none' for .quorum/policy.json (do not decode as empty)", async () => {
    await expect(
      contentForge({ ".quorum/policy.json": { encoding: "none", content: "" } }).getFile("SHA", ".quorum/policy.json"),
    ).rejects.toThrow(/encoding/);
  });

  it("throws on encoding:'none' for a reference-bearing CLAUDE.md (the sharper under-floor case)", async () => {
    await expect(
      contentForge({ "CLAUDE.md": { encoding: "none", content: "" } }).getFile("SHA", "CLAUDE.md"),
    ).rejects.toThrow(/encoding/);
  });

  it("throws when encoding is missing entirely, not just 'none'", async () => {
    await expect(
      contentForge({ "CLAUDE.md": { content: "QGRvY3MvYS5tZA==" } }).getFile("SHA", "CLAUDE.md"),
    ).rejects.toThrow(/encoding/);
  });

  it("still decodes normally when encoding is 'base64'", async () => {
    const res = await contentForge({
      "CLAUDE.md": { encoding: "base64", content: Buffer.from("@docs/a.md\n", "utf8").toString("base64") },
    }).getFile("SHA", "CLAUDE.md");
    expect(res.kind).toBe("ok");
    if (res.kind !== "ok") return;
    expect(res.value.content).toBe("@docs/a.md\n");
  });

  it("a symlink/non-file entry stays 'absent' regardless of encoding (unchanged behavior)", async () => {
    const res = await contentForge({
      link: { type: "symlink", encoding: "base64", content: "irrelevant" },
    }).getFile("SHA", "link");
    expect(res.kind).toBe("absent");
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
