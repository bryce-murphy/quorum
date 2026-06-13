import type { Ledger } from "@quorum/contracts";

/** The headline one-liner (SPEC 3.4), e.g.
 *  `Quorum: 14 claims - 12 verified · 1 disclosed-unverifiable · 1 FAILED → blocking (T2, strict)` */
export function renderHeadline(ledger: Ledger): string {
  const { counts } = ledger;
  const segments = [`${counts.verified} verified`];
  if (counts.unverifiable_disclosed > 0) {
    segments.push(`${counts.unverifiable_disclosed} disclosed-unverifiable`);
  }
  if (counts.failed > 0) segments.push(`${counts.failed} FAILED`);
  const arrow = ledger.verdict === "fail" ? "blocking" : "clear";
  return (
    `Quorum: ${counts.total} claims - ${segments.join(" · ")}` +
    ` → ${arrow} (${ledger.tier_effective}, ${ledger.mode})`
  );
}

const STATUS_GLYPH: Record<Ledger["results"][number]["status"], string> = {
  verified: "✓",
  failed: "✗",
  unverifiable_disclosed: "?",
};

/** Full markdown view: headline + a per-claim table. Used as the check summary. */
export function renderLedger(ledger: Ledger): string {
  const lines = [renderHeadline(ledger), ""];
  if (ledger.results.length > 0) {
    lines.push("| | claim | type | status |", "|---|---|---|---|");
    for (const r of ledger.results) {
      lines.push(`| ${STATUS_GLYPH[r.status]} | \`${r.claim_id}\` | ${r.type} | ${r.status} |`);
    }
  }
  return lines.join("\n");
}
