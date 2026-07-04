import { describe, it, expect } from "vitest";
import { extractOpencodeReferences } from "../src/references/opencode.js";
import { stripJsonc } from "../src/references/jsonc.js";
import { ReferenceResolutionError } from "../src/references/path.js";

const j = (o: unknown): string => JSON.stringify(o, null, 2);

describe("QRM-3.4 opencode-json extractor", () => {
  it("routes an exact instruction path to exact", () => {
    const { exact, globs } = extractOpencodeReferences(
      "opencode.json",
      j({ instructions: ["guides/setup.md"] }),
    );
    expect(exact).toEqual(["guides/setup.md"]);
    expect(globs).toEqual([]);
  });

  it("routes a glob instruction pattern to globs", () => {
    const { exact, globs } = extractOpencodeReferences(
      "opencode.json",
      j({ instructions: ["guides/**/*.guide.md"] }),
    );
    expect(exact).toEqual([]);
    expect(globs).toEqual(["guides/**/*.guide.md"]);
  });

  it("floors an agent-prompt {file:} path", () => {
    const { exact } = extractOpencodeReferences(
      "opencode.json",
      j({ agent: { review: { prompt: "Please review: {file:./prompts/review.md}" } } }),
    );
    expect(exact).toEqual(["prompts/review.md"]);
  });

  it("floors a deprecated mode.*.prompt {file:} path", () => {
    const { exact } = extractOpencodeReferences(
      "opencode.json",
      j({ mode: { build: { prompt: "{file:prompts/build.md}" } } }),
    );
    expect(exact).toEqual(["prompts/build.md"]);
  });

  it("does NOT floor and does NOT block a {file:} outside instruction fields (provider apiKey)", () => {
    // apiKey carries a {file:~/...} - a home path that WOULD block if scanned. It
    // must be neither floored nor blocked (it is not instruction-bearing).
    const fn = () =>
      extractOpencodeReferences(
        "opencode.json",
        j({ provider: { anthropic: { options: { apiKey: "{file:~/.secrets/key}" } } } }),
      );
    expect(fn).not.toThrow();
    const { exact, globs } = fn();
    expect(exact).toEqual([]);
    expect(globs).toEqual([]);
  });

  it("resolves instructions and {file:} relative to a NESTED config's directory (P1)", () => {
    const { exact } = extractOpencodeReferences(
      "packages/a/opencode.jsonc",
      j({
        instructions: ["shared/x.md"],
        agent: { review: { prompt: "{file:prompts/review.md}" } },
      }),
    );
    // NOT "shared/x.md" / "prompts/review.md" (repo-root) - config-dir-relative.
    expect(exact).toContain("packages/a/shared/x.md");
    expect(exact).toContain("packages/a/prompts/review.md");
  });

  it("resolves a nested glob instruction relative to the config directory", () => {
    const { globs } = extractOpencodeReferences(
      "packages/a/opencode.jsonc",
      j({ instructions: ["guides/**/*.md"] }),
    );
    expect(globs).toEqual(["packages/a/guides/**/*.md"]);
  });

  it("skips a remote-URL instruction entry (neither floors nor blocks)", () => {
    const { exact, globs } = extractOpencodeReferences(
      "opencode.json",
      j({ instructions: ["https://example.com/rules.md", "local/x.md"] }),
    );
    expect(exact).toEqual(["local/x.md"]);
    expect(globs).toEqual([]);
  });

  it("skips an instruction that escapes the repo root via ..", () => {
    const { exact } = extractOpencodeReferences(
      "packages/a/opencode.json",
      j({ instructions: ["../../../etc/passwd"] }),
    );
    expect(exact).toEqual([]);
  });

  // ── Fail-closed blocks ──────────────────────────────────────────────────────
  it("BLOCKS an absolute instruction path with a populated diagnostic", () => {
    let err: ReferenceResolutionError | undefined;
    try {
      extractOpencodeReferences("opencode.json", j({ instructions: ["/abs/x.md"] }));
    } catch (e) {
      err = e as ReferenceResolutionError;
    }
    expect(err).toBeInstanceOf(ReferenceResolutionError);
    expect(err!.diagnostic.reason).toBe("absolute");
    expect(err!.diagnostic.extractor).toBe("opencode-json");
    expect(err!.diagnostic.token).toBe("/abs/x.md");
    expect(err!.diagnostic.location).toBe("/instructions/0");
    expect(err!.diagnostic.remediation).toMatch(/repo-relative/);
  });

  it("BLOCKS an instruction-field {file:~/...} home path", () => {
    let err: ReferenceResolutionError | undefined;
    try {
      extractOpencodeReferences(
        "opencode.json",
        j({ agent: { review: { prompt: "{file:~/secret.md}" } } }),
      );
    } catch (e) {
      err = e as ReferenceResolutionError;
    }
    expect(err?.diagnostic.reason).toBe("home");
    expect(err?.diagnostic.location).toBe("/agent/review/prompt");
    expect(err?.diagnostic.token).toBe("~/secret.md");
  });

  it("BLOCKS an unparseable config (fail closed)", () => {
    let err: ReferenceResolutionError | undefined;
    try {
      extractOpencodeReferences("opencode.json", "{ not valid json ");
    } catch (e) {
      err = e as ReferenceResolutionError;
    }
    expect(err?.diagnostic.reason).toBe("unparseable");
    expect(err?.diagnostic.extractor).toBe("opencode-json");
  });
});

// ── String-aware JSONC lexer (the load-bearing bypass fix) ────────────────────
describe("QRM-3.4 string-aware JSONC lexer", () => {
  it("a recursive glob string survives comment stripping (guides/**/*.guide.md NOT narrowed)", () => {
    const jsonc = [
      "{",
      "  // an opencode config with comments",
      '  "instructions": ["guides/**/*.guide.md"], /* trailing */',
      "}",
    ].join("\n");
    const { globs } = extractOpencodeReferences("opencode.jsonc", jsonc);
    // A regex stripper would have produced "guides*.guide.md" here.
    expect(globs).toEqual(["guides/**/*.guide.md"]);
  });

  it("strips comments and trailing commas outside strings only", () => {
    const jsonc = '{ "a": "x", /* c */ "b": [1, 2,], "u": "http://ok/**/y", } // tail';
    const parsed = JSON.parse(stripJsonc(jsonc)) as Record<string, unknown>;
    expect(parsed["a"]).toBe("x");
    expect(parsed["b"]).toEqual([1, 2]);
    // The // and /**/ inside the string literal are preserved verbatim.
    expect(parsed["u"]).toBe("http://ok/**/y");
  });

  it("does not treat // or /* inside a string as a comment", () => {
    const jsonc = '{ "path": "a//b/**/c" }';
    const parsed = JSON.parse(stripJsonc(jsonc)) as Record<string, unknown>;
    expect(parsed["path"]).toBe("a//b/**/c");
  });
});
