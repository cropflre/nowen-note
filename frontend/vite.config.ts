import path from "path"
import react from "@vitejs/plugin-react"
import { defineConfig } from "vite"

export default defineConfig({
  root: path.resolve(__dirname),
  plugins: [react()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  optimizeDeps: {
    esbuildOptions: {
      keepNames: true,
    },
  },
  build: {
    sourcemap: false,
    // 降低 chunk 大小警告阈值
    chunkSizeWarningLimit: 2000,
    rollupOptions: {
      output: {
        // 手动分包，降低构建内存峰值
        manualChunks: {
          'vendor-react': ['react', 'react-dom'],
          'vendor-tiptap': [
            '@tiptap/react',
            '@tiptap/starter-kit',
            '@tiptap/extension-code-block-lowlight',
            '@tiptap/extension-highlight',
            '@tiptap/extension-image',
            '@tiptap/extension-placeholder',
            '@tiptap/extension-task-item',
            '@tiptap/extension-task-list',
            '@tiptap/extension-underline',
          ],
          'vendor-univer': ['@univerjs/presets'],
          'vendor-ui': [
            'framer-motion',
            'lucide-react',
            'react-icons',
          ],
          'vendor-utils': [
            'jszip',
            'xlsx',
            'react-markdown',
            'remark-gfm',
            'turndown',
            'date-fns',
            'i18next',
            'react-i18next',
          ],
        },
      },
    },
  },
  server: {
    host: "0.0.0.0",
    allowedHosts: true,
    proxy: {
      "/api": {
        target: "http://localhost:3001",
        changeOrigin: true,
      },
    },
  },
})
