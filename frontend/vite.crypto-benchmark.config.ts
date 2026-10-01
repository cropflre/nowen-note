import { defineConfig } from "vite";

// Build the internal core independently; normal app routes do not enable encryption yet.
export default defineConfig({
  // A document meta policy alone does not constrain an external worker's own WASM.
  preview: {
    headers: {
      "Content-Security-Policy": "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'",
    },
  },
  build: {
    outDir: "node_modules/.cache/encrypted-notes-benchmark",
    emptyOutDir: true,
    rollupOptions: { input: "benchmarks/encrypted-notes.html" },
  },
});
