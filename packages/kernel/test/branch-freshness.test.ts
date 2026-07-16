import { describe, it, expect } from "vitest";
import type { Octokit } from "@octokit/rest";
import { GitHubForge } from "../src/forge/github.js";
import { TreeParseError } from "../src/forge/tree-diff.js";
import {
  assertBranchFreshness,
  BranchFreshnessError,
  HeadShaCertificationError,
} from "../src/branch-freshness.js";

// QRM-4.0-branch-freshness [2], design §3.2/§3.5/§4. assertBranchFreshness proves
// `merge_base(protectedBranch, prHeadSha) === tip(protectedBranch)` from CERTIFIED
// commit-graph object identity, throws to block on every other outcome, and NEVER
// returns a default. These are REGRESSION PINS (the [1] "tests weaker than they
// look" CONCERN): each must FAIL if the property regresses.
//
// The fake Octokit serves exactly the two reads assertBranchFreshness issues -
// `repos.compareCommitsWithBasehead` (the merge base, read FIRST) and
// `repos.getCommit` (the protected tip, read SECOND) - and records the call
// SEQUENCE and per-endpoint counts, so a test can prove the load-bearing order
// and prove ZERO network calls on a malformed head.

const HEAD = "f".repeat(40); // a valid PR head sha
const SHA_FORK = "a".repeat(40); // the fork point (merge base)
const SHA_TIP = "b".repeat(40); // an ADVANCED protected tip (!= fork point)

interface Recorder {
  seq: string[]; // "mergeBase" | "tip", in call order
  compare: number;
  getCommit: number;
}

interface FakeConfig {
  /** merge_base_commit.sha the compare call returns; "404" -> notFound. */
  mergeBase: unknown | "404";
  /** commit sha the getCommit call returns; "404" -> notFound. */
  tip: unknown | "404";
}

function notFound(): never {
  throw Object.assign(new Error("Not Found"), { status: 404 });
}

function freshnessOctokit(config: FakeConfig, rec: Recorder): Octokit {
  return {
    repos: {
      compareCommitsWithBasehead: async () => {
        rec.compare++;
        rec.seq.push("mergeBase");
        if (config.mergeBase === "404") notFound();
        return { data: { merge_base_commit: { sha: config.mergeBase } } };
      },
      getCommit: async () => {
        rec.getCommit++;
        rec.seq.push("tip");
        if (config.tip === "404") notFound();
        return { data: { sha: config.tip } };
      },
    },
  } as unknown as Octokit;
}

function freshnessForge(config: FakeConfig): { forge: GitHubForge; rec: Recorder } {
  const rec: Recorder = { seq: [], compare: 0, getCommit: 0 };
  const forge = new GitHubForge({ token: "x", owner: "o", repo: "r", head: "unused", octokit: freshnessOctokit(config, rec) });
  return { forge, rec };
}

/** Await a promise expected to REJECT, returning the rejection reason. Throws a
 *  clear message if it resolves instead - so a "forgot to throw" regression
 *  (returning a default rather than blocking) fails loudly. */
async function caught(p: Promise<unknown>): Promise<any> {
  return p.then(
    (v) => {
      throw new Error(`expected a rejection, but resolved with ${JSON.stringify(v)}`);
    },
    (e) => e,
  );
}

