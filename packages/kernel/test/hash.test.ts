import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sha256 } from "../src/hash.js";
import { LocalGitForge } from "../src/forge/local-git.js";

// Two byte sequences that BOTH decode to "a<U+FFFD>b" if you UTF-8-decode first
// - the exact collision a string-then-hash implementation would produce.
const BAD1 = Buffer.from([0x61, 0x80, 0x62]); // a, lone continuation byte, b
const BAD2 = Buffer.from([0x61, 0xff, 0x62]); // a, invalid byte 0xFF, b
const cryptoHash = (b: Buffer): string => createHash("sha256").update(b).digest("hex");

describe("sha256 over raw bytes", () => {
  it("matches node:crypto for invalid-UTF-8 buffers", () => {
    expect(sha256(BAD1)).toBe(cryptoHash(BAD1));
    expect(sha256(BAD2)).toBe(cryptoHash(BAD2));
  });

  it("does not collapse distinct invalid sequences (no U+FFFD collision)", () => {
    expect(sha256(BAD1)).not.toBe(sha256(BAD2));
    // Both would equal sha256("a<U+FFFD>b") under a string-first implementation.
    // Hashing raw bytes must differ from hashing the UTF-8-decoded string.
    expect(sha256(BAD1)).not.toBe(sha256(BAD1.toString("utf8")));
  });

  it("hashes strings as UTF-8 (back-compat for fixtures)", () => {
    expect(sha256("hello\n")).toBe(cryptoHash(Buffer.from("hello\n", "utf8")));
  });
});

describe("LocalGitForge hashes raw blob bytes", () => {
  it("returns the byte-exact sha256 of an invalid-UTF-8 file", () => {
    const repo = mkdtempSync(join(tmpdir(), "quorum-hash-"));
    const git = (args: string[]) => execFileSync("git", args, { cwd: repo, stdio: ["ignore", "ignore", "ignore"] });
    git(["init", "-b", "main"]);
    git(["config", "user.email", "t@t.test"]);
    git(["config", "user.name", "Test"]);
    mkdirSync(join(repo, "bin"), { recursive: true });
    writeFileSync(join(repo, "bin/blob"), BAD1);
    git(["add", "-A"]);
    git(["commit", "-m", "blob"]);

    const forge = new LocalGitForge({ cwd: repo, head: "HEAD" });
    return forge.getFile("HEAD", "bin/blob").then((res) => {
      expect(res.kind).toBe("ok");
      if (res.kind !== "ok") return;
      expect(res.value.sha256).toBe(cryptoHash(BAD1));
      expect(res.value.sha256).not.toBe(sha256(BAD2));
    });
  });
});
