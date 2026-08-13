import path from "node:path";
import { mergeConfig } from "vite";
import { defineConfig } from "vitest/config";

import viteConfig from "./vite.config";

export default mergeConfig(viteConfig, defineConfig({
  test: {
    setupFiles: [path.resolve(__dirname, "./src/components/__tests__/blockPatchWindowedEditor.setup.tsx")],
  },
}));
