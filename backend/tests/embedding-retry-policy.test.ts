import assert from "node:assert/strict";
import test from "node:test";
import { embeddingRetryDecision, embeddingRetryDelaySeconds, MAX_EMBEDDING_RETRIES } from "../src/services/embedding-retry-policy";

test("temporary HTTP and transport failures retry with bounded exponential backoff", () => {
  assert.deepEqual(embeddingRetryDecision(new Error("HTTP 429: rate limit"), 1), {
    retry: true, delaySeconds: 60, rateLimited: true,
  });
  assert.deepEqual(embeddingRetryDecision(new Error("HTTP 503: Service Unavailable"), 2), {
    retry: true, delaySeconds: 30, rateLimited: false,
  });
  assert.equal(embeddingRetryDecision(new Error("fetch failed ECONNRESET"), 3).retry, true);
  assert.equal(embeddingRetryDecision(new Error("HTTP 408"), 1).retry, true);
  assert.equal(embeddingRetryDecision(new Error("HTTP 502"), MAX_EMBEDDING_RETRIES).retry, false);
  assert.equal(embeddingRetryDelaySeconds(7, "HTTP 429"), 300);
});

test("permanent errors do not burn API quota by repeated attempts", () => {
  for (const message of ["HTTP 400 bad input", "HTTP 401 unauthorized", "HTTP 403 invalid key", "HTTP 404 missing model", "SQLITE_CONSTRAINT", "dimension mismatch"]) {
    const decision = embeddingRetryDecision(new Error(message), 1);
    assert.equal(decision.retry, false, message);
  }
});
