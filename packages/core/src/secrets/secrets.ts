// Secrets at rest: AES-256-GCM with the key from WATCHDOG_ENCRYPTION_KEY (Security and privacy,
// "Secrets"). A ciphertext is `v1.` and then the base64url of its IV, auth tag and data.
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const algorithm = "aes-256-gcm";
const keyVersion = "v1";
const ivLength = 12;
const tagLength = 16;

const failure = (reason: string) => new Error(`Can't decrypt the secret: ${reason}`);

export function encryptSecret(plaintext: string, key: Buffer): string {
  const iv = randomBytes(ivLength);
  const cipher = createCipheriv(algorithm, key, iv);
  const data = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return `${keyVersion}.${Buffer.concat([iv, cipher.getAuthTag(), data]).toString("base64url")}`;
}

/** Returns the plaintext, or throws an error holding neither the key nor the plaintext. */
export function decryptSecret(ciphertext: string, key: Buffer): string {
  const [, version, encoded = ""] = /^(v\d+)\.(.*)$/.exec(ciphertext) ?? [];
  if (version === undefined) throw failure("malformed ciphertext");
  if (version !== keyVersion) throw failure(`unknown key version ${version}`);

  const payload = Buffer.from(encoded, "base64url");
  // Decoding ignores stray characters and a final character's unused bits, so a changed string
  // can decode to the same bytes and still authenticate. Only the exact encoding counts.
  if (payload.length < ivLength + tagLength || payload.toString("base64url") !== encoded) {
    throw failure("malformed ciphertext");
  }

  try {
    const decipher = createDecipheriv(algorithm, key, payload.subarray(0, ivLength));
    decipher.setAuthTag(payload.subarray(ivLength, ivLength + tagLength));
    const data = payload.subarray(ivLength + tagLength);
    return Buffer.concat([decipher.update(data), decipher.final()]).toString("utf8");
  } catch {
    throw failure("wrong key or tampered ciphertext");
  }
}
