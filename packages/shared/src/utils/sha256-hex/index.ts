// SHA-256 of a value, as lower-case hex. A token, a link code and a dedup key are stored only as
// this, so the value itself never sits in the database.
import { createHash } from "node:crypto";

export function sha256Hex(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}
