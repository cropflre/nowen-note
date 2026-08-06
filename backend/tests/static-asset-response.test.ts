import assert from "node:assert/strict";
import test from "node:test";
import { Hono } from "hono";
import { compress } from "hono/compress";

import {
  createStaticAssetHeaders,
  isImmutableFrontendAsset,
  isStaticAssetNotModified,
  mergeVaryHeader,
  selectStaticContentEncoding,
} from "../src/lib/static-asset-response";

const stat = {
  size: 4_948_304,
  mtime: new Date("2026-08-04T09:00:00.000Z"),
  mtimeMs: Date.parse("2026-08-04T09:00:00.000Z"),
};

test("hashed Vite assets are immutable for one year", () => {
  assert.equal(
    isImmutableFrontendAsset("/assets/index-Bejiefi6.js", "/app/frontend/dist/assets/index-Bejiefi6.js"),
    true,
  );
  const headers = createStaticAssetHeaders(
    "/assets/index-Bejiefi6.js",
    "/app/frontend/dist/assets/index-Bejiefi6.js",
    stat,
  );
  assert.equal(headers["Cache-Control"], "public, max-age=31536000, immutable");
  assert.match(headers.ETag, /^W\/\"[a-f0-9]+-[a-f0-9]+\"$/);
});

test("HTML is revalidated and unhashed assets get a short cache", () => {
  assert.equal(
    createStaticAssetHeaders("/", "/app/frontend/dist/index.html", stat)["Cache-Control"],
    "no-cache",
  );
  assert.equal(
    createStaticAssetHeaders("/favicon.svg", "/app/frontend/dist/favicon.svg", stat)["Cache-Control"],
    "public, max-age=3600",
  );
});

test("conditional requests match ETag or Last-Modified", () => {
  const responseHeaders = createStaticAssetHeaders(
    "/assets/index-Bejiefi6.js",
    "/app/frontend/dist/assets/index-Bejiefi6.js",
    stat,
  );
  assert.equal(
    isStaticAssetNotModified(new Headers({ "If-None-Match": responseHeaders.ETag }), responseHeaders),
    true,
  );
  assert.equal(
    isStaticAssetNotModified(new Headers({ "If-Modified-Since": responseHeaders["Last-Modified"] }), responseHeaders),
    true,
  );
  assert.equal(isStaticAssetNotModified(new Headers(), responseHeaders), false);
});

test("precompressed negotiation prefers Brotli and honors q=0", () => {
  assert.equal(
    selectStaticContentEncoding("gzip, deflate, br", { br: true, gzip: true }),
    "br",
  );
  assert.equal(
    selectStaticContentEncoding("br;q=0, gzip;q=0.8", { br: true, gzip: true }),
    "gzip",
  );
  assert.equal(
    selectStaticContentEncoding("*;q=0", { br: true, gzip: true }),
    null,
  );
  assert.equal(
    selectStaticContentEncoding("br", { br: false, gzip: true }),
    null,
  );
});

test("Vary preserves existing values without duplicates", () => {
  assert.equal(mergeVaryHeader("Origin", "Accept-Encoding"), "Origin, Accept-Encoding");
  assert.equal(
    mergeVaryHeader("Origin, accept-encoding", "Accept-Encoding"),
    "Origin, accept-encoding",
  );
});

test("Hono compresses large JavaScript assets when gzip is accepted", async () => {
  const app = new Hono();
  app.use("*", compress());
  const source = "const value = 'nowen-note';\n".repeat(2_000);
  app.get("/assets/index-testhash.js", (c) => c.body(source, 200, {
    "Content-Type": "application/javascript",
  }));

  const response = await app.request("/assets/index-testhash.js", {
    headers: { "Accept-Encoding": "gzip" },
  });
  assert.equal(response.headers.get("content-encoding"), "gzip");
  // Hono 4.6's generic compression middleware does not add Vary. The dedicated static delivery
  // runtime owns that header because it performs explicit Brotli/gzip representation negotiation.
  assert.ok((await response.arrayBuffer()).byteLength < source.length);
});
