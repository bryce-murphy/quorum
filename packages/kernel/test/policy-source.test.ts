import { describe, it, expect } from "vitest";
import type { Octokit } from "@octokit/rest";
import { GitHubForge } from "../src/forge/github.js";
import { TreeParseError } from "../src/forge/tree-diff.js";
import { forgePolicySource, PolicyReadError } from "../src/policy-source.js";
import { BranchFreshnessError } from "../src/branch-freshness.js";

// QRM-4.0-policy-read [1]: forgePolicySource resolves the canonical fork point
// (compare's merge_base_commit.sha, base PINNED - never a PR-supplied field),
// certifies the PR head sha it feeds in AND certifies the fork point it gets
// back (Codex round 1: the pre-fix code only certified the RETURNED value,
// never the head sha it was computed FROM), reads .quorum/policy.json at that
// SHA, and validates it with the same PolicySchema the local path uses. Every
// step fails closed - see design doc §3/§4/§8 and the round-1 fix delta.
//
// QRM-4.0-branch-freshness [2], design §3.3: forgePolicySource is now
// FRESHNESS-BOUND - it calls assertBranchFreshness internally, so it only yields
// a policy when the protected branch is up to date (merge base === tip). The
// fake below therefore also serves `repos.getCommit` (the tip read); the happy
// paths set `commitByRef` so tip === merge base (fresh), and a dedicated test
// proves a policy CANNOT be obtained on a stale fork.

interface FakeShape {
  /** keyed by the exact `basehead` string ("base...head"); "404" -> not found. */
  compareByBasehead?: Record<string, { merge_base_commit?: { sha?: unknown } } | "404">;
  /** ref -> protected-tip commit sha (resolveRefCommit / getCommit). A ref not
   *  listed here 404s -> absent. Set tip === merge base for a FRESH topology. */
  commitByRef?: Record<string, string>;
  /** keyed by "ref:path"; "404" -> not found. */
  contentByRefPath?: Record<string, { type?: string; encoding?: string; content?: string } | "404">;
}

interface Counters {
  compare: number;
  getCommit: number;
  getContent: number;
}

function notFound(): never {
  throw Object.assign(new Error("Not Found"), { status: 404 });
}

function fakeOctokit(shape: FakeShape, counters: Counters): Octokit {
  return {
    repos: {
      compareCommitsWithBasehead: async ({ basehead }: { basehead: string }) => {
        counters.compare++;
        const entry = shape.compareByBasehead?.[basehead];
        if (entry === undefined || entry === "404") notFound();
        return { data: entry };
      },
      getCommit: async ({ ref }: { ref: string }) => {
        counters.getCommit++;
        const sha = shape.commitByRef?.[ref];
        if (sha === undefined) notFound();
        return { data: { sha } };
      },
      getContent: async ({ ref, path }: { ref: string; path: string }) => {
        counters.getContent++;
        const entry = shape.contentByRefPath?.[`${ref}:${path}`];
        if (entry === undefined || entry === "404") notFound();
        return { data: { type: entry.type ?? "file", encoding: entry.encoding, content: entry.content } };
      },
    },
  } as unknown as Octokit;
}

/** A FRESH topology helper: sets `commitByRef[base] = mergeBaseSha` so the
 *  protected tip equals the fork point and assertBranchFreshness passes,
 *  letting forgePolicySource proceed to the policy read. */
function freshShape(
  base: string,
  head: string,
  mergeBaseSha: string,
  contentByRefPath: FakeShape["contentByRefPath"],
): FakeShape {
  return {
    compareByBasehead: { [`${base}...${head}`]: { merge_base_commit: { sha: mergeBaseSha } } },
    commitByRef: { [base]: mergeBaseSha },
    contentByRefPath,
  };
}

/** Plain forge, no call accounting - for tests that don't need it. */
const forgeWith = (shape: FakeShape): GitHubForge =>
  new GitHubForge({ token: "x", owner: "o", repo: "r", head: "unused", octokit: fakeOctokit(shape, { compare: 0, getCommit: 0, getContent: 0 }) });

/** Forge + a live counters object, so a test can assert NO network call
 *  happened at all (proving a throw ran before any compare/getContent, not
 *  merely that some later step also happens to throw - Codex round 1 CONCERN C). */
