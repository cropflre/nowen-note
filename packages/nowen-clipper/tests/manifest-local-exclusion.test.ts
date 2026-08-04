import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const manifestUrl = new URL("../public/manifest.json", import.meta.url);

const LOCAL_DEVELOPMENT_ORIGINS = [
  "http://localhost/*",
  "https://localhost/*",
  "http://127.0.0.1/*",
  "https://127.0.0.1/*",
  "http://[::1]/*",
  "https://[::1]/*",
];

test("persistent content script excludes local development origins", async () => {
  const manifest = JSON.parse(await readFile(manifestUrl, "utf8"));
  const contentScript = manifest.content_scripts?.[0];

  assert.ok(contentScript, "manifest should declare a content script");
  assert.deepEqual(contentScript.matches, ["<all_urls>"]);

  for (const origin of LOCAL_DEVELOPMENT_ORIGINS) {
    assert.ok(
      contentScript.exclude_matches?.includes(origin),
      `expected content_scripts.exclude_matches to include ${origin}`,
    );
  }
});

test("explicit clipping permissions remain available", async () => {
  const manifest = JSON.parse(await readFile(manifestUrl, "utf8"));

  assert.ok(manifest.permissions.includes("activeTab"));
  assert.ok(manifest.permissions.includes("scripting"));
  assert.deepEqual(manifest.host_permissions, ["<all_urls>"]);
});
