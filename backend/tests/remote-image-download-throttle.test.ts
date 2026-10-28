import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nowen-image-download-"));
process.env.DB_PATH = path.join(directory, "test.db");
process.env.ELECTRON_USER_DATA = directory;

test("download reports HTTP 429 cooldown and gates redirects before each fetch", async (t) => {
  const { downloadRemoteImage } = await import("../src/services/remote-image-import");
  const visited: string[] = [];
  const calls: string[] = [];
  t.mock.method(globalThis, "fetch", async (url: URL) => {
    calls.push(url.hostname);
    assert.equal(visited.at(-1), url.hostname);
    return calls.length === 1
      ? new Response(null, { status: 302, headers: { location: "https://1.0.0.1/limited.png" } })
      : new Response("slow down", { status: 429, headers: { "retry-after": "60" } });
  });
  await assert.rejects(downloadRemoteImage("https://1.1.1.1/image.png", {
    beforeRequest: async (url) => { visited.push(url.hostname); },
  }), (error: any) => {
    assert.equal(error.code, "REMOTE_IMAGE_RATE_LIMITED");
    assert.equal(error.retryAfterMs, 60_000);
    assert.equal(error.hostname, "1.0.0.1");
    return true;
  });
  assert.deepEqual(visited, ["1.1.1.1", "1.0.0.1"]);
});

test("host cooldown does not consume the image network timeout", async (t) => {
  const { downloadRemoteImage } = await import("../src/services/remote-image-import");
  process.env.REMOTE_IMAGE_TIMEOUT_MS = "10";
  t.mock.method(globalThis, "fetch", async (_url: URL, init: RequestInit) => {
    assert.equal(init.signal?.aborted, false);
    return new Response(Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64"), { headers: { "content-type": "image/png" } });
  });
  try {
    const downloaded = await downloadRemoteImage("https://1.1.1.1/image.png", {
      beforeRequest: async () => { await new Promise((resolve) => setTimeout(resolve, 30)); },
    });
    assert.equal(downloaded.mimeType, "image/png");
  } finally { delete process.env.REMOTE_IMAGE_TIMEOUT_MS; }
});
