import { defineConfig, externalizeDepsPlugin } from 'electron-vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: 'app/packages/desktop-main/src/electron-entry.ts',
        output: {
          format: 'es',
        },
      },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: 'app/packages/desktop-preload/src/preload.ts',
      },
    },
  },
  renderer: {
    root: 'app/packages/web',
    plugins: [react(), tailwindcss()],
    resolve: {
      alias: {
        '@': fileURLToPath(new URL('app/packages/web/src', import.meta.url)),
      },
    },
    build: {
      rollupOptions: {
        input: 'index.html',
      },
    },
  },
});
