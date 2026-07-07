import { describe, it, expect } from "vitest";
import type { Octokit } from "@octokit/rest";
import { GitHubForge } from "../src/forge/github.js";
import { forgePolicySource, PolicyReadError } from "../src/policy-source.js";

// QRM-4.0-policy-read [1]: forgePolicySource resolves the canonical fork point
// (compare's merge_base_commit.sha, base PINNED - never a PR-supplied field),
// certifies it as a full 40-hex commit SHA, reads .quorum/policy.json at that
// SHA, and validates it with the same PolicySchema the local path uses. Every
// step fails closed - see design doc §3/§4/§8.

interface FakeShape {
  /** keyed by the exact `basehead` string ("base...head"); "404" -> not found. */
  compareByBasehead?: Record<string, { merge_base_commit?: { sha?: unknown } } | "404">;
  /** keyed by "ref:path"; "404" -> not found. */
  contentByRefPath?: Record<string, { type?: string; encoding?: string; content?: string } | "404">;
}

function notFound(): never {
  throw Object.assign(new Error("Not Found"), { status: 404 });
}

function fakeOctokit(shape: FakeShape): Octokit {
  return {
    repos: {
      compareCommitsWithBasehead: async ({ basehead }: { basehead: string }) => {
        const entry = shape.compareByBasehead?.[basehead];
        if (entry === undefined || entry === "404") notFound();
        return { data: entry };
      },
      getContent: async ({ ref, path }: { ref: string; path: string }) => {
        const entry = shape.contentByRefPath?.[`${ref}:${path}`];
        if (entry === undefined || entry === "404") notFound();
        return { data: { type: entry.type ?? "file", encoding: entry.encoding, content: entry.content } };
      },
    },
  } as unknown as Octokit;
}

const forgeWith = (shape: FakeShape): GitHubForge =>
  new GitHubForge({ token: "x", owner: "o", repo: "r", head: "unused", octokit: fakeOctokit(shape) });

const b64 = (s: string): string => Buffer.from(s, "utf8").toString("base64");

const VALID_POLICY_SHA_A = "a".repeat(40);
const VALID_POLICY_SHA_B = "b".repeat(40);
const VALID_POLICY = JSON.stringify({
  schema: "quorum.policy/v1",
  default_floor: "T0",
  rules: [{ glob: "src/secret.ts", floor: "T3" }],
  exempt_paths: [".quorum/**"],
});

describe("forgePolicySource - merge_base_commit.sha certification (design amendment 1)", () => {
  const badShapes: Record<string, unknown> = {
    missing: undefined,
    "non-string": 12345,
    short: "abc123",
    "branch-like (main)": "main",
    "branch-like (refs/heads/main)": "refs/heads/main",
    uppercase: "A".repeat(40),
    "wrong-length (39)": "a".repeat(39),
    "wrong-length (41)": "a".repeat(41),
    "non-hex": "g".repeat(40),
    null: null,
  };

  for (const [label, sha] of Object.entries(badShapes)) {
    it(`throws PolicyReadError when merge_base_commit.sha is ${label}`, async () => {
      const forge = forgeWith({
        compareByBasehead: { "main...HEADSHA": { merge_base_commit: { sha } } },
      });
      await expect(forgePolicySource(forge, "main", "HEADSHA")).rejects.toThrow(PolicyReadError);
    });
  }

  it("accepts a full 40-hex commit SHA and proceeds to read the policy", async () => {
    const forge = forgeWith({
      compareByBasehead: { "main...HEADSHA": { merge_base_commit: { sha: VALID_POLICY_SHA_A } } },
      contentByRefPath: {
        [`${VALID_POLICY_SHA_A}:.quorum/policy.json`]: { encoding: "base64", content: b64(VALID_POLICY) },
      },
    });
    const source = await forgePolicySource(forge, "main", "HEADSHA");
    expect(source.referenceRef).toBe(VALID_POLICY_SHA_A);
  });
});

