import type { Claim } from "@quorum/contracts";
import { ClaimSchema } from "@quorum/contracts";
import type { ExtractError } from "./types.js";

const FENCED_BLOCK = /```quorum-claims\s*\n([\s\S]*?)```/g;

interface ParsedClaims {
  claims: Claim[];
  errors: ExtractError[];
}

/** Parse the committed `.quorum/claims/<task>.jsonl` (one claim per line). */
export function parseClaimsJsonl(content: string, source = "claims.jsonl"): ParsedClaims {
  const claims: Claim[] = [];
  const errors: ExtractError[] = [];
  const lines = content.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]!.trim();
    if (raw === "") continue;
    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch {
      errors.push({ source, line: i + 1, message: "invalid JSON" });
      continue;
    }
    const parsed = ClaimSchema.safeParse(json);
    if (parsed.success) {
      claims.push(parsed.data);
    } else {
      errors.push({ source, line: i + 1, message: parsed.error.issues[0]?.message ?? "invalid claim" });
    }
  }
  return { claims, errors };
}

/** Parse any fenced ```quorum-claims``` blocks (JSON arrays) from a PR body. */
export function parseFencedClaims(prBody: string, source = "pr-body"): ParsedClaims {
  const claims: Claim[] = [];
  const errors: ExtractError[] = [];
  for (const match of prBody.matchAll(FENCED_BLOCK)) {
    let json: unknown;
    try {
      json = JSON.parse(match[1]!);
    } catch {
      errors.push({ source, message: "invalid JSON in quorum-claims block" });
      continue;
    }
    const arr = Array.isArray(json) ? json : [json];
    for (const item of arr) {
      const parsed = ClaimSchema.safeParse(item);
      if (parsed.success) claims.push(parsed.data);
      else errors.push({ source, message: parsed.error.issues[0]?.message ?? "invalid claim" });
    }
  }
  return { claims, errors };
}
