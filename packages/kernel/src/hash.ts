import { createHash } from "node:crypto";

/**
 * sha256 over RAW BYTES, lowercase hex. Accepts a Buffer (preferred - exact
 * bytes) or a string (hashed as UTF-8). The content-hash primitive must never
 * lie on binary input: callers reading forge/file content pass Buffers so that
 * invalid UTF-8 is hashed faithfully rather than collapsed to U+FFFD first.
 */
export function sha256(data: Buffer | string): string {
  return createHash("sha256").update(data).digest("hex");
}