function forgeWithCounters(shape: FakeShape): { forge: GitHubForge; counters: Counters } {
  const counters: Counters = { compare: 0, getCommit: 0, getContent: 0 };
  const forge = new GitHubForge({ token: "x", owner: "o", repo: "r", head: "unused", octokit: fakeOctokit(shape, counters) });
  return { forge, counters };
}

const b64 = (s: string): string => Buffer.from(s, "utf8").toString("base64");

const VALID_HEAD_SHA = "f".repeat(40);
const VALID_POLICY_SHA_A = "a".repeat(40);
const VALID_POLICY_SHA_B = "b".repeat(40);
const VALID_POLICY = JSON.stringify({
  schema: "quorum.policy/v1",
  default_floor: "T0",
  rules: [{ glob: "src/secret.ts", floor: "T3" }],
  exempt_paths: [".quorum/**"],
});

describe("forgePolicySource - prHeadSha certification (Codex round 1, BLOCK)", () => {
  // The pre-fix code passed prHeadSha straight into resolveMergeBase with no
  // shape check - only the RETURNED merge-base sha was certified. A caller
  // passing headRef (a mutable branch label) instead of headSha would silently
  // "work". These each must throw BEFORE any compare or getContent call.
  const badHeads: Record<string, string> = {
    "branch-like (main)": "main",
    "branch-like (refs/heads/main)": "refs/heads/main",
    short: "abc123",
    "non-hex": "g".repeat(40),
    uppercase: "F".repeat(40),
    empty: "",
  };

  for (const [label, head] of Object.entries(badHeads)) {
    it(`throws PolicyReadError for a ${label} prHeadSha, before any network call`, async () => {
      const { forge, counters } = forgeWithCounters({
        compareByBasehead: { [`main...${head}`]: { merge_base_commit: { sha: VALID_POLICY_SHA_A } } },
        contentByRefPath: {
          [`${VALID_POLICY_SHA_A}:.quorum/policy.json`]: { encoding: "base64", content: b64(VALID_POLICY) },
        },
      });
      await expect(forgePolicySource(forge, "main", head)).rejects.toThrow(PolicyReadError);
      expect(counters.compare).toBe(0); // certification runs before resolveMergeBase is even called
      expect(counters.getContent).toBe(0);
    });
  }

  it("accepts a full 40-hex prHeadSha and proceeds", async () => {
    const forge = forgeWith(
      freshShape("main", VALID_HEAD_SHA, VALID_POLICY_SHA_A, {
        [`${VALID_POLICY_SHA_A}:.quorum/policy.json`]: { encoding: "base64", content: b64(VALID_POLICY) },
      }),
    );
    const source = await forgePolicySource(forge, "main", VALID_HEAD_SHA);
    expect(source.referenceRef).toBe(VALID_POLICY_SHA_A);
  });
});

describe("forgePolicySource - merge_base_commit.sha certification (design amendment 1 / Codex round 1 CONCERN B)", () => {
  // Certification of the RETURNED merge-base sha now lives inside
  // GitHubForge.resolveMergeBase itself (github-forge.test.ts covers that
  // method in isolation); it throws TreeParseError, which propagates through
  // forgePolicySource uncaught. These tests pin the end-to-end behavior AND
  // (CONCERN C) prove getContent is never reached for a malformed fork point -
  // without this, a test asserting only "throws" would still pass even if the
  // certification were deleted, because a bad ref would 404 at getFile too.
  const badShapes: Record<string, unknown> = {
    missing: undefined,
    "non-string": 12345,
    short: "abc123",
    "branch-like (main)": "main",
    uppercase: "A".repeat(40),
    "wrong-length (39)": "a".repeat(39),
  };

  for (const [label, sha] of Object.entries(badShapes)) {
    it(`throws (via GitHubForge.resolveMergeBase) when merge_base_commit.sha is ${label}, before any getContent call`, async () => {
      const { forge, counters } = forgeWithCounters({
        compareByBasehead: { [`main...${VALID_HEAD_SHA}`]: { merge_base_commit: { sha } } },
      });
      await expect(forgePolicySource(forge, "main", VALID_HEAD_SHA)).rejects.toThrow(TreeParseError);
      expect(counters.compare).toBe(1); // the malformed shape is discovered FROM the compare response
      expect(counters.getContent).toBe(0); // never reaches a policy read
    });
  }

  it("accepts a full 40-hex commit SHA and proceeds to read the policy", async () => {
    const forge = forgeWith(
      freshShape("main", VALID_HEAD_SHA, VALID_POLICY_SHA_A, {
        [`${VALID_POLICY_SHA_A}:.quorum/policy.json`]: { encoding: "base64", content: b64(VALID_POLICY) },
      }),
    );
    const source = await forgePolicySource(forge, "main", VALID_HEAD_SHA);
    expect(source.referenceRef).toBe(VALID_POLICY_SHA_A);
  });
});

