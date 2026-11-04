import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { decryptSecret, encryptSecret } from "./secrets.ts";

const key = randomBytes(32);

describe("encryptSecret and decryptSecret", () => {
  it.each(["sk-a-model-key", "", "ключ 🔑"])("round-trips %j", (secret) => {
    expect(decryptSecret(encryptSecret(secret, key), key)).toBe(secret);
  });

  it("encrypts the same secret differently each time", () => {
    expect(encryptSecret("sk-a-model-key", key)).not.toBe(encryptSecret("sk-a-model-key", key));
  });

  it("decrypts a stored v1 ciphertext, so the format can't change under existing secrets", () => {
    // Made with node:crypto directly: key and IV are bytes of 7 and 9.
    const stored = "v1.CQkJCQkJCQkJCQkJ9SrmxnLmjYeFhdlU3SjtUlTuqfWTna4FxQ7mU4OT";
    expect(decryptSecret(stored, Buffer.alloc(32, 7))).toBe("sk-a-model-key");
  });

  it("fails when any one character of a ciphertext changes", () => {
    // Every replacement at every position, because a base64 decoder ignores a final character's
    // unused bits and any stray character, which would let a changed string decrypt.
    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_.=!";
    const decrypted: string[] = [];
    for (const secret of ["", "a", "ab", "abc"]) {
      const ciphertext = encryptSecret(secret, key);
      for (let position = 0; position < ciphertext.length; position++) {
        for (const replacement of alphabet) {
          if (replacement === ciphertext[position]) continue;
          const changed =
            ciphertext.slice(0, position) + replacement + ciphertext.slice(position + 1);
          try {
            decryptSecret(changed, key);
            decrypted.push(changed);
          } catch {
            // What every change should do.
          }
        }
      }
    }
    expect(decrypted).toEqual([]);
  });

  it("fails on the wrong key", () => {
    expect(() => decryptSecret(encryptSecret("sk-a-model-key", key), randomBytes(32))).toThrow(
      "Can't decrypt the secret: wrong key or tampered ciphertext",
    );
  });

  it("fails the same way on a key of the wrong length", () => {
    expect(() => decryptSecret(encryptSecret("sk-a-model-key", key), randomBytes(16))).toThrow(
      "Can't decrypt the secret: wrong key or tampered ciphertext",
    );
  });

  it("names an unknown key version", () => {
    const later = encryptSecret("sk-a-model-key", key).replace(/^v1/, "v2");
    expect(() => decryptSecret(later, key)).toThrow(
      "Can't decrypt the secret: unknown key version v2",
    );
  });

  it.each(["", "not a ciphertext", "v1", "v1.", "v1.AAAA", "1.AAAA"])(
    "fails on the malformed ciphertext %j",
    (ciphertext) => {
      expect(() => decryptSecret(ciphertext, key)).toThrow(
        "Can't decrypt the secret: malformed ciphertext",
      );
    },
  );

  it("keeps the key and the secret out of its errors", () => {
    const secret = "sk-a-model-key";
    const ciphertext = encryptSecret(secret, key);
    const tampered = `${ciphertext.slice(0, -1)}${ciphertext.endsWith("A") ? "B" : "A"}`;
    for (const [input, used] of [
      [tampered, key],
      [ciphertext, randomBytes(32)],
    ] as const) {
      let message = "";
      try {
        decryptSecret(input, used);
      } catch (error) {
        message = error instanceof Error ? `${error.message} ${String(error.cause)}` : "";
      }
      expect(message).toMatch(/Can't decrypt the secret/);
      expect(message).not.toContain(secret);
      expect(message).not.toContain(used.toString("base64"));
      expect(message).not.toContain(used.toString("hex"));
    }
  });
});
