import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

/**
 * Vite config for integration tests. Differences from vite.config.ts:
 *  - outDir → dist-integration (avoids clobbering the regular e2e build)
 *  - preview runs on port 4174 (4173 is the tier-1 e2e port)
 *  - preview.proxy routes /api to the test Nest server on :3002
 */
export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  build: {
    outDir: 'dist-integration',
    emptyOutDir: true,
  },
  define: {
    // Speed up the status poller so browser integration tests don't wait 20 s per cycle.
    'import.meta.env.VITE_STATUS_POLL_MS': '"3000"',
  },
  preview: {
    port: 4174,
    strictPort: true,
    proxy: {
      '/api': {
        target: 'http://localhost:3002',
        changeOrigin: true,
      },
    },
  },
});
