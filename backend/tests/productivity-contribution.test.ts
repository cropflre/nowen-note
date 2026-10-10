import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { parsePluginManifest } from "../src/plugins/manifest.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const sample = JSON.parse(fs.readFileSync(path.join(root, "examples/plugins/productivity-pack/manifest.json"), "utf8"));
const options = { extensionsV21: true, currentVersion: "1.6.0" } as const;

test("official Productivity Pack is zero-code and zero-permission", () => {
  const manifest = parsePluginManifest(sample, options);
  assert.equal(manifest.runtime, "declarative");
  assert.deepEqual(manifest.permissions, []);
  assert.equal(manifest.contributes?.noteTemplates?.length, 2);
  assert.equal(manifest.contributes?.promptPacks?.length, 2);
  assert.equal("main" in manifest, false);
});

test("unsafe static template content is rejected before install", () => {
  const invalid = structuredClone(sample);
  invalid.contributes.noteTemplates[0].body = "<script>alert(1)</script>";
  assert.throws(() => parsePluginManifest(invalid, options), /不安全内容/);
});

test("oversized prompt is rejected before install", () => {
  const invalid = structuredClone(sample);
  invalid.contributes.promptPacks[0].prompt = "x".repeat(65537);
  assert.throws(() => parsePluginManifest(invalid, options), /64KiB/);
});
