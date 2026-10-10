import crypto from "node:crypto";

export interface PublisherKeyWindow {
  validFrom: string;
  validUntil: string | null;
}

function parseIsoTimestamp(value: string | null, field: string): number {
  if (!value) throw new Error(`publisher key ${field} is required`);
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) throw new Error(`publisher key ${field} must be a valid ISO timestamp`);
  return timestamp;
}

export function assertPublisherKeyWindow(window: PublisherKeyWindow, now = Date.now(), requireCurrent = false): void {
  const validFrom = parseIsoTimestamp(window.validFrom, "validFrom");
  const validUntil = parseIsoTimestamp(window.validUntil, "validUntil");
  if (validUntil <= validFrom) throw new Error("publisher key validUntil must be later than validFrom");
  if (requireCurrent && (validFrom > now || validUntil <= now)) throw new Error("publisher signing key is outside its validity window");
}

export function normalizePublisherKey(publicKey: string): string {
  let key: crypto.KeyObject;
  try { key = crypto.createPublicKey(publicKey); }
  catch { throw new Error("publisher public key is invalid"); }
  if (key.asymmetricKeyType !== "ed25519") throw new Error("publisher public key must be Ed25519");
  return key.export({ type: "spki", format: "pem" }).toString();
}
