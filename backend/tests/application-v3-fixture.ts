import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import JSZip from "jszip";
import { validatePluginPackage } from "../src/plugins/packageValidator.js";
import type { PluginService } from "../src/plugins/pluginService.js";

export const exampleDirectory = fileURLToPath(new URL("../../examples/plugins/hello-nowen-app/", import.meta.url));
export const V3_GATES = ["NOWEN_EXTENSIONS_V21", "NOWEN_UI_EXTENSIONS", "NOWEN_UI_LAYOUT_EDITOR", "NOWEN_SANDBOXED_PLUGIN_UI", "NOWEN_EXTENSION_V3_CORE", "NOWEN_EXTENSION_V3_APP_PAGES"];
export async function examplePackage(id = "nowenlab.hello-app") {
  const manifest = JSON.parse(fs.readFileSync(path.join(exampleDirectory, "manifest.json"), "utf8")); manifest.id = id;
  const zip = new JSZip(); zip.file("manifest.json", JSON.stringify(manifest));
  for (const file of Object.keys(manifest.contributes.uiAssets)) zip.file(file, fs.readFileSync(path.join(exampleDirectory, file)));
  return zip.generateAsync({ type: "nodebuffer" });
}
// Simulate only a future compatible host in disposable tests. Production still rejects 1.5.x.
export function futureCompatibleFixture(service: PluginService) {
  if (process.env.NODE_ENV !== "test") throw new Error("A disposable test runtime is required");
  const resolve = service.policy.resolve.bind(service.policy);
  service.policy.resolve = input => resolve(input.manifest.apiVersion === 3
    ? { ...input, manifest: { ...input.manifest, engines: { nowen: ">=1.5.0" } } } : input);
  service.installer.inspect = bytes => validatePluginPackage(bytes, { currentVersion: "1.6.0" });
}
