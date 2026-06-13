import { parseClaimsJsonl, parseFencedClaims } from "./structured.js";
import { mineClaims } from "./salvage.js";
import type { ExtractResult, ExtractSources } from "./types.js";

export type { ExtractSources, ExtractResult, ExtractError } from "./types.js";

/**
 * Extract claims from PR sources (SPEC §3.2, §4).
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
    return {
      claims: [...fromFile.claims, ...fromBody.claims],
      advisory: false,
      errors: [...fromFile.errors, ...fromBody.errors],
    };
  }

  const texts = [sources.prBody ?? "", ...(sources.commitMessages ?? [])];
  const claims = mineClaims(texts, sources.task ?? "salvage");
  return { claims, advisory: true, errors: [] };
}
