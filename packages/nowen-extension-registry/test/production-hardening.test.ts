import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { loadRegistryConfig } from "../src/config.js";
import { registryRuntimeMetrics } from "../src/observability/metrics.js";
import { createHealthRoutes } from "../src/routes/health.js";
import { openRegistry } from "../src/schema.js";
import { abusePolicyForRequest, RateLimiter } from "../src/security/rateLimit.js";
import type { ArtifactStore } from "../src/storage/artifactStore.js";
import { LocalArtifactStore } from "../src/storage/localArtifactStore.js";

function tempRoot(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function productionEnv(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const { privateKey, publicKey } = crypto.generateKeyPairSync("ed25519");
  const privatePem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const publicPem = publicKey.export({ type: "spki", format: "pem" }).toString();
  return {
    REGISTRY_ENV: "production",
    REGISTRY_DATA: tempRoot("nowen-registry-config-"),
    REGISTRY_PUBLIC_URL: "https://registry.example.com",
    REGISTRY_SESSION_SECRET: "x".repeat(64),
    REGISTRY_ALLOWED_ORIGINS: "https://registry.example.com",
    REGISTRY_TRUSTED_PROXIES: "127.0.0.1,::1",
    REGISTRY_SIGNING_PRIVATE_KEY: privatePem,
    REGISTRY_SIGNER_KEY_ID: "root-2026",
    REGISTRY_SIGNER_SEQUENCE: "0",
    REGISTRY_SIGNER_VALID_FROM: "2026-01-01T00:00:00.000Z",
    REGISTRY_SIGNER_VALID_UNTIL: "2030-01-01T00:00:00.000Z",
    REGISTRY_INITIAL_ROOT_KEY_ID: "root-2026",
    REGISTRY_INITIAL_ROOT_PUBLIC_KEY: publicPem,
    REGISTRY_INITIAL_ROOT_VALID_FROM: "2026-01-01T00:00:00.000Z",
    REGISTRY_INITIAL_ROOT_VALID_UNTIL: "2030-01-01T00:00:00.000Z",
    GITHUB_CLIENT_ID: "github-client-id",
    GITHUB_CLIENT_SECRET: "github-client-secret",
    GITHUB_OAUTH_CALLBACK_URL: "https://registry.example.com/oauth/github/callback",
    REGISTRY_ARTIFACT_STORE: "s3",
    REGISTRY_S3_REGION: "us-east-1",
    REGISTRY_S3_BUCKET: "nowen-registry-artifacts",
    AWS_ACCESS_KEY_ID: "test-access-key",
    AWS_SECRET_ACCESS_KEY: "test-secret-key",
    REGISTRY_ARTIFACT_CDN_BASE_URL: "https://cdn.example.com/nowen/",
    ...overrides,
  };
}

test("production config requires HTTPS delivery and non-local artifact storage", () => {
  const valid = loadRegistryConfig(productionEnv());
  assert.equal(valid.environment, "production");
  assert.equal(valid.artifactStorage.driver, "s3");
  assert.equal(valid.artifactCdnBaseUrl?.protocol, "https:");

  assert.throws(
    () => loadRegistryConfig(productionEnv({ REGISTRY_ARTIFACT_CDN_BASE_URL: "http://cdn.example.com/" })),
    /must use https in production/,
  );
  assert.throws(
    () => loadRegistryConfig(productionEnv({ REGISTRY_ARTIFACT_STORE: "local" })),
    /local artifact storage is only allowed/,
  );
});

test("health exposes independent liveness/readiness/status without secret error details", async () => {
  const root = tempRoot("nowen-registry-health-");
  const config = loadRegistryConfig({ REGISTRY_ENV: "development", REGISTRY_DATA: root });
  const db = openRegistry(path.join(root, "registry.db"));
  const store = new LocalArtifactStore(path.join(root, "artifacts"));
  try {
    const app = createHealthRoutes(db, config, store);
    const live = await app.request("http://registry.test/live");
    assert.equal(live.status, 200);
    const liveBody = await live.json() as Record<string, unknown>;
    assert.equal(liveBody.probe, "liveness");
    assert.equal("components" in liveBody, false);

    const ready = await app.request("http://registry.test/ready");
    assert.equal(ready.status, 200);
    const readyText = await ready.text();
    assert.match(readyText, /\"probe\":\"readiness\"/);
    assert.doesNotMatch(readyText, /PRIVATE KEY|session-secret|access-key|secretAccessKey/i);

    registryRuntimeMetrics.recordRequest("POST", "/v2/publish", 201, 12);
    const status = await app.request("http://registry.test/status");
    assert.equal(status.status, 200);
    const statusText = await status.text();
    assert.match(statusText, /\"storage\"/);
    assert.match(statusText, /\"runtime\"/);
    assert.doesNotMatch(statusText, /development-only-session-secret-change-me|PRIVATE KEY|github-client-secret/i);
  } finally {
    db.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("readiness hides artifact backend failure details", async () => {
  const root = tempRoot("nowen-registry-health-fail-");
  const config = loadRegistryConfig({ REGISTRY_ENV: "development", REGISTRY_DATA: root });
  const db = openRegistry(path.join(root, "registry.db"));
  const failingStore: ArtifactStore = {
    async stage() { throw new Error("not used"); },
    async commit() { throw new Error("not used"); },
    async read() { throw new Error("not used"); },
    async exists() { return false; },
    async removeStaged() {},
    async health() { return { ok: false, detail: "AWS_SECRET_ACCESS_KEY=should-never-leak" }; },
  };
  try {
    const app = createHealthRoutes(db, config, failingStore);
    const response = await app.request("http://registry.test/ready");
    assert.equal(response.status, 503);
    const text = await response.text();
    assert.match(text, /\"artifactStore\":\{\"ok\":false\}/);
    assert.doesNotMatch(text, /should-never-leak|AWS_SECRET_ACCESS_KEY/);
  } finally {
    db.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("route abuse classes are fixed and health/preflight are exempt", () => {
  assert.equal(abusePolicyForRequest("GET", "/health/live"), null);
  assert.equal(abusePolicyForRequest("OPTIONS", "/v2/publish"), null);
  assert.deepEqual(abusePolicyForRequest("GET", "/oauth/github/callback"), { scope: "authIp", cost: 1 });
  assert.deepEqual(abusePolicyForRequest("POST", "/v2/publish"), { scope: "publishIp", cost: 1 });
  assert.deepEqual(abusePolicyForRequest("POST", "/v2/extensions/demo/reviews"), { scope: "communityWriteIp", cost: 1 });
  assert.deepEqual(abusePolicyForRequest("POST", "/v2/admin/advisories"), { scope: "adminWriteIp", cost: 1 });
  assert.deepEqual(abusePolicyForRequest("POST", "/v2/telemetry"), { scope: "telemetryIp", cost: 1 });
});

test("token bucket returns deterministic Retry-After when exhausted", () => {
  const root = tempRoot("nowen-registry-rate-");
  const db = openRegistry(path.join(root, "registry.db"));
  try {
    const limiter = new RateLimiter(db);
    for (let index = 0; index < 60; index += 1) {
      assert.equal(limiter.consumeDetailed("authIp", "203.0.113.10").allowed, true);
    }
    const denied = limiter.consumeDetailed("authIp", "203.0.113.10");
    assert.equal(denied.allowed, false);
    assert.ok(denied.retryAfterSeconds >= 1);
    assert.equal(denied.remaining, 0);
  } finally {
    db.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
