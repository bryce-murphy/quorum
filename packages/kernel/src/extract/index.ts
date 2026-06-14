import { parseClaimsJsonl, parseFencedClaims } from "./structured.js";
import { mineClaims } from "./salvage.js";
import type { ExtractResult, ExtractSources } from "./types.js";

export type { ExtractSources, ExtractResult, ExtractError } from "./types.js";

/**
 * Extract claims from PR sources (SPEC 3.2, 4).
 *  - strict:  structured only. Claims file is the primary source, a fenced
 *             quorum-claims PR-body block the secondary. Parse errors surface so
 *             the Gate can fail closed.
 *  - salvage: mine prose from PR body + commit messages. Advisory; never blocks.
 */
export function extractClaims(sources: ExtractSources, mode: "strict" | "salvage"): ExtractResult {
  if (mode === "strict") {
    const fromFile = sources.claimsJsonl
      ? parseClaimsJsonl(sources.claimsJsonl)
      : { claims: [], errors: [] };
    const fromBody = sources.prBody
      ? parseFencedClaims(sources.prBody)
      : { claims: [], errors: [] };
    const claims = [...fromFile.claims, ...fromBody.claims];
    const errors = [...fromFile.errors, ...fromBody.errors];

    // FIX 6: a duplicate claim id is a protocol error - it would let one verified
    // result be reused to cover two assertions (double-verify). Reject it.
    const seen = new Set<string>();
    for (const c of claims) {
      if (seen.has(c.id)) {
        errors.push({ source: "claims", message: `duplicate claim id: ${c.id}` });
      }
      seen.add(c.id);
    }
    return { claims, advisory: false, errors };
  }

  const texts = [sources.prBody ?? "", ...(sources.commitMessages ?? [])];
  const claims = mineClaims(texts, sources.task ?? "salvage");
  return { claims, advisory: true, errors: [] };
}