describe("forgePolicySource - fail-closed policy read", () => {
  it("blocks when base/head is unresolvable (compare 404s)", async () => {
    // Supersession (design §3.3): the base/head resolution now happens INSIDE
    // assertBranchFreshness (the freshness merge-base read), which blocks with a
    // correct-by-layer error (NOT PolicyReadError, NOT BranchFreshnessError -
    // we could not even resolve the fork point). The catch-all contract holds:
    // any throw blocks, no caller may assume a single error class.
    const forge = forgeWith({ compareByBasehead: {} });
    await expect(forgePolicySource(forge, "main", VALID_HEAD_SHA)).rejects.toThrow(/could not resolve/);
    await expect(forgePolicySource(forge, "main", VALID_HEAD_SHA)).rejects.not.toBeInstanceOf(
      BranchFreshnessError,
    );
  });

  it("throws when the policy is absent at the resolved SHA (404)", async () => {
    const forge = forgeWith(
      freshShape("main", VALID_HEAD_SHA, VALID_POLICY_SHA_A, {}),
    );
    await expect(forgePolicySource(forge, "main", VALID_HEAD_SHA)).rejects.toThrow(PolicyReadError);
  });

  it("throws when the policy is a symlink/non-file at the resolved SHA", async () => {
    const forge = forgeWith(
      freshShape("main", VALID_HEAD_SHA, VALID_POLICY_SHA_A, {
        [`${VALID_POLICY_SHA_A}:.quorum/policy.json`]: {
          type: "symlink",
          encoding: "base64",
          content: b64("../elsewhere/policy.json"),
        },
      }),
    );
    await expect(forgePolicySource(forge, "main", VALID_HEAD_SHA)).rejects.toThrow(PolicyReadError);
  });

  it("throws (blocks) on malformed JSON", async () => {
    const forge = forgeWith(
      freshShape("main", VALID_HEAD_SHA, VALID_POLICY_SHA_A, {
        [`${VALID_POLICY_SHA_A}:.quorum/policy.json`]: { encoding: "base64", content: b64("{ not json") },
      }),
    );
    await expect(forgePolicySource(forge, "main", VALID_HEAD_SHA)).rejects.toThrow(PolicyReadError);
  });

  it("throws (blocks) when the policy fails schema validation", async () => {
    const badPolicy = JSON.stringify({ schema: "quorum.policy/v1", default_floor: "T9", rules: [] });
    const forge = forgeWith(
      freshShape("main", VALID_HEAD_SHA, VALID_POLICY_SHA_A, {
        [`${VALID_POLICY_SHA_A}:.quorum/policy.json`]: { encoding: "base64", content: b64(badPolicy) },
      }),
    );
    await expect(forgePolicySource(forge, "main", VALID_HEAD_SHA)).rejects.toThrow(PolicyReadError);
  });
});

