import { defineConfig } from "@playwright/test";
import filesAssets from "./playwright.files-assets.config";

export default defineConfig({
  ...filesAssets,
  testMatch: "attachment-upload-recovery.spec.ts",
  outputDir: "node_modules/.cache/attachment-upload-results",
});
