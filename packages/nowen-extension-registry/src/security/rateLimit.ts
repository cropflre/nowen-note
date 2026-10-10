import type { DatabaseSync } from "node:sqlite";
import { getConnInfo } from "@hono/node-server/conninfo";
import type { Context, Next } from "hono";
import { registryRuntimeMetrics } from "../observability/metrics.js";

interface BucketPolicy {
  capacity: number;
  refillPerSecond: number;
}

const POLICIES = {
  global: { capacity: 1_000, refillPerSecond: 100 },
  ip: { capacity: 120, refillPerSecond: 2 },
  account: { capacity: 300, refillPerSecond: 5 },
  publisher: { capacity: 120, refillPerSecond: 2 },
  authIp: { capacity: 60, refillPerSecond: 0.5 },
  publishIp: { capacity: 20, refillPerSecond: 1 / 120 },
  communityWriteIp: { capacity: 120, refillPerSecond: 2 },
  telemetryIp: { capacity: 240, refillPerSecond: 4 },
  adminWriteIp: { capacity: 30, refillPerSecond: 0.5 },
} satisfies Record<string, BucketPolicy>;

export type RateLimitScope = keyof typeof POLICIES;

export interface RateLimitDecision {
  allowed: boolean;
  retryAfterSeconds: number;
  remaining: number;
}

export interface RouteAbusePolicy {
  scope: RateLimitScope;
  cost: number;
}

export interface PublishLimits {
  maxArtifactBytes: number;
  cooldownSeconds: number;
  dailyCount: number;
  dailyBytes: number;
}

export class RateLimiter {
  constructor(private readonly db: DatabaseSync) {}

