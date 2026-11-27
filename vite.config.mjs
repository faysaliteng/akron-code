import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  base: './',
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    target: 'chrome126',
    sourcemap: false,
    chunkSizeWarningLimit: 3500,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (!id || !id.includes('node_modules')) return undefined;
          const norm = id.replace(/\\/g, '/');
          if (norm.includes('/monaco-editor/')) return 'vendor-monaco';
          if (/\/(mermaid|cytoscape|dagre|elkjs|khroma|stylis)\//.test(norm)) return 'vendor-diagrams';
          if (/\/(markmap-|katex|d3(-[a-z]+)?)\//.test(norm)) return 'vendor-math';
          if (/\/(xlsx|pdf-lib|docx|pptxgenjs|jszip|mammoth)\//.test(norm)) return 'vendor-office';
          return undefined;
        },
      },
    },
  },
  server: {
    port: 5173,
    strictPort: false,
  },
});
