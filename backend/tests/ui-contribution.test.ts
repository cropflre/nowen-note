import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { parsePluginManifest } from "../src/plugins/manifest.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const sample = JSON.parse(fs.readFileSync(path.join(root, "examples/plugins/floating-dock/manifest.json"), "utf8"));
const alternative = JSON.parse(fs.readFileSync(path.join(root, "examples/plugins/alternative-launcher/manifest.json"), "utf8"));
const options = { extensionsV21: true, uiExtensions: true, currentVersion: "1.6.0" } as const;

test("official Floating Dock is a declarative zero-permission UI contribution", () => {
  const manifest = parsePluginManifest(sample, options);
  assert.equal(manifest.runtime, "declarative");
  assert.deepEqual(manifest.permissions, []);
  assert.equal(manifest.contributes.uiComponents?.length, 4);
  assert.equal("main" in manifest, false);
});

test("a second plugin can target the same slot without host changes", () => {
  const manifest = parsePluginManifest(alternative, options);
  assert.equal(manifest.contributes.uiComponents?.[0]?.defaultPlacement?.slot, "floating-layer");
});

test("UI contributions fail closed when the capability gate is disabled", () => {
  assert.throws(
    () => parsePluginManifest(sample, { extensionsV21: true, uiExtensions: false, currentVersion: "1.6.0" }),
    (error: Error & { code?: string }) => error.code === "PLUGIN_UI_FEATURE_DISABLED",
  );
});

test("unknown navigation targets and duplicate component ids are rejected", () => {
  const unsafe = structuredClone(sample);
  unsafe.contributes.uiComponents[0].action.target = "javascript:alert(1)";
  assert.throws(() => parsePluginManifest(unsafe, options));

  const duplicate = structuredClone(sample);
  duplicate.contributes.uiComponents[1].id = duplicate.contributes.uiComponents[0].id;
  assert.throws(() => parsePluginManifest(duplicate, options), /UI Component id 不能重复/);
});

test("official examples use the generic Host boundary without NavRail special cases", () => {
  const navRail = fs.readFileSync(path.join(root, "frontend/src/components/NavRail.tsx"), "utf8");
  const host = fs.readFileSync(path.join(root, "frontend/src/components/FloatingLayerHost.tsx"), "utf8");
  const app = fs.readFileSync(path.join(root, "frontend/src/App.tsx"), "utf8");
  assert.doesNotMatch(navRail, /nowenlab\.(?:floating-dock|alternative-launcher)/);
  assert.doesNotMatch(host, /nowenlab\.(?:floating-dock|alternative-launcher)/);
  assert.match(app, /<FloatingLayerHost \/>/);
});
