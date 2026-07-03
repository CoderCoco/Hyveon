import 'reflect-metadata';
import { fileURLToPath } from 'node:url';
import { NestFactory } from '@nestjs/core';
import type { INestApplicationContext, Type } from '@nestjs/common';
// Deep imports into @hyveon/desktop-main's compiled `dist/` output. The
// package has no `exports` map, so subpath resolution is unrestricted;
// `npm run app:build` must have produced `dist/` before this module loads.
import { AppModule } from '@hyveon/desktop-main/dist/app.module.js';
import { installEcsMock } from '@hyveon/desktop-main/dist/test-mocks/ecs-mock.js';
import { mockStore } from '@hyveon/desktop-main/dist/test-mocks/mock-store.js';
import type { MockResponse } from '@hyveon/desktop-main/dist/test-mocks/mock-store.js';

/** Absolute path to the Terraform state fixture bundled alongside this harness. */
const DEFAULT_TF_STATE_PATH = fileURLToPath(new URL('./tfstate.fixture.json', import.meta.url));

/** Extracts the parameter tuple of `TController[TMethod]` when it's a function. */
type HandlerArgs<TController, TMethod extends keyof TController> = TController[TMethod] extends (
  ...args: infer TArgs
) => unknown
  ? TArgs
  : never;

/** Extracts the (awaited) return type of `TController[TMethod]` when it's a function. */
type HandlerResult<TController, TMethod extends keyof TController> = TController[TMethod] extends (
  ...args: never[]
) => infer TResult
  ? Awaited<TResult>
  : never;

/**
 * In-process IPC test harness for tier-2 integration specs.
 *
 * Built by {@link createIpcHarness}, which compiles the real `AppModule` DI
 * container via `NestFactory.createApplicationContext()` — no HTTP listener,
 * no Electron IPC microservice transport, and no child process involved.
 * `@MessagePattern`-decorated controller methods (e.g.
 * `GamesController.listGames`) are plain class methods, so {@link dispatch}
 * invokes them directly on the container-resolved instance, exercising the
 * exact same providers (`ConfigService`, `EcsService`, ...) the Electron IPC
 * transport would route to at runtime.
 */
export interface IpcHarness {
  /**
   * Invokes `method` on the container-resolved instance of `controller`,
   * forwarding `args` exactly as an IPC caller would pass a `@Payload()`.
   *
   * @example
   * ```ts
   * const { games } = await harness.dispatch(GamesController, 'listGames');
   * ```
   */
  dispatch<TController extends object, TMethod extends keyof TController>(
    controller: Type<TController>,
    method: TMethod,
    ...args: HandlerArgs<TController, TMethod>
  ): Promise<HandlerResult<TController, TMethod>>;

  /**
   * Queues mock ECS SDK responses, consumed FIFO by the interceptor installed
   * via `installEcsMock()`. Thin wrapper over the shared `mockStore` so specs
   * never need to know the HTTP-tier's `/api/test/mocks/*` control surface.
   */
  mocks: {
    pushListTasks(response: MockResponse): void;
    pushDescribeTasks(response: MockResponse): void;
    pushRunTask(response: MockResponse): void;
    pushStopTask(response: MockResponse): void;
    reset(): void;
  };

  /** Tears down the Nest application context. */
  close(): Promise<void>;
}

/**
 * Compiles the in-process IPC test harness.
 *
 * Sets `TF_STATE_PATH` to `tfStatePath` (defaulting to the fixture next to
 * this file — the same fixture the HTTP integration tier uses) so
 * `ConfigService` resolves tfstate-fixture-driven data instead of requiring a
 * real Terraform state file, then installs the ECS mock interceptor and
 * builds the `AppModule` application context.
 */
export async function createIpcHarness(tfStatePath: string = DEFAULT_TF_STATE_PATH): Promise<IpcHarness> {
  process.env['TF_STATE_PATH'] = tfStatePath;

  installEcsMock();

  const context: INestApplicationContext = await NestFactory.createApplicationContext(AppModule, {
    logger: false,
  });

  return {
    async dispatch<TController extends object, TMethod extends keyof TController>(
      controller: Type<TController>,
      method: TMethod,
      ...args: HandlerArgs<TController, TMethod>
    ): Promise<HandlerResult<TController, TMethod>> {
      const instance = context.get(controller, { strict: false });
      const handler = instance[method];
      if (typeof handler !== 'function') {
        throw new Error(`${controller.name}.${String(method)} is not a callable IPC handler`);
      }
      const result = await (handler as (...a: unknown[]) => unknown).apply(instance, args);
      return result as HandlerResult<TController, TMethod>;
    },
    mocks: {
      pushListTasks: (response) => mockStore.pushListTasks(response),
      pushDescribeTasks: (response) => mockStore.pushDescribeTasks(response),
      pushRunTask: (response) => mockStore.pushRunTask(response),
      pushStopTask: (response) => mockStore.pushStopTask(response),
      reset: () => mockStore.reset(),
    },
    close: () => context.close(),
  };
}
