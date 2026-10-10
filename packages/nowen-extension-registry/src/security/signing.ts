import crypto from "node:crypto";

export function canonicalJson(value: unknown): string {
  if (value === undefined) return "null";
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object).filter((key) => object[key] !== undefined).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`).join(",")}}`;
}

export function documentDigest(document: Record<string, unknown>): string {
  return crypto.createHash("sha256").update(canonicalJson(document)).digest("hex");
}

export function signDocument(document: Record<string, unknown>, privateKey: crypto.KeyObject): string {
  return crypto.sign(null, Buffer.from(canonicalJson(document)), privateKey).toString("base64");
}
