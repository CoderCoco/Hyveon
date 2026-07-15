import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      // Point @hyveon/shared imports at the TypeScript source so `vitest run`
      // works without first running `npm run build -w @hyveon/shared`. Runtime
      // (Nest server + Lambda bundles) still use the built dist/ via the
      // package.json "main" field — this alias only applies inside Vitest.
      // The subpath alias must come first: alias matching replaces the key
      // with its target, so '@hyveon/shared' (matched via startsWith) would
      // otherwise shadow '@hyveon/shared/gameServerValidator' and resolve to
      // an invalid path.
      '@hyveon/shared/gameServerValidator': resolve(__dirname, 'packages/shared/src/gameServerValidator.ts'),
      '@hyveon/shared': resolve(__dirname, 'packages/shared/src/index.ts'),
      // Same rationale as @hyveon/shared above — desktop-main imports
      // @hyveon/cloud-aws directly, and CI runs `vitest run` without a prior
      // `npm run build -w @hyveon/cloud-aws`, so its dist/ never exists.
      '@hyveon/cloud-aws': resolve(__dirname, 'packages/cloud-aws/src/index.ts'),
      // The @hyveon/web package uses `@/foo` as a shortcut for `./src/foo`
      // (matches its tsconfig + Vite config). Re-declare it here so the
      // same imports resolve under Vitest.
      '@': resolve(__dirname, 'packages/web/src'),
    },
  },
  test: {
    // Cap the worker pool so the suite can't fan out to one process per core.
    // On high-core dev boxes (e.g. 32 cores) the default spawns one worker per
    // core, each ballooning to ~1 GB under jsdom + large module graphs, which
    // exhausts RAM/swap and OOMs the machine. The `forks` pool also reclaims
    // memory better between files than the default `threads` pool. Four forks
    // (~4 GB) keeps the suite fast without starving the host; CI boxes with
    // fewer cores are unaffected since the cap is only an upper bound.
    pool: 'forks',
    maxWorkers: 4,
    minWorkers: 1,
    poolOptions: {
      forks: {
        maxForks: 4,
        minForks: 1,
      },
    },
    include: [
      'packages/**/*.test.{ts,tsx}',
      // Explicitly include desktop-preload specs so they are always discovered.
      'packages/desktop-preload/**/*.test.{ts,tsx}',
      // Top-level test helpers (e.g. fake-terraform.mjs) live outside packages/.
      'test/**/*.test.{ts,tsx}',
      // The tfvars-sync helper lives in the top-level @hyveon/scripts workspace
      // (outside packages/), so it needs its own explicit include entry.
      '../scripts/tfvars-sync.test.ts',
      // Same rationale — the init-parent bootstrap/migrate CLI spec lives
      // alongside tfvars-sync.test.ts, outside packages/.
      '../scripts/init-parent.cli.test.ts',
    ],
    // Default environment for server-side and shared tests is Node.
    // React component tests under @hyveon/web override this via
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
      include: [
        'packages/**/src/**/*.{ts,tsx}',
        // Explicitly include desktop-preload source for coverage measurement.
        'packages/desktop-preload/**/*.{ts,tsx}',
      ],
      exclude: [
        'packages/**/*.test.{ts,tsx}',
        'packages/**/*.d.ts',
        'packages/**/dist/**',
        'packages/desktop-main/src/generated/**',
        'packages/web/src/generated/**',
        // Bootstrap / entry-point files — only exercised by e2e/integration tests.
        'packages/desktop-main/src/main.ts',
        'packages/desktop-main/src/test-main.ts',
        'packages/web/src/main.tsx',
        // NestJS DI module files — wiring config, not business logic.
        'packages/desktop-main/src/app.module.ts',
        'packages/desktop-main/src/modules/**',
        // Test-only infrastructure — not production code.
        'packages/desktop-main/src/test-mocks/**',
        // Pure type declarations — no executable statements.
        'packages/shared/src/types.ts',
      ],
      // text: printed to console after each run.
      // lcov: machine-readable format; available for future Codecov integration.
      reporter: ['text', 'lcov'],
      reportsDirectory: './coverage',
      thresholds: {
        statements: 80,
        branches: 80,
        functions: 80,
        lines: 80,
      },
    },
  },
  esbuild: {
    target: 'es2022',
  },
});
