import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { parsePluginManifest } from "../src/plugins/manifest";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const sample = JSON.parse(fs.readFileSync(
  path.join(root, "examples/plugins/theme-pack/manifest.json"),
  "utf8",
));
const options = { extensionsV21: true, currentVersion: "1.6.0" } as const;

test("official Theme Pack is a zero-code Note Theme Contribution", () => {
  const parsed = parsePluginManifest(sample, options);
  assert.equal(parsed.runtime, "declarative");
  assert.deepEqual(parsed.permissions, []);
  assert.equal(parsed.contributes?.noteThemes?.length, 2);
  assert.equal(parsed.contributes?.noteThemes?.[0].modes.light.contentMaxWidth, "760px");
});

test("Note Theme Contribution uses the real host token names and rejects stale aliases", () => {
  const withLegacyToken = structuredClone(sample);
  withLegacyToken.contributes.noteThemes[0].modes.light.canvasBackground = "#ffffff";
  assert.throws(() => parsePluginManifest(withLegacyToken, options), /unrecognized/i);

  const withUnsafeValue = structuredClone(sample);
  withUnsafeValue.contributes.noteThemes[0].modes.light.surface = "url(https://evil.example/x)";
  assert.throws(() => parsePluginManifest(withUnsafeValue, options), /Note Theme/);
});