  consumeDetailed(scope: RateLimitScope, id: string, cost = 1): RateLimitDecision {
    const policy = POLICIES[scope];
    if (!Number.isFinite(cost) || cost <= 0 || cost > policy.capacity) throw new Error("rate limit cost is invalid");
    const key = `${scope}:${id}`;
    const now = Date.now();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const row = this.db.prepare("SELECT tokens,updatedAt FROM rate_limit_buckets WHERE bucketKey=?").get(key) as { tokens: number; updatedAt: number } | undefined;
      const replenished = row
        ? Math.min(policy.capacity, row.tokens + Math.max(0, now - row.updatedAt) / 1_000 * policy.refillPerSecond)
        : policy.capacity;
      const allowed = replenished >= cost;
      const nextTokens = allowed ? replenished - cost : replenished;
      this.db.prepare(`INSERT INTO rate_limit_buckets(bucketKey,tokens,updatedAt) VALUES (?,?,?)
        ON CONFLICT(bucketKey) DO UPDATE SET tokens=excluded.tokens,updatedAt=excluded.updatedAt`).run(key, nextTokens, now);
      this.db.exec("COMMIT");
      const deficit = Math.max(0, cost - replenished);
      return {
        allowed,
        retryAfterSeconds: allowed ? 0 : Math.max(1, Math.ceil(deficit / policy.refillPerSecond)),
        remaining: Math.max(0, Math.floor(nextTokens)),
      };
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  consume(scope: RateLimitScope, id: string, cost = 1): boolean {
    return this.consumeDetailed(scope, id, cost).allowed;
  }

  assertPublishAvailable(publisherId: string, artifactBytes: number, limits: PublishLimits): void {
    if (artifactBytes <= 0 || artifactBytes > limits.maxArtifactBytes) throw new Error(`artifact exceeds ${limits.maxArtifactBytes} bytes`);
    const now = new Date();
    const day = now.toISOString().slice(0, 10);
    const row = this.db.prepare("SELECT publishCount,artifactBytes,lastPublishedAt FROM publisher_quotas WHERE publisherId=? AND day=?").get(publisherId, day) as { publishCount: number; artifactBytes: number; lastPublishedAt: string | null } | undefined;
    this.validatePublishQuota(row, artifactBytes, limits, now);
  }

  consumePublish(publisherId: string, artifactBytes: number, limits: PublishLimits): void {
    this.assertPublishAvailable(publisherId, artifactBytes, limits);
    if (!this.consume("publisher", publisherId, 10)) throw new Error("publisher rate limit exceeded");
    const now = new Date();
    const day = now.toISOString().slice(0, 10);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const row = this.db.prepare("SELECT publishCount,artifactBytes,lastPublishedAt FROM publisher_quotas WHERE publisherId=? AND day=?").get(publisherId, day) as { publishCount: number; artifactBytes: number; lastPublishedAt: string | null } | undefined;
      this.validatePublishQuota(row, artifactBytes, limits, now);
      this.db.prepare(`INSERT INTO publisher_quotas(publisherId,day,publishCount,artifactBytes,lastPublishedAt) VALUES (?,?,1,?,?)
        ON CONFLICT(publisherId,day) DO UPDATE SET publishCount=publishCount+1,artifactBytes=artifactBytes+excluded.artifactBytes,lastPublishedAt=excluded.lastPublishedAt`).run(publisherId, day, artifactBytes, now.toISOString());
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  private validatePublishQuota(
    row: { publishCount: number; artifactBytes: number; lastPublishedAt: string | null } | undefined,
    artifactBytes: number,
    limits: PublishLimits,
    now: Date,
  ): void {
    if (row?.lastPublishedAt && now.getTime() - Date.parse(row.lastPublishedAt) < limits.cooldownSeconds * 1_000) throw new Error("publisher publish cooldown is active");
    if ((row?.publishCount || 0) + 1 > limits.dailyCount) throw new Error("publisher daily publish quota exceeded");
    if ((row?.artifactBytes || 0) + artifactBytes > limits.dailyBytes) throw new Error("publisher daily artifact quota exceeded");
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

/** Fixed-cardinality route classes used only for abuse protection; no route parameters are persisted. */
export function abusePolicyForRequest(method: string, path: string): RouteAbusePolicy | null {
  if (method === "OPTIONS" || path === "/health" || path.startsWith("/health/")) return null;
  if (path.startsWith("/oauth/") || method === "POST" && path === "/v2/admin/session") return { scope: "authIp", cost: 1 };
  if (method === "POST" && path === "/v2/publish") return { scope: "publishIp", cost: 1 };
  if (method === "POST" && path === "/v2/telemetry") return { scope: "telemetryIp", cost: 1 };
  if (method === "POST" && path.startsWith("/v2/admin/")) return { scope: "adminWriteIp", cost: 1 };
  if (method !== "GET" && method !== "HEAD" && path.startsWith("/v2/")) return { scope: "communityWriteIp", cost: 1 };
  return null;
}

function rateLimitedResponse(c: Context, scope: RateLimitScope, retryAfterSeconds: number): Response {
  registryRuntimeMetrics.recordRateLimited(scope);
  c.header("Retry-After", String(Math.max(1, retryAfterSeconds)));
  c.header("X-RateLimit-Scope", scope);
  return c.json({ error: "rate limit exceeded", code: "REGISTRY_RATE_LIMITED" }, 429);
}

export function rateLimitMiddleware(limiter: RateLimiter, trustedProxies: ReadonlySet<string>) {
  return async (c: Context, next: Next): Promise<Response | void> => {
    const startedAt = Date.now();
    const method = c.req.method.toUpperCase();
    const path = c.req.path;
    try {
      const healthOrPreflight = method === "OPTIONS" || path === "/health" || path.startsWith("/health/");
      if (!healthOrPreflight) {
        const ip = resolveClientIp(c, trustedProxies);
        const global = limiter.consumeDetailed("global", "registry");
        if (!global.allowed) return rateLimitedResponse(c, "global", global.retryAfterSeconds);
        const byIp = limiter.consumeDetailed("ip", ip);
        if (!byIp.allowed) return rateLimitedResponse(c, "ip", byIp.retryAfterSeconds);
        const abuse = abusePolicyForRequest(method, path);
        if (abuse) {
          const route = limiter.consumeDetailed(abuse.scope, ip, abuse.cost);
          if (!route.allowed) return rateLimitedResponse(c, abuse.scope, route.retryAfterSeconds);
        }
      }
      await next();
      registryRuntimeMetrics.recordRequest(method, path, c.res.status || 200, Date.now() - startedAt);
      return undefined;
    } catch (error) {
      registryRuntimeMetrics.recordRequest(method, path, 500, Date.now() - startedAt);
      throw error;
    }
  };
}
