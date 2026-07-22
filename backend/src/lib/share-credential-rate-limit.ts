import crypto from "crypto";

interface CredentialBucket {
  failures: number[];
  blockedUntil: number;
}

const credentialBuckets = new Map<string, CredentialBucket>();
const anonymousActionBuckets = new Map<string, number[]>();
const CREDENTIAL_WINDOW_MS = 60_000;
const CREDENTIAL_MAX_FAILURES = 8;
const CREDENTIAL_COOLDOWN_MS = 5 * 60_000;

export function getClientIp(c: any): string {
  const forwarded = c.req.header("X-Forwarded-For") || c.req.header("x-forwarded-for");
  const first = forwarded?.split(",")[0]?.trim();
  return first || c.req.header("X-Real-IP") || c.req.header("x-real-ip") || "unknown";
}

export function hashClientIp(ip: string): string {
  return crypto.createHash("sha256").update(ip || "unknown").digest("hex");
}

function pruneFailures(values: number[], now: number): number[] {
  return values.filter((time) => now - time < CREDENTIAL_WINDOW_MS);
}

export function checkCredentialAttempt(key: string): { allowed: boolean; retryAfterSeconds: number } {
  const now = Date.now();
  const current = credentialBuckets.get(key) || { failures: [], blockedUntil: 0 };
  current.failures = pruneFailures(current.failures, now);
  if (current.blockedUntil > now) {
    credentialBuckets.set(key, current);
    return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil((current.blockedUntil - now) / 1000)) };
  }
  if (current.blockedUntil) current.blockedUntil = 0;
  credentialBuckets.set(key, current);
  return { allowed: true, retryAfterSeconds: 0 };
}

export function recordCredentialFailure(key: string): void {
  const now = Date.now();
  const current = credentialBuckets.get(key) || { failures: [], blockedUntil: 0 };
  current.failures = pruneFailures(current.failures, now);
  current.failures.push(now);
  if (current.failures.length >= CREDENTIAL_MAX_FAILURES) {
    current.blockedUntil = now + CREDENTIAL_COOLDOWN_MS;
  }
  credentialBuckets.set(key, current);
}

export function recordCredentialSuccess(key: string): void {
  credentialBuckets.delete(key);
}

export function allowAnonymousAction(
  namespace: string,
  subject: string,
  maxAttempts = 30,
  windowMs = 60_000,
): boolean {
  const now = Date.now();
  const key = `${namespace}:${subject}`;
  const recent = (anonymousActionBuckets.get(key) || []).filter((time) => now - time < windowMs);
  if (recent.length >= maxAttempts) {
    anonymousActionBuckets.set(key, recent);
    return false;
  }
  recent.push(now);
  anonymousActionBuckets.set(key, recent);
  if (anonymousActionBuckets.size > 10_000) {
    for (const [bucketKey, values] of anonymousActionBuckets) {
      if (!values.some((time) => now - time < windowMs)) anonymousActionBuckets.delete(bucketKey);
    }
  }
  return true;
}

export function resetShareRateLimitsForTests(): void {
  credentialBuckets.clear();
  anonymousActionBuckets.clear();
}
