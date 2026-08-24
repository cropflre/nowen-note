import type { DatabaseSync } from "node:sqlite";
import { getConnInfo } from "@hono/node-server/conninfo";
import type { Context, Next } from "hono";

interface BucketPolicy {
  capacity: number;
  refillPerSecond: number;
}

const POLICIES = {
  global: { capacity: 1_000, refillPerSecond: 100 },
  ip: { capacity: 120, refillPerSecond: 2 },
  account: { capacity: 300, refillPerSecond: 5 },
  publisher: { capacity: 120, refillPerSecond: 2 },
} satisfies Record<string, BucketPolicy>;

export interface PublishLimits {
  maxArtifactBytes: number;
  cooldownSeconds: number;
  dailyCount: number;
  dailyBytes: number;
}

export class RateLimiter {
  constructor(private readonly db: DatabaseSync) {}

  consume(scope: keyof typeof POLICIES, id: string, cost = 1): boolean {
    const policy = POLICIES[scope];
    const key = `${scope}:${id}`;
    const now = Date.now();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const row = this.db.prepare("SELECT tokens,updatedAt FROM rate_limit_buckets WHERE bucketKey=?").get(key) as { tokens: number; updatedAt: number } | undefined;
      const replenished = row ? Math.min(policy.capacity, row.tokens + Math.max(0, now - row.updatedAt) / 1_000 * policy.refillPerSecond) : policy.capacity;
      if (replenished < cost) {
        this.db.prepare(`INSERT INTO rate_limit_buckets(bucketKey,tokens,updatedAt) VALUES (?,?,?)
          ON CONFLICT(bucketKey) DO UPDATE SET tokens=excluded.tokens,updatedAt=excluded.updatedAt`).run(key, replenished, now);
        this.db.exec("COMMIT");
        return false;
      }
      this.db.prepare(`INSERT INTO rate_limit_buckets(bucketKey,tokens,updatedAt) VALUES (?,?,?)
        ON CONFLICT(bucketKey) DO UPDATE SET tokens=excluded.tokens,updatedAt=excluded.updatedAt`).run(key, replenished - cost, now);
      this.db.exec("COMMIT");
      return true;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  consumePublish(publisherId: string, artifactBytes: number, limits: PublishLimits): void {
    if (artifactBytes <= 0 || artifactBytes > limits.maxArtifactBytes) throw new Error(`artifact exceeds ${limits.maxArtifactBytes} bytes`);
    if (!this.consume("publisher", publisherId, 10)) throw new Error("publisher rate limit exceeded");
    const now = new Date();
    const day = now.toISOString().slice(0, 10);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const row = this.db.prepare("SELECT publishCount,artifactBytes,lastPublishedAt FROM publisher_quotas WHERE publisherId=? AND day=?").get(publisherId, day) as { publishCount: number; artifactBytes: number; lastPublishedAt: string | null } | undefined;
      if (row?.lastPublishedAt && now.getTime() - Date.parse(row.lastPublishedAt) < limits.cooldownSeconds * 1_000) throw new Error("publisher publish cooldown is active");
      if ((row?.publishCount || 0) + 1 > limits.dailyCount) throw new Error("publisher daily publish quota exceeded");
      if ((row?.artifactBytes || 0) + artifactBytes > limits.dailyBytes) throw new Error("publisher daily artifact quota exceeded");
      this.db.prepare(`INSERT INTO publisher_quotas(publisherId,day,publishCount,artifactBytes,lastPublishedAt) VALUES (?,?,1,?,?)
        ON CONFLICT(publisherId,day) DO UPDATE SET publishCount=publishCount+1,artifactBytes=artifactBytes+excluded.artifactBytes,lastPublishedAt=excluded.lastPublishedAt`).run(publisherId, day, artifactBytes, now.toISOString());
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
}

function normalizeAddress(value: string): string {
  return value.replace(/^::ffff:/, "").trim();
}

export function resolveClientIp(c: Context, trustedProxies: ReadonlySet<string>): string {
  const direct = normalizeAddress(getConnInfo(c).remote.address || "unknown");
  if (!trustedProxies.has(direct)) return direct;
  const chain = [...(c.req.header("x-forwarded-for")?.split(",").map(normalizeAddress).filter(Boolean) || []), direct];
  while (chain.length > 1 && trustedProxies.has(chain[chain.length - 1]!)) chain.pop();
  return chain[chain.length - 1] || direct;
}

export function rateLimitMiddleware(limiter: RateLimiter, trustedProxies: ReadonlySet<string>) {
  return async (c: Context, next: Next): Promise<Response | void> => {
    const ip = resolveClientIp(c, trustedProxies);
    if (!limiter.consume("global", "registry") || !limiter.consume("ip", ip)) {
      c.header("Retry-After", "1");
      return c.json({ error: "rate limit exceeded" }, 429);
    }
    return next();
  };
}
