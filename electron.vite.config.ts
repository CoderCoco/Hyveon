import { defineConfig, externalizeDepsPlugin, swcPlugin } from 'electron-vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { fileURLToPath } from 'node:url';

/** Resolve a path relative to this config file, regardless of cwd. */
const r = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  main: {
    // `@nestjs/microservices` is bundled into the main process here, and its
    // optional-transport loader statically pulls in `@grpc/proto-loader`. Even
    // though we use a custom Electron IPC transport (never gRPC), that import
    // is hoisted to a top-level `import` in the ES bundle and must resolve at
    // startup or the main process throws ERR_MODULE_NOT_FOUND before any window
    // opens. `@grpc/proto-loader` is therefore a required dependency of
    // `@hyveon/desktop-main` despite appearing unused — do not remove it.
    //
    // `swcPlugin()` swaps electron-vite's default esbuild transform for SWC
    // for this build only. Nest's DI container relies on TypeScript's
    // `emitDecoratorMetadata` (enabled in `app/tsconfig.base.json`) to read
    // constructor parameter types at runtime via `reflect-metadata`. esbuild
    // does not implement `emitDecoratorMetadata` — it strips decorators
    // without emitting the `design:paramtypes` metadata, so every
    // `@Injectable()`/`@Controller()` constructor loses its parameter types
    // and Nest can't resolve providers, crashing the main process at
    // bootstrap. SWC's decorator transform does emit that metadata, so it's
    // used here in place of esbuild. The renderer and preload builds don't
    // use Nest DI and stay on the default esbuild transform.
    plugins: [externalizeDepsPlugin(), swcPlugin()],
    build: {
      rollupOptions: {
        input: r('app/packages/desktop-main/src/electron-entry.ts'),
        // `@cdktf/hcl2json` must stay external (loaded from node_modules at
        // runtime), never bundled, for two reasons:
        //  1. Its wasm bridge reads `main.wasm.gz` relative to its own module
        //     file (`join(__dirname, '..', 'main.wasm.gz')`). Bundled, that
        //     resolves to `out/main.wasm.gz`, which doesn't exist — the read
        //     rejects and every later `parse()` call awaits a `ready` flag
        //     that never flips, so `games.list` would hang forever.
        //  2. The bundled copy of its Go `wasm_exec` glue runs module-scope
        //     side effects at app startup that prevent Electron from ever
        //     quitting — `app.close()` in Playwright's electron project then
        //     hangs until the worker teardown timeout, failing every spec.
        // The external package also keeps the patch-package fix
        // (patches/@cdktf+hcl2json+0.21.0.patch) in effect. electron-builder.yml
        // packages the module (and its transitive deps) into the installer.
        external: ['@cdktf/hcl2json'],
        output: {
          format: 'es',
          entryFileNames: 'index.js',
        },
      },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: r('app/packages/desktop-preload/src/preload.ts'),
      },
    },
  },
  renderer: {
    root: r('app/packages/web'),
    plugins: [react(), tailwindcss()],
    resolve: {
      alias: {
        '@': r('app/packages/web/src'),
      },
    },
    build: {
      rollupOptions: {
        input: r('app/packages/web/index.html'),
      },
    },
  },
});
