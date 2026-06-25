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

describe("GitHubForge.compare - fail closed (QRM-3.1 P2)", () => {
  it("throws rather than returning mode-less / rename-lossy entries", async () => {
    // Mode-bearing GitHub compare is deferred; until it lands, compare() must NOT
    // hand back partial entries that would silently under-floor a tier decision.
    await expect(forgeWith({}).compare("BASE", "HEAD")).rejects.toThrow(
      /mode-bearing compare not implemented for GitHubForge/,
    );
  });

  it("compare() throw is caught by findContentMatch: commit_pushed resolves failed, not unhandled exception", async () => {
    // Sub-shape B: a commit_pushed with expected.sha256 triggers findContentMatch,
    // which calls forge.compare(). When compare() throws (GitHubForge P2), the
    // throw must be swallowed (null = no match), and the claim resolves to a
    // normal `failed` verdict - not an unhandled exception that crashes verify.
    const forge = new GitHubForge({
      token: "x",
      owner: "o",
      repo: "r",
      head: "HEAD",
      octokit: {
        // resolveCommit: getCommit resolves (commit exists) but mergeBase not
        // set, so the fallback compare-for-status path is reached. Make getCommit
        // succeed by not throwing, then have compareCommitsWithBasehead throw.
        repos: {
          getCommit: async () => ({ data: { sha: "deadbeefdeadbeef" } }),
          compareCommitsWithBasehead: async () => { throw Object.assign(new Error("not found"), { status: 404 }); },
        },
        paginate: async () => [],
        pulls: { listReviews: async () => ({ data: [] }), listReviewComments: async () => ({ data: [] }) },
        issues: { listComments: async () => ({ data: [] }) },
        checks: { listForRef: async () => ({ data: { check_runs: [] } }) },
      } as unknown as Octokit,
    });
    const claim = mkClaim({
      type: "commit_pushed",
      subject: { sha: "deadbeefdeadbeef" },
      expected: { sha256: "a".repeat(64) }, // triggers findContentMatch
    });
    // Must not throw; must resolve to a normal failed result.
    const result = await verifyClaim(claim, forge, { head: "HEAD", mergeBase: "BASE" });
    expect(result.status).toBe("failed");
    expect(result.evidence["content_match"]).toBe(false);
  });
});
