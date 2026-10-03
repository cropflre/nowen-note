import { defineConfig } from "vite";
import { fileURLToPath } from "node:url";

// Isolated core/editor fixtures use a private loopback backend, never the user's database.
export default defineConfig({
  resolve: { alias: [
    { find: /^@\/store\/AppContext$/, replacement: fileURLToPath(new URL("./benchmarks/encrypted-notes-store.ts", import.meta.url)) },
    { find: "@", replacement: fileURLToPath(new URL("./src", import.meta.url)) },
  ] },
  esbuild: { jsx: "automatic" },
  // A document meta policy alone does not constrain an external worker's own WASM.
  preview: {
    headers: {
      "Content-Security-Policy": "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self' http://127.0.0.1:5177",
    },
  },
  build: {
    outDir: "node_modules/.cache/encrypted-notes-benchmark",
    emptyOutDir: true,
    rollupOptions: { input: ["benchmarks/encrypted-notes.html", "benchmarks/encrypted-notes-editor.html", "benchmarks/encrypted-notes-blocks.html", "benchmarks/encrypted-notes-product-editor.html", "benchmarks/encrypted-notes-cleanup.html"] },
  },
});