describe("forgePolicySource - fail-closed policy read", () => {
  it("throws when base/head is unresolvable (compare 404s)", async () => {
    const forge = forgeWith({ compareByBasehead: {} });
    await expect(forgePolicySource(forge, "main", "HEADSHA")).rejects.toThrow(PolicyReadError);
  });

  it("throws when the policy is absent at the resolved SHA (404)", async () => {
    const forge = forgeWith({
      compareByBasehead: { "main...HEADSHA": { merge_base_commit: { sha: VALID_POLICY_SHA_A } } },
      contentByRefPath: {},
    });
    await expect(forgePolicySource(forge, "main", "HEADSHA")).rejects.toThrow(PolicyReadError);
  });

  it("throws when the policy is a symlink/non-file at the resolved SHA", async () => {
    const forge = forgeWith({
      compareByBasehead: { "main...HEADSHA": { merge_base_commit: { sha: VALID_POLICY_SHA_A } } },
      contentByRefPath: {
        [`${VALID_POLICY_SHA_A}:.quorum/policy.json`]: {
          type: "symlink",
          encoding: "base64",
          content: b64("../elsewhere/policy.json"),
        },
      },
    });
    await expect(forgePolicySource(forge, "main", "HEADSHA")).rejects.toThrow(PolicyReadError);
  });

  it("throws (blocks) on malformed JSON", async () => {
    const forge = forgeWith({
      compareByBasehead: { "main...HEADSHA": { merge_base_commit: { sha: VALID_POLICY_SHA_A } } },
      contentByRefPath: {
        [`${VALID_POLICY_SHA_A}:.quorum/policy.json`]: { encoding: "base64", content: b64("{ not json") },
      },
    });
    await expect(forgePolicySource(forge, "main", "HEADSHA")).rejects.toThrow(PolicyReadError);
  });

  it("throws (blocks) when the policy fails schema validation", async () => {
    const badPolicy = JSON.stringify({ schema: "quorum.policy/v1", default_floor: "T9", rules: [] });
    const forge = forgeWith({
      compareByBasehead: { "main...HEADSHA": { merge_base_commit: { sha: VALID_POLICY_SHA_A } } },
      contentByRefPath: {
        [`${VALID_POLICY_SHA_A}:.quorum/policy.json`]: { encoding: "base64", content: b64(badPolicy) },
      },
    });
    await expect(forgePolicySource(forge, "main", "HEADSHA")).rejects.toThrow(PolicyReadError);
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
        "main...HEADSHA": { merge_base_commit: { sha: VALID_POLICY_SHA_A } },
        "attacker-branch...HEADSHA": { merge_base_commit: { sha: VALID_POLICY_SHA_B } },
      },
      contentByRefPath: {
        [`${VALID_POLICY_SHA_A}:.quorum/policy.json`]: { encoding: "base64", content: b64(VALID_POLICY) },
        [`${VALID_POLICY_SHA_B}:.quorum/policy.json`]: { encoding: "base64", content: b64(permissivePolicy) },
      },
    });
    const source = await forgePolicySource(forge, "main", "HEADSHA");
    expect(source.referenceRef).toBe(VALID_POLICY_SHA_A);
    expect(source.referenceRef).not.toBe(VALID_POLICY_SHA_B);
    expect(source.policy.rules).toHaveLength(1); // the pinned-base policy, not the permissive one
  });
});

describe("forgePolicySource - happy path", () => {
  it("returns referenceRef === mergeBaseSha (a 40-hex SHA) and the resolved policy matches committed bytes", async () => {
    const forge = forgeWith({
      compareByBasehead: { "main...HEADSHA": { merge_base_commit: { sha: VALID_POLICY_SHA_A } } },
      contentByRefPath: {
        [`${VALID_POLICY_SHA_A}:.quorum/policy.json`]: { encoding: "base64", content: b64(VALID_POLICY) },
      },
    });
    const source = await forgePolicySource(forge, "main", "HEADSHA");
    expect(source.referenceRef).toBe(VALID_POLICY_SHA_A);
    expect(/^[0-9a-f]{40}$/.test(source.referenceRef)).toBe(true);
    expect(source.policy).toEqual(JSON.parse(VALID_POLICY));
  });
});