describe("forgePolicySource - base-branch pinning (design §5, the R1-analog)", () => {
  it("ignores a PR-supplied/attacker-chosen base: only the pinned protectedBaseBranch param is ever read", async () => {
    // Two candidate bases resolve to DIFFERENT merge points, each with its own
    // policy. A PR "claiming" `attacker-branch` as its base must not influence
    // the result - forgePolicySource has no parameter through which such a
    // claim could even enter; it only ever compares against what the CALLER
    // passes as protectedBaseBranch.
    const permissivePolicy = JSON.stringify({ schema: "quorum.policy/v1", default_floor: "T0", rules: [] });
    const forge = forgeWith({
      compareByBasehead: {
        [`main...${VALID_HEAD_SHA}`]: { merge_base_commit: { sha: VALID_POLICY_SHA_A } },
        [`attacker-branch...${VALID_HEAD_SHA}`]: { merge_base_commit: { sha: VALID_POLICY_SHA_B } },
      },
      // main is fresh (tip === fork point); the attacker branch's tip is never
      // even read, because assertBranchFreshness resolves the tip of the PINNED
      // protectedBaseBranch only.
      commitByRef: { main: VALID_POLICY_SHA_A },
      contentByRefPath: {
        [`${VALID_POLICY_SHA_A}:.quorum/policy.json`]: { encoding: "base64", content: b64(VALID_POLICY) },
        [`${VALID_POLICY_SHA_B}:.quorum/policy.json`]: { encoding: "base64", content: b64(permissivePolicy) },
      },
    });
    const source = await forgePolicySource(forge, "main", VALID_HEAD_SHA);
    expect(source.referenceRef).toBe(VALID_POLICY_SHA_A);
    expect(source.referenceRef).not.toBe(VALID_POLICY_SHA_B);
    expect(source.policy.rules).toHaveLength(1); // the pinned-base policy, not the permissive one
  });
});

describe("forgePolicySource - happy path", () => {
  it("returns referenceRef === mergeBaseSha (a 40-hex SHA) and the resolved policy matches committed bytes", async () => {
    const forge = forgeWith(
      freshShape("main", VALID_HEAD_SHA, VALID_POLICY_SHA_A, {
        [`${VALID_POLICY_SHA_A}:.quorum/policy.json`]: { encoding: "base64", content: b64(VALID_POLICY) },
      }),
    );
    const source = await forgePolicySource(forge, "main", VALID_HEAD_SHA);
    expect(source.referenceRef).toBe(VALID_POLICY_SHA_A);
    expect(/^[0-9a-f]{40}$/.test(source.referenceRef)).toBe(true);
    expect(source.policy).toEqual(JSON.parse(VALID_POLICY));
  });
});

describe("forgePolicySource - freshness-bound (QRM-4.0-branch-freshness [2], design §3.3)", () => {
  it("CANNOT yield a policy on a stale fork: throws BranchFreshnessError, never reads the policy", async () => {
    // The stale-fork / old-permissive-policy vector [1] deferred to [2]. The fork
    // point (VALID_POLICY_SHA_A) carries a policy of its era, but the protected
    // tip has advanced to VALID_POLICY_SHA_B. Even though a readable policy sits
    // at the fork point, forgePolicySource must block BEFORE reading it - the
    // freshness attestation is structurally in the path.
    const { forge, counters } = forgeWithCounters({
      compareByBasehead: { [`main...${VALID_HEAD_SHA}`]: { merge_base_commit: { sha: VALID_POLICY_SHA_A } } },
      commitByRef: { main: VALID_POLICY_SHA_B }, // tip advanced past the fork point -> STALE
      contentByRefPath: {
        [`${VALID_POLICY_SHA_A}:.quorum/policy.json`]: { encoding: "base64", content: b64(VALID_POLICY) },
      },
    });
    await expect(forgePolicySource(forge, "main", VALID_HEAD_SHA)).rejects.toThrow(BranchFreshnessError);
    expect(counters.getContent).toBe(0); // the policy at the stale fork point is NEVER read
  });

  it("yields the policy once the fork is fresh (tip === fork point), proving the block is freshness-specific", async () => {
    // Same fork point and policy as the stale case above; only the protected tip
    // differs. This isolates freshness as the sole cause of the block.
    const forge = forgeWith(
      freshShape("main", VALID_HEAD_SHA, VALID_POLICY_SHA_A, {
        [`${VALID_POLICY_SHA_A}:.quorum/policy.json`]: { encoding: "base64", content: b64(VALID_POLICY) },
      }),
    );
    const source = await forgePolicySource(forge, "main", VALID_HEAD_SHA);
    expect(source.referenceRef).toBe(VALID_POLICY_SHA_A);
  });
});
