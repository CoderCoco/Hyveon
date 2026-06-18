/**
 * Test-only mock registry for `window.gsd`.
 *
 * Provides typed `register`, `lookup`, and `clear` helpers that allow unit
 * tests running in jsdom to inject partial or full mock implementations of
 * any `GsdApi` namespace without importing Electron or touching the real IPC
 * bridge.
 *
 * This module is intentionally **not** imported by the preload script or any
 * production renderer code — it is only consumed by test helpers and
 * `vi.mock` factory functions in the `@hyveon/web` test suite.
 */

import type { GsdApi } from './gsd-api.js';

// ---------------------------------------------------------------------------
// Namespace key union — derived from GsdApi so it stays in sync automatically.
// ---------------------------------------------------------------------------

/**
 * Union of the namespace keys present on {@link GsdApi} (excluding `__test`).
 * Used to constrain the `register` and `lookup` overloads to valid keys.
 */
export type GsdNamespace = Exclude<keyof GsdApi, '__test'>;

// ---------------------------------------------------------------------------
// Overloaded namespace → sub-interface mapping
// ---------------------------------------------------------------------------

/**
 * Maps each {@link GsdNamespace} key to the sub-interface it holds on
 * {@link GsdApi}.  Derived directly from `GsdApi` via a mapped type so that
 * adding a new namespace to `GsdApi` automatically propagates here — the
 * compiler will enforce value-type correctness in `register` / `lookup`
 * without any manual update to this alias.
 */
export type GsdNamespaceMap = { [K in GsdNamespace]: GsdApi[K] };

// ---------------------------------------------------------------------------
// Internal registry store
// ---------------------------------------------------------------------------

/** Mutable store keyed by namespace. */
const _registry: Partial<GsdNamespaceMap> = {};

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Registers a mock implementation for a single `window.gsd` namespace.
 *
 * The mock replaces whatever was previously registered for that namespace (if
 * anything).  Partial implementations are accepted — only the methods the test
 * needs have to be provided.
 *
 * @example
 * ```ts
 * import { register } from '@hyveon/desktop-preload/test-mock-registry';
 * register('games', { list: vi.fn().mockResolvedValue({ games: ['minecraft'] }), ... });
 * ```
 */
export function register<K extends GsdNamespace>(namespace: K, mock: GsdNamespaceMap[K]): void {
  (_registry as GsdNamespaceMap)[namespace] = mock;
}

/**
 * Looks up the mock registered for a namespace.
 *
 * Returns `undefined` if nothing has been registered for that namespace yet.
 * Tests that rely on a mock being present should call {@link register} first.
 */
export function lookup<K extends GsdNamespace>(namespace: K): GsdNamespaceMap[K] | undefined {
  return (_registry as GsdNamespaceMap)[namespace];
}

/**
 * Removes all entries from the registry.
 *
 * Call this in an `afterEach` hook to prevent mock state from leaking between
 * tests.
 */
export function clear(): void {
  for (const key of Object.keys(_registry) as GsdNamespace[]) {
    delete _registry[key];
  }
}

/**
 * Builds a {@link GsdApi}-shaped object from the current registry contents.
 *
 * Any namespace not yet registered is omitted (the property will be
 * `undefined`), which matches the optional-namespace pattern used by the
 * test harness.  The returned object is suitable for assignment to
 * `window.gsd` in a `beforeEach` hook.
 *
 * This helper is intentionally **not** exported from the package root — import
 * it directly from the `test-mock-registry` export path.
 */
export function buildMockGsd(): Partial<GsdApi> {
  return { ..._registry };
}
