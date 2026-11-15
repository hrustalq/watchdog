import { createHash } from "node:crypto";

/**
 * SHA-256 of a value, as lower-case hex. A token, a link code and a dedup key are stored only as
 * this, so the value itself never sits in the database. Text and the bytes that carry it hash alike.
 */
export function sha256Hex(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}
