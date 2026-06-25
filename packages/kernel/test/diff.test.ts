import { describe, it, expect } from "vitest";
import { parseRawDiff, changedPaths, DiffParseError } from "../src/diff.js";

// `git diff --raw -M -z` is a NUL-delimited stream: a metadata token
// ":<oldmode> <newmode> <oldsha> <newsha> <status>", then ONE path - except
// rename/copy (R<score>/C<score>) is followed by TWO paths (old then new).
const NUL = String.fromCharCode(0);
const z = (...tokens: string[]) => tokens.join(NUL) + NUL;
const SHA = "0000000000000000000000000000000000000000"; // shas are ignored by the parser
const meta = (oldMode: string, newMode: string, status: string) =>
  `:${oldMode} ${newMode} ${SHA} ${SHA} ${status}`;

describe("parseRawDiff - status/mode matrix (1)", () => {
  it("parses add / modify / delete with their 000000 sentinel modes", () => {
    const out = z(
      meta("000000", "100644", "A"), "src/new.ts",
      meta("100644", "100644", "M"), "src/edited.ts",
      meta("100644", "000000", "D"), "src/gone.ts",
    );
    expect(parseRawDiff(out)).toEqual([
      { status: "A", oldMode: "000000", newMode: "100644", path: "src/new.ts" },
      { status: "M", oldMode: "100644", newMode: "100644", path: "src/edited.ts" },
      { status: "D", oldMode: "100644", newMode: "000000", path: "src/gone.ts" },
    ]);
  });

  it("derives the flat changed-path list from entries", () => {
    const out = z(
      meta("000000", "100644", "A"), "src/new.ts",
      meta("100644", "000000", "D"), "src/gone.ts",
    );
    expect(changedPaths(parseRawDiff(out))).toEqual(["src/new.ts", "src/gone.ts"]);
  });
});

describe("parseRawDiff - typechange to/from symlink and gitlink (2,3)", () => {
  it("file -> symlink (T) carries newMode 120000; symlink -> file does not", () => {
    const out = z(
      meta("100644", "120000", "T"), "link",
      meta("120000", "100644", "T"), "was-link",
    );
    const entries = parseRawDiff(out);
    expect(entries[0]).toEqual({ status: "T", oldMode: "100644", newMode: "120000", path: "link" });
    expect(entries[1]).toEqual({ status: "T", oldMode: "120000", newMode: "100644", path: "was-link" });
  });

  it("file -> gitlink (T) and a freshly-added gitlink carry newMode 160000", () => {
    const out = z(
      meta("100644", "160000", "T"), "vendor/dep",
      meta("000000", "160000", "A"), "vendor/added-sub",
    );
    const entries = parseRawDiff(out);
    expect(entries[0]!.newMode).toBe("160000");
    expect(entries[1]!.newMode).toBe("160000");
  });
});

describe("parseRawDiff - rename / copy carry BOTH paths (4)", () => {
  it("rename (R100) surfaces old then new", () => {
    const out = z(meta("100644", "100644", "R100"), "schemas/x.json", "docs/x.json");
    expect(parseRawDiff(out)).toEqual([
      { status: "R100", oldMode: "100644", newMode: "100644", oldPath: "schemas/x.json", path: "docs/x.json" },
    ]);
    expect(changedPaths(parseRawDiff(out))).toEqual(["schemas/x.json", "docs/x.json"]);
  });

  it("rename where the mode also changes to a symlink keeps both paths and newMode", () => {
    const out = z(meta("100644", "120000", "R087"), "a/real.txt", "b/link");
    const entries = parseRawDiff(out);
    expect(entries[0]).toEqual({
      status: "R087", oldMode: "100644", newMode: "120000", oldPath: "a/real.txt", path: "b/link",
    });
    expect(changedPaths(entries)).toEqual(["a/real.txt", "b/link"]);
  });

  it("copy (C75) carries both paths", () => {
    const out = z(meta("100644", "100644", "C75"), "a.ts", "b.ts");
    expect(changedPaths(parseRawDiff(out))).toEqual(["a.ts", "b.ts"]);
  });
});

describe("parseRawDiff - path fidelity under -z (5,6)", () => {
  it("keeps non-ASCII paths raw (no C-quoting / mis-split)", () => {
    const cafe = `schemas/caf${String.fromCharCode(0xe9)}.schema.json`; // U+00E9
    const out = z(meta("000000", "100644", "A"), cafe);
    expect(parseRawDiff(out)).toEqual([
      { status: "A", oldMode: "000000", newMode: "100644", path: cafe },
    ]);
  });

  it("preserves spaces, tabs, quotes, and backslashes in paths", () => {
    const weird = [
      "dir with spaces/a b.ts",
      "tab\there.ts",
      'quote".ts',
      "back\\slash.ts",
    ];
    const out = z(...weird.flatMap((p) => [meta("000000", "100644", "A"), p]));
    expect(changedPaths(parseRawDiff(out))).toEqual(weird);
  });
});

describe("parseRawDiff - fail closed on malformed records (7)", () => {
  it("throws when a rename is missing its second path", () => {
    const out = z(meta("100644", "100644", "R100"), "only-old.json"); // no new path
    expect(() => parseRawDiff(out)).toThrow(DiffParseError);
  });

  it("throws on wrong metadata arity (not 5 fields)", () => {
    const bad = `:100644 100644 ${SHA} M`; // 4 fields
    expect(() => parseRawDiff(z(bad, "p.ts"))).toThrow(DiffParseError);
  });

  it("throws on an unknown status form", () => {
    expect(() => parseRawDiff(z(meta("100644", "100644", "X"), "p.ts"))).toThrow(DiffParseError);
  });

  it("throws when the metadata token lacks the ':' prefix", () => {
    const out = z(`100644 100644 ${SHA} ${SHA} M`, "p.ts");
    expect(() => parseRawDiff(out)).toThrow(DiffParseError);
  });

  it("throws on a non-rename status missing its path operand", () => {
    expect(() => parseRawDiff(z(meta("100644", "100644", "M")))).toThrow(DiffParseError);
  });

  it("empty stream is the empty diff, not an error", () => {
    expect(parseRawDiff("")).toEqual([]);
  });
});
