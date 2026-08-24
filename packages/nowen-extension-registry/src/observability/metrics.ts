export type RegistryOperation = "oauth" | "publish" | "review" | "report" | "telemetry";

export interface RegistryMetricsSnapshot {
  uptimeSeconds: number;
  requests: {
    total: number;
    byStatusClass: Record<"2xx" | "3xx" | "4xx" | "5xx", number>;
    averageDurationMs: number;
    maxDurationMs: number;
  };
  rateLimited: {
    total: number;
    byScope: Record<string, number>;
  };
  operations: Record<RegistryOperation, { attempts: number; success: number; failure: number }>;
}

function operationFor(method: string, path: string): RegistryOperation | null {
  if (method === "POST" && path === "/v2/publish") return "publish";
  if (method === "POST" && /^\/v2\/extensions\/[^/]+\/reviews$/.test(path)) return "review";
  if (method === "POST" && /^\/v2\/extensions\/[^/]+\/reports$/.test(path)) return "report";
  if (method === "POST" && path === "/v2/telemetry") return "telemetry";
  if (path.startsWith("/oauth/")) return "oauth";
  return null;
}

function emptyOperation(): { attempts: number; success: number; failure: number } {
  return { attempts: 0, success: 0, failure: 0 };
}

/**
 * Low-cardinality, process-local operational metrics.
 * Never records IP addresses, developer/publisher IDs, request bodies, tokens, plugin IDs, or URLs.
 */
export class RegistryRuntimeMetrics {
  private readonly startedAt = Date.now();
  private requestsTotal = 0;
  private readonly statusClass = { "2xx": 0, "3xx": 0, "4xx": 0, "5xx": 0 };
  private durationTotalMs = 0;
  private durationMaxMs = 0;
  private rateLimitedTotal = 0;
  private readonly rateLimitedByScope = new Map<string, number>();
  private readonly operationCounts: Record<RegistryOperation, { attempts: number; success: number; failure: number }> = {
    oauth: emptyOperation(),
    publish: emptyOperation(),
    review: emptyOperation(),
    report: emptyOperation(),
    telemetry: emptyOperation(),
  };

  recordRequest(method: string, path: string, status: number, durationMs: number): void {
    this.requestsTotal += 1;
    const normalizedDuration = Number.isFinite(durationMs) ? Math.max(0, durationMs) : 0;
    this.durationTotalMs += normalizedDuration;
    this.durationMaxMs = Math.max(this.durationMaxMs, normalizedDuration);
    if (status >= 200 && status < 300) this.statusClass["2xx"] += 1;
    else if (status >= 300 && status < 400) this.statusClass["3xx"] += 1;
    else if (status >= 400 && status < 500) this.statusClass["4xx"] += 1;
    else this.statusClass["5xx"] += 1;

    const operation = operationFor(method, path);
    if (!operation) return;
    const counters = this.operationCounts[operation];
    counters.attempts += 1;
    if (status >= 200 && status < 400) counters.success += 1;
    else counters.failure += 1;
  }

  recordRateLimited(scope: string): void {
    const normalized = /^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/.test(scope) ? scope : "unknown";
    this.rateLimitedTotal += 1;
    this.rateLimitedByScope.set(normalized, (this.rateLimitedByScope.get(normalized) || 0) + 1);
  }

  snapshot(): RegistryMetricsSnapshot {
    const byScope = Object.fromEntries([...this.rateLimitedByScope.entries()].sort(([left], [right]) => left.localeCompare(right)));
    return {
      uptimeSeconds: Math.max(0, Math.floor((Date.now() - this.startedAt) / 1_000)),
      requests: {
        total: this.requestsTotal,
        byStatusClass: { ...this.statusClass },
        averageDurationMs: this.requestsTotal ? Math.round(this.durationTotalMs / this.requestsTotal) : 0,
        maxDurationMs: Math.round(this.durationMaxMs),
      },
      rateLimited: { total: this.rateLimitedTotal, byScope },
      operations: {
        oauth: { ...this.operationCounts.oauth },
        publish: { ...this.operationCounts.publish },
        review: { ...this.operationCounts.review },
        report: { ...this.operationCounts.report },
        telemetry: { ...this.operationCounts.telemetry },
      },
    };
  }
}

export const registryRuntimeMetrics = new RegistryRuntimeMetrics();
