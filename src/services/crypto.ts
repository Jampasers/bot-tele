import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

/** A versioned AES-256-GCM envelope. The key is never stored with ciphertext. */
function encryptionKey(): Buffer {
  const encoded = process.env["CREDENTIAL_ENCRYPTION_KEY"]?.trim() ?? "";
  const key = /^[a-f\d]{64}$/i.test(encoded)
    ? Buffer.from(encoded, "hex")
    : /^[A-Za-z\d+/_-]{43}=?$/.test(encoded) ? Buffer.from(encoded, "base64url") : Buffer.alloc(0);
  if (key.length !== 32) {
    throw new Error(
      `CREDENTIAL_ENCRYPTION_KEY must contain 32 random bytes encoded as 64 hex characters, base64, or base64url. Detected ${encoded.length} characters.`,
    );
  }
  return key;
}

export function validateEncryptionKey(): void { encryptionKey(); }

export function encryptSecret(value: string, purpose = "credential"): string {
  if (typeof value !== "string" || !value) throw new Error("Secret must be a non-empty string.");
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey(), iv, { authTagLength: 16 });
  cipher.setAAD(Buffer.from(purpose, "utf8"));
  const encrypted = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return ["v1", iv.toString("base64url"), cipher.getAuthTag().toString("base64url"), encrypted.toString("base64url")].join(".");
}

export function decryptSecret(envelope: string, purpose = "credential"): string {
  const [version, ivPart, tagPart, dataPart, extra] = envelope.split(".");
  if (version !== "v1" || !ivPart || !tagPart || !dataPart || extra !== undefined ||
      ![ivPart, tagPart, dataPart].every((part) => /^[A-Za-z\d_-]+$/.test(part))) {
    throw new Error("Invalid encrypted credential envelope.");
  }
  const iv = Buffer.from(ivPart, "base64url");
  const tag = Buffer.from(tagPart, "base64url");
  if (iv.length !== 12 || tag.length !== 16) throw new Error("Invalid encrypted credential envelope.");
  try {
    const decipher = createDecipheriv("aes-256-gcm", encryptionKey(), iv, { authTagLength: 16 });
    decipher.setAAD(Buffer.from(purpose, "utf8"));
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(Buffer.from(dataPart, "base64url")), decipher.final()]).toString("utf8");
  } catch {
    throw new Error("Credential decryption failed. Check the encryption key and credential context.");
  }
}
