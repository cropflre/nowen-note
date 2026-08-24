import crypto from "node:crypto";

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`).join(",")}}`;
}

export function artifactDigest(bytes: Buffer): Buffer {
  return crypto.createHash("sha256").update(bytes).digest();
}

export function documentDigest(document: Record<string, unknown>): string {
  return crypto.createHash("sha256").update(canonicalJson(document)).digest("hex");
}

export function isEd25519PublicKey(publicKey: string): boolean {
  try {
    const key = crypto.createPublicKey(publicKey);
    return key.type === "public" && key.asymmetricKeyType === "ed25519";
  } catch {
    return false;
  }
}

export function verifyEd25519(data: Buffer | string, signature: string, publicKey: string): boolean {
  try { return crypto.verify(null, Buffer.isBuffer(data) ? data : Buffer.from(data), publicKey, Buffer.from(signature, "base64")); }
  catch { return false; }
}

export function verifyArtifactSignature(bytes: Buffer, signature: string, publicKey: string): boolean {
  return verifyEd25519(artifactDigest(bytes), signature, publicKey);
}

export function verifySignedDocument(document: Record<string, unknown>, signature: string, publicKey: string): boolean {
  const unsigned = { ...document };
  delete unsigned.signature;
  return verifyEd25519(Buffer.from(canonicalJson(unsigned)), signature, publicKey);
}
