import { readFileSync } from "node:fs";
import type { Claim } from "@quorum/contracts";
import { ClaimSchema } from "@quorum/contracts";

interface Pattern {
  type: string;
  regex: string;
  flags: string;
  subject: "path" | "sha" | "pr_number" | "issue_number";
}

// Pattern table is *data* (SPEC 4): derived from the AMAS prose-claim corpus,
// edited without touching code. Loaded relative to this module so it resolves
// from both the TS source (tests) and the copied dist asset (CLI).
const PATTERNS: Pattern[] = JSON.parse(
  readFileSync(new URL("./patterns.json", import.meta.url), "utf8"),
) as Pattern[];

function buildSubject(kind: Pattern["subject"], captured: string): Record<string, unknown> {
  switch (kind) {
    case "path":
      // Strip trailing sentence punctuation so "src/new.ts." -> "src/new.ts".
      // Slashes are preserved (directory paths).
      return { path: captured.replace(/[.,;:!?)\]]+$/, "") };
    case "sha":
      return { sha: captured };
    case "pr_number":
      return { pr: Number.parseInt(captured, 10) };
    case "issue_number":
      return { number: Number.parseInt(captured, 10) };
  }
}

/**
 * Remove regions that look like claims but are not prose assertions: fenced code
 * blocks (```...```) and blockquoted lines (`> ...`). Quoting untrusted text or
 * showing an example must not register as a real action-claim (false positive).
 */
function stripNonProse(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, " ")
    .split("\n")
    .filter((line) => !/^\s*>/.test(line))
    .join("\n");
}

/**
 * Salvage miner: scan untrusted prose (PR body + commit messages) for action
 * claims. Results are advisory - they let the Gate emit a ledger even when no
 * disciplined claims file exists. Mined claims are validated against the schema
 * and silently dropped if they don't conform.
 */
export function mineClaims(texts: readonly string[], task: string): Claim[] {
  const blob = texts.map(stripNonProse).join("\n");
  const claims: Claim[] = [];
  const stated_at = new Date().toISOString();
  let seq = 0;

  for (const pattern of PATTERNS) {
    const re = new RegExp(pattern.regex, pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`);
    for (const match of blob.matchAll(re)) {
      const captured = match[1];
      if (!captured) continue;
      seq += 1;
      const candidate = {
        schema: "quorum.claim/v1",
        id: `clm_salvage${String(seq).padStart(6, "0")}`,
        task,
        agent: "salvage",
        type: pattern.type,
        subject: buildSubject(pattern.subject, captured),
        stated_at,
      };
      const parsed = ClaimSchema.safeParse(candidate);
      if (parsed.success) claims.push(parsed.data);
    }
  }
  return claims;
}
