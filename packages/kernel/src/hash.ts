import { createHash } from "node:crypto";

/** sha256 of UTF-8 content, lowercase hex. The single hashing primitive the
 *  verifier uses for content-equality checks (file hashes, Sub-shape B). */
export function sha256(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}
