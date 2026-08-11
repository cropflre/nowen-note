import assert from "node:assert/strict";
import test from "node:test";
import { brotliCompressSync } from "node:zlib";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Hono } from "hono";
import { compress } from "hono/compress";

import {
  resolvePrecompressedSourcePath,
} from "../src/runtime/static-precompressed-assets";

test("production wildcard route serves a precompressed hashed asset", async () => {
  const previousNodeEnv = process.env.NODE_ENV;
  const previousFrontendDist = process.env.FRONTEND_DIST;
  const dist = await mkdtemp(path.join(os.tmpdir(), "nowen-static-"));
  const assetsDir = path.join(dist, "assets");
  await mkdir(assetsDir, { recursive: true });

  const source = Buffer.from("const nowen = 'note';\n".repeat(2_000));
  const compressed = brotliCompressSync(source);
  const sourcePath = path.join(assetsDir, "index-TestHash9.js");
  await writeFile(sourcePath, source);
  await writeFile(`${sourcePath}.br`, compressed);

  process.env.NODE_ENV = "production";
  process.env.FRONTEND_DIST = dist;

  try {
    assert.equal(resolvePrecompressedSourcePath("/assets/index-TestHash9.js"), sourcePath);
    assert.equal(resolvePrecompressedSourcePath("/../../etc/passwd.js"), null);

    const app = new Hono();
    // Mirror index.ts: compression is registered first, then the first API router mount triggers
    // the runtime insertion, and the legacy SPA wildcard is registered last.
    app.use("*", compress());
    app.route("/api", new Hono());
    app.get("*", (c) => c.text("fallback"));

    const response = await app.request("/assets/index-TestHash9.js", {
      headers: { "Accept-Encoding": "gzip, br" },
    });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-encoding"), "br");
    assert.match(response.headers.get("cache-control") || "", /immutable/);
    assert.match(response.headers.get("vary") || "", /Accept-Encoding/i);
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), compressed);

    const etag = response.headers.get("etag");
    assert.ok(etag);
    const revalidated = await app.request("/assets/index-TestHash9.js", {
      headers: {
        "Accept-Encoding": "br",
        "If-None-Match": etag,
      },
    });
    assert.equal(revalidated.status, 304);

    // Avoid mentioning gzip here because Hono 4.6's generic middleware only checks whether the
    // token text is present and does not parse q=0. This assertion targets our Brotli negotiation.
    const identity = await app.request("/assets/index-TestHash9.js", {
      headers: { "Accept-Encoding": "br;q=0, identity" },
    });
    assert.equal(identity.headers.get("content-encoding"), null);
    assert.equal(await identity.text(), "fallback");
  } finally {
    if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previousNodeEnv;
    if (previousFrontendDist === undefined) delete process.env.FRONTEND_DIST;
    else process.env.FRONTEND_DIST = previousFrontendDist;
    await rm(dist, { recursive: true, force: true });
  }
});
