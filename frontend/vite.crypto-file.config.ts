import { defineConfig } from "vite";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import benchmark from "./vite.crypto-benchmark.config";

// Exercise the deployment CSP and relative asset paths used by the real file entry.
const policy = fs.readFileSync(fileURLToPath(new URL("./index.html", import.meta.url)), "utf8")
  .match(/<meta\s+http-equiv="Content-Security-Policy"\s+content="([^"]+)"/)?.[1];
if (!policy) throw new Error("Production entry CSP is missing");
export default defineConfig({
  ...benchmark,
  base: "./",
  plugins: [{ name: "encrypted-file-csp", transformIndexHtml: () => [
    { tag: "meta", attrs: { "http-equiv": "Content-Security-Policy", content: policy }, injectTo: "head-prepend" },
  ] }],
  build: { ...benchmark.build, outDir: "node_modules/.cache/encrypted-notes-file" },
});