describe("assertBranchFreshness - the freshness decision (design §4 C1/C2/C2b/C3)", () => {
  it("stale fork (merge base behind the protected tip) -> BranchFreshnessError carrying BOTH SHAs (C1)", async () => {
    const { forge } = freshnessForge({ mergeBase: SHA_FORK, tip: SHA_TIP });
    const err = await caught(assertBranchFreshness(forge, "main", HEAD));
    expect(err).toBeInstanceOf(BranchFreshnessError);
    expect(err.mergeBaseSha).toBe(SHA_FORK);
    expect(err.protectedTipSha).toBe(SHA_TIP);
  });

  it("fresh fork (merge base === protected tip) -> passes, returns both certified SHAs (C2b)", async () => {
    const { forge } = freshnessForge({ mergeBase: SHA_FORK, tip: SHA_FORK });
    await expect(assertBranchFreshness(forge, "main", HEAD)).resolves.toEqual({
      mergeBaseSha: SHA_FORK,
      protectedTipSha: SHA_FORK,
    });
  });

  it("protected merged INTO an old fork, no rebase -> passes ('up to date' != 'rebased', C2)", async () => {
    // The fork has OLD ancestry, but because the protected branch was merged into
    // it, merge_base(protected, head) resolves to the protected tip. At this layer
    // that is indistinguishable from a rebased-fresh fork - which is correct:
    // certified SHA equality is the whole proof, and it holds here.
    const { forge } = freshnessForge({ mergeBase: SHA_FORK, tip: SHA_FORK });
    await expect(assertBranchFreshness(forge, "main", HEAD)).resolves.toEqual({
      mergeBaseSha: SHA_FORK,
      protectedTipSha: SHA_FORK,
    });
  });

  it("head === protected tip -> passes; freshness is true, empty-delta is a downstream concern (C3)", async () => {
    const { forge } = freshnessForge({ mergeBase: HEAD, tip: HEAD });
    await expect(assertBranchFreshness(forge, "main", HEAD)).resolves.toEqual({
      mergeBaseSha: HEAD,
      protectedTipSha: HEAD,
    });
  });
});

describe("assertBranchFreshness - the call-order invariant (design §3.2, probe C4)", () => {
  it("reads the merge base BEFORE the protected tip (sequence recorder, not just a count)", async () => {
    const { forge, rec } = freshnessForge({ mergeBase: SHA_FORK, tip: SHA_FORK });
    await assertBranchFreshness(forge, "main", HEAD);
    expect(rec.seq).toEqual(["mergeBase", "tip"]); // merge base FIRST, tip SECOND
    expect(rec.compare).toBe(1);
    expect(rec.getCommit).toBe(1);
  });

  it("a protected tip advancing BETWEEN the two reads OVER-blocks (C4) - the safe direction", async () => {
    // The merge-base read (FIRST) observes the branch at SHA_FORK and returns
    // SHA_FORK as the fork point (fresh at that instant). The protected branch
    // then advances. The tip read (SECOND) returns the NEW tip SHA_TIP != SHA_FORK
    // -> BranchFreshnessError. Reversing the order would read the tip BEFORE the
    // advance and spuriously pass FRESH (a false-fresh window) - so this test FAILS
    // (resolves instead of throwing) under a call-order regression. The mutation
    // lives in the merge-base handler, so ONLY the first-read-merge-base order
    // over-blocks; that is what makes this a genuine order pin, not a count pin.
    const rec: Recorder = { seq: [], compare: 0, getCommit: 0 };
    let tip: string = SHA_FORK;
    const octo = {
      repos: {
        compareCommitsWithBasehead: async () => {
          rec.compare++;
          rec.seq.push("mergeBase");
          const mb = tip; // fork point == the tip observed at this instant (fresh)
          tip = SHA_TIP; // ...but the protected branch advances right after
          return { data: { merge_base_commit: { sha: mb } } };
        },
        getCommit: async () => {
          rec.getCommit++;
          rec.seq.push("tip");
          return { data: { sha: tip } }; // now the ADVANCED tip
        },
      },
    } as unknown as Octokit;
    const forge = new GitHubForge({ token: "x", owner: "o", repo: "r", head: "unused", octokit: octo });
    const err = await caught(assertBranchFreshness(forge, "main", HEAD));
    expect(err).toBeInstanceOf(BranchFreshnessError);
    expect(err.mergeBaseSha).toBe(SHA_FORK);
    expect(err.protectedTipSha).toBe(SHA_TIP);
    expect(rec.seq).toEqual(["mergeBase", "tip"]);
  });
});

