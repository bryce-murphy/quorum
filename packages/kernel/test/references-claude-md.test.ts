import { describe, it, expect } from "vitest";
import type { Policy, PolicyRule } from "@quorum/contracts";
import { MemoryForge } from "../src/forge/memory.js";
import { resolveReferencedFloors } from "../src/references/resolve.js";
import { parseClaudeImports } from "../src/references/claude-md.js";
import { ReferenceResolutionError } from "../src/references/path.js";
import { referencedFloor, isReferencedPath } from "../src/tier/references.js";

const CLAUDE_RULE: PolicyRule = {
  glob: "**/CLAUDE.md",
  floor: "T3",
  reference_extractor: "claude-md",
};

function policyWith(...rules: PolicyRule[]): Policy {
  return { schema: "quorum.policy/v1", default_floor: "T0", rules };
}

async function resolveRefs(files: Record<string, string>, rules: PolicyRule[] = [CLAUDE_RULE]) {
  const forge = new MemoryForge({ files: { R: files } });
  return resolveReferencedFloors(policyWith(...rules), forge, "R");
}

describe("QRM-3.4 claude-md @import resolution", () => {
  // ── First-party resolution rule (design table) — parse-level ────────────────
  it("resolves bare / ./ / ../ imports relative to the CONTAINING file's directory", () => {
    expect(parseClaudeImports("@docs/a.md", "CLAUDE.md")).toEqual(["docs/a.md"]);
    // BARE import in a nested file resolves to the containing dir (NOT repo-root).
    expect(parseClaudeImports("@b.md", "docs/a.md")).toEqual(["docs/b.md"]);
    expect(parseClaudeImports("@./b.md", "docs/a.md")).toEqual(["docs/b.md"]);
    // A literal `docs/` under a nested file nests further (correct first-party).
    expect(parseClaudeImports("@docs/b.md", "docs/a.md")).toEqual(["docs/docs/b.md"]);
    // In-repo parent reference is KEPT (a blanket `..` reject would DROP = bypass).
    expect(parseClaudeImports("@../b/x.md", "packages/a/CLAUDE.md")).toEqual(["packages/b/x.md"]);
  });

  it("skips an import that provably escapes the repo root via ..", () => {
    expect(parseClaudeImports("@../../etc/passwd", "CLAUDE.md")).toEqual([]);
  });

  it("BLOCKS a filesystem-absolute import (fail closed, populated diagnostic)", () => {
    let err: ReferenceResolutionError | undefined;
    try {
      parseClaudeImports("@/abs/x.md", "CLAUDE.md");
    } catch (e) {
      err = e as ReferenceResolutionError;
    }
    expect(err).toBeInstanceOf(ReferenceResolutionError);
    expect(err!.diagnostic.reason).toBe("absolute");
    expect(err!.diagnostic.extractor).toBe("claude-md");
    expect(err!.diagnostic.token).toBe("@/abs/x.md");
    expect(err!.diagnostic.sourceConfig).toBe("CLAUDE.md");
    expect(err!.diagnostic.location).toBe("line 1");
    expect(err!.diagnostic.remediation).toMatch(/repo-relative/);
  });

  it("BLOCKS a Windows drive-absolute import", () => {
    expect(() => parseClaudeImports("@C:\\x.md", "CLAUDE.md")).toThrow(ReferenceResolutionError);
  });

  it("BLOCKS a ~-home import with reason 'home'", () => {
    let err: ReferenceResolutionError | undefined;
    try {
      parseClaudeImports("see @~/.claude/x.md here", "CLAUDE.md");
    } catch (e) {
      err = e as ReferenceResolutionError;
    }
    expect(err?.diagnostic.reason).toBe("home");
    expect(err?.diagnostic.token).toBe("@~/.claude/x.md");
  });

  // ── Code span / fenced block skipping ───────────────────────────────────────
  it("skips imports inside fenced code blocks and inline code spans", () => {
    const md = [
      "@real.md is imported",
      "```",
      "@fenced.md not imported",
      "```",
      "inline `@inline.md` not imported",
      "backtick literal ``@double.md`` not imported",
    ].join("\n");
    expect(parseClaudeImports(md, "CLAUDE.md")).toEqual(["real.md"]);
  });

  it("does not treat an email-like foo@bar as an import (needs leading whitespace/BOL)", () => {
    expect(parseClaudeImports("contact foo@bar.com", "CLAUDE.md")).toEqual([]);
  });

  // ── Recursion: 4 hops max, hop 5 stays T0 ───────────────────────────────────
  it("floors a full 4-hop chain to T3 and stops at hop 5 (T0)", async () => {
    const rf = await resolveRefs({
      "CLAUDE.md": "@h1.md",
      "h1.md": "@h2.md",
      "h2.md": "@h3.md",
      "h3.md": "@h4.md",
      "h4.md": "@h5.md",
      "h5.md": "@h6.md",
    });
    for (const p of ["h1.md", "h2.md", "h3.md", "h4.md"]) {
      expect(referencedFloor(p, rf), `${p} should floor T3`).toBe("T3");
    }
    expect(referencedFloor("h5.md", rf), "hop 5 must NOT floor").toBeUndefined();
    expect(referencedFloor("h6.md", rf)).toBeUndefined();
  });

  it("terminates on an import cycle with both files floored", async () => {
    const rf = await resolveRefs({
      "CLAUDE.md": "@a.md",
      "a.md": "@b.md",
      "b.md": "@a.md",
    });
    expect(referencedFloor("a.md", rf)).toBe("T3");
    expect(referencedFloor("b.md", rf)).toBe("T3");
  });

  // ── Nested resolution through the resolver (bare import in a nested file) ────
  it("a nested bare import floors the containing-dir target (docs/a.md + @b.md -> docs/b.md)", async () => {
    const rf = await resolveRefs({
      "CLAUDE.md": "@docs/a.md",
      "docs/a.md": "@b.md",
    });
    expect(referencedFloor("docs/a.md", rf)).toBe("T3");
    expect(referencedFloor("docs/b.md", rf)).toBe("T3");
    expect(referencedFloor("b.md", rf)).toBeUndefined();
  });

  it("keeps an in-repo @../sibling reference from a nested CLAUDE.md", async () => {
    const rf = await resolveRefs({
      "packages/app/CLAUDE.md": "@../lib/x.md",
    });
    expect(isReferencedPath("packages/lib/x.md", rf)).toBe(true);
    expect(referencedFloor("packages/lib/x.md", rf)).toBe("T3");
  });

  it("CLAUDE.local.md is enumerated by its own extractor rule", async () => {
    const rf = await resolveRefs(
      { "CLAUDE.local.md": "@notes.md" },
      [{ glob: "**/CLAUDE.local.md", floor: "T3", reference_extractor: "claude-md" }],
    );
    expect(referencedFloor("notes.md", rf)).toBe("T3");
  });

  it("floors a non-.md import target but does not recurse into it", async () => {
    const rf = await resolveRefs({
      "CLAUDE.md": "@config/settings.json",
      "config/settings.json": "@should-not-be-followed.md",
    });
    expect(referencedFloor("config/settings.json", rf)).toBe("T3");
    expect(referencedFloor("should-not-be-followed.md", rf)).toBeUndefined();
  });
});
