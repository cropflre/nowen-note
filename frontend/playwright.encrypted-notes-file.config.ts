import { defineConfig } from "@playwright/test";
import electron from "./playwright.encrypted-notes-electron.config";

process.env.NOWEN_ENCRYPTED_FILE = "1";
export default defineConfig({
  ...electron,
  testMatch: ["encrypted-notes-file.spec.ts", "encrypted-notes-product-editor.spec.ts"],
  outputDir: "node_modules/.cache/encrypted-notes-file-results",
  projects: [{ name: "file" }, { name: "asar" }],
  // File resources are read from disk; only the isolated API fixture is served.
  webServer: Array.isArray(electron.webServer) ? electron.webServer.slice(0, 1) : electron.webServer,
});