describe("assertBranchFreshness - malformed prHeadSha throws with ZERO network calls (design §3.5 input, C5)", () => {
  // The input certification is the FIRST statement, before any network call. Each
  // of these must throw the INPUT-layer HeadShaCertificationError, never a
  // BranchFreshnessError, and never touch the network (sentinel call counters -
  // the [1] Codex-BLOCK pattern).
  //
  // Fix delta (Codex NIT): `1n` and `Symbol()` are the load-bearing additions. The
  // previous guard built its message with `JSON.stringify(prHeadSha)`, so `1n` made
  // JSON.stringify throw its OWN native TypeError ("Do not know how to serialize a
  // BigInt") BEFORE the intended error was constructed - the old
  // `toBeInstanceOf(TypeError)` pin then passed on an UNRELATED error, a test
  // weaker than it looked. Pinning the bespoke class AND asserting NOT-a-TypeError
  // makes these FAIL if the guard regresses to a native throw.
  const badHeads: Record<string, unknown> = {
    "39-hex": "a".repeat(39),
    "uppercase-40": "A".repeat(40),
    empty: "",
    null: null,
    junk: "not-a-sha",
    "branch-like (refs/heads/main)": "refs/heads/main",
    "bigint (1n)": 1n,
    symbol: Symbol("head"),
  };
  for (const [label, head] of Object.entries(badHeads)) {
    it(`malformed prHeadSha (${label}) -> throws HeadShaCertificationError, ZERO network calls`, async () => {
      const { forge, rec } = freshnessForge({ mergeBase: SHA_FORK, tip: SHA_FORK });
      const err = await caught(assertBranchFreshness(forge, "main", head as unknown as string));
      expect(err).toBeInstanceOf(HeadShaCertificationError); // input layer, bespoke class
      expect(err).not.toBeInstanceOf(TypeError); // a NATIVE throw (e.g. BigInt) must NOT satisfy this
      expect(err).not.toBeInstanceOf(BranchFreshnessError);
      expect(rec.compare).toBe(0);
      expect(rec.getCommit).toBe(0);
      expect(rec.seq).toEqual([]); // nothing was read at all
    });
  }
});

describe("assertBranchFreshness - tampered returned SHA on BOTH sides -> TreeParseError, never compared (design §3.5 forge, C6)", () => {
  // A well-formed-looking but non-40-hex-lowercase returned SHA is malformed
  // first-party data. It must throw TreeParseError (from the certified resolvers),
  // NOT BranchFreshnessError - garbage is never put on either side of the equality.
  const tampered: Record<string, unknown> = {
    "non-string": 12345,
    short: "abc123",
    "uppercase-40": "A".repeat(40),
    "wrong-length (41)": "a".repeat(41),
    "non-hex": "g".repeat(40),
    missing: undefined,
  };
  for (const [label, badSha] of Object.entries(tampered)) {
    it(`merge-base side tampered (${label}) -> TreeParseError before the tip is even read`, async () => {
      const { forge, rec } = freshnessForge({ mergeBase: badSha, tip: SHA_FORK });
      const err = await caught(assertBranchFreshness(forge, "main", HEAD));
      expect(err).toBeInstanceOf(TreeParseError);
      expect(err).not.toBeInstanceOf(BranchFreshnessError);
      expect(rec.compare).toBe(1); // discovered FROM the compare response
      expect(rec.getCommit).toBe(0); // fail-closed before the tip read
    });

    it(`protected-tip side tampered (${label}) -> TreeParseError, garbage never compared`, async () => {
      const { forge, rec } = freshnessForge({ mergeBase: SHA_FORK, tip: badSha });
      const err = await caught(assertBranchFreshness(forge, "main", HEAD));
      expect(err).toBeInstanceOf(TreeParseError);
      expect(err).not.toBeInstanceOf(BranchFreshnessError);
      expect(rec.compare).toBe(1);
      expect(rec.getCommit).toBe(1); // tip WAS read, then certification threw
    });
  }
});

describe("assertBranchFreshness - absent on EACH read blocks correct-by-layer (design §3.5 forge, C7)", () => {
  it("absent MERGE-BASE read (404) -> blocks, NOT BranchFreshnessError, tip never read", async () => {
    const { forge, rec } = freshnessForge({ mergeBase: "404", tip: SHA_FORK });
    const err = await caught(assertBranchFreshness(forge, "main", HEAD));
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(BranchFreshnessError);
    expect(err.message).toMatch(/could not resolve the merge base/);
    expect(rec.compare).toBe(1);
    expect(rec.getCommit).toBe(0); // blocked at the first read
  });

  it("absent PROTECTED-TIP read (404) -> blocks, NOT BranchFreshnessError", async () => {
    const { forge, rec } = freshnessForge({ mergeBase: SHA_FORK, tip: "404" });
    const err = await caught(assertBranchFreshness(forge, "main", HEAD));
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(BranchFreshnessError);
    expect(err.message).toMatch(/could not resolve the protected branch/);
    expect(rec.compare).toBe(1);
    expect(rec.getCommit).toBe(1);
  });
});
