import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      // Point @gsd/shared imports at the TypeScript source so `vitest run`
      // works without first running `npm run build -w @gsd/shared`. Runtime
      // (Nest server + Lambda bundles) still use the built dist/ via the
      // package.json "main" field — this alias only applies inside Vitest.
      '@gsd/shared': resolve(__dirname, 'packages/shared/src/index.ts'),
      // The @gsd/web package uses `@/foo` as a shortcut for `./src/foo`
      // (matches its tsconfig + Vite config). Re-declare it here so the
      // same imports resolve under Vitest.
      '@': resolve(__dirname, 'packages/web/src'),
    },
  },
  test: {
    include: ['packages/**/*.test.{ts,tsx}'],
    // Default environment for server-side and shared tests is Node.
    // React component tests under @gsd/web override this via
    // `environmentMatchGlobs` so they get a real DOM.
    environment: 'node',
    environmentMatchGlobs: [['packages/web/**', 'jsdom']],
    setupFiles: ['./vitest.setup.ts'],
    globals: false,
    clearMocks: true,
    restoreMocks: true,
    coverage: {
      provider: 'v8',
      // Measure all source files, not just those touched by tests.
      // Scoped to src/ trees so Playwright e2e files, Vite/Playwright configs,
      // and other non-unit-tested support files are excluded by default.
      // Double-star is needed because lambda packages nest under packages/lambda/*.
      include: ['packages/**/src/**/*.{ts,tsx}'],
      exclude: [
        'packages/**/*.test.{ts,tsx}',
        'packages/**/*.d.ts',
        'packages/**/dist/**',
        'packages/server/src/generated/**',
        'packages/web/src/generated/**',
      ],
      // text: printed to console after each run.
      // lcov: machine-readable format; available for future Codecov integration.
      reporter: ['text', 'lcov'],
      reportsDirectory: './coverage',
      thresholds: {
        statements: 64,
        branches: 75,
        functions: 67,
        lines: 64,
      },
    },
  },
  esbuild: {
    target: 'es2022',
  },
});
