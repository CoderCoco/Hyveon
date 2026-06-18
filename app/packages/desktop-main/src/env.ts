/**
 * Thin wrappers around `process.env` for environment variables consumed by
 * the Electron entry-point. Centralising access here lets tests stub individual
 * variables via `vi.spyOn(env, 'isTestMode')` instead of mutating
 * `process.env` directly, which leaks across tests.
 */

/**
 * Returns `true` when `HYVEON_TEST_MODE=1` is set — used by Playwright's
 * `_electron.launch()` harness to enable the forward-looking test seam.
 */
export function isTestMode(): boolean {
  return process.env.HYVEON_TEST_MODE === '1';
}

/**
 * Returns the Electron renderer dev-server URL injected by electron-vite,
 * or `undefined` when running in production (load from file instead).
 */
export function electronRendererUrl(): string | undefined {
  return process.env.ELECTRON_RENDERER_URL;
}
