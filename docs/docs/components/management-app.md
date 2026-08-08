---
title: Management app
sidebar_position: 3
---

# Management app

A TypeScript npm-workspaces monorepo under `app/`, itself one workspace tree
of the repository-root `package.json` workspaces list. It ships as a
packaged **Electron desktop app** — five non-Lambda packages make up the
local control plane: a Nest.js backend (`desktop-main`), a React dashboard
renderer (`web`), a pure shared library (`shared`), an AWS implementation of
the cloud-agnostic contracts (`cloud-aws`), and the Electron preload bridge
(`desktop-preload`) — plus the five Lambda packages documented
[here](/components/lambdas). There is no HTTP server and no bearer token
anywhere in this app: the renderer talks to the backend exclusively over
Electron IPC, via `window.hyveon` (the `desktop-preload` bridge).

Install everything from the root:

```bash
npm install
```

Dev mode (`npm run desktop:dev`) launches the full Electron app with
hot-reload on renderer saves; electron-vite serves the renderer for HMR
purposes only, never as a network API surface. See the [setup guide](/setup)
for the packaged-installer build.

## `@hyveon/shared`

`app/packages/shared` — zero-runtime-dependency TypeScript consumed by the
server **and** the four core Lambdas (interactions, followup, update-dns,
watchdog — `efs-seeder` has no dependency on it). The canonical location for cross-boundary
types and permission logic.

| Module | Purpose |
|---|---|
| `types.ts` | `DiscordAction`, `DiscordConfig`, `RedactedDiscordConfig`, `GameStatus`, `StartResult`, `PendingInteraction`. The API shapes every other package agrees on. |
| `canRun.ts` | The pure permission-check function. Order: **guild allowlist → admin user/role → per-game user/role + action**. Imported verbatim by the Nest server and both Discord Lambdas. |
| `commands.ts` | `COMMAND_DESCRIPTORS` — static JSON for the four slash commands. `actionForCommand(name)` maps to the `start`/`stop`/`status` bucket used by `canRun()`. |
| `sanitize.ts` | `isSafeGameKey()` (blocks `__proto__`, `constructor`, `prototype`), `asString()`, `asStringArray()`, `sanitizeGamePermission()`. Applied on DDB reads where input is operator-provided. |
| `formatStatus.ts` | `formatGameStatus(status)` — Discord-ready one-liner with emoji and hostname. |
| `ddb/client.ts` | Lazy DynamoDB DocumentClient. Region fallback: `AWS_REGION_` → `AWS_REGION` → `AWS_DEFAULT_REGION` → `us-east-1`. |
| `ddb/configStore.ts` | `getDiscordConfig()` / `putDiscordConfig()` for the `CONFIG#discord` row. |
| `ddb/pendingStore.ts` | `getPending()` / `putPending()` / `deletePending()` for `PENDING#{taskArn}`. `putPending()` sets `expiresAt = now + 15 minutes` so DDB TTL reaps stale rows. |
| `secrets/secretsStore.ts` | Secrets Manager wrapper with a 5-minute in-process cache. Recognises the infra program's `"placeholder"` seed value as "not configured". `invalidateSecretsCache()` is called by the Nest credentials endpoint. |

**Invariants**: `canRun()` lives in exactly one place; the four slash
commands are JSON descriptors, not classes; secrets' raw values never
leave this package's own callers.

## `@hyveon/desktop-main`

`app/packages/desktop-main` — a Nest.js app running as an **Electron IPC
microservice** (`NestFactory.createMicroservice`), not an HTTP server. The
boot sequence in `src/main.ts` (invoked from `electron-entry.ts` after
`app.whenReady()`):

1. Guards against running outside an Electron main process — `desktop-main`
   throws immediately if `process.versions.electron` is unset, rather than
   silently doing nothing under plain Node.
2. `NestFactory.createMicroservice(AppModule, { strategy: new BridgedElectronIPCTransport() })`.
3. `app.listen()` starts the transport, registering its internal
   `@MessagePattern` dispatch.
4. `registerIpcMainBridges(strategy)` bridges each of those patterns onto a
   real `ipcMain.handle` registration, so `ipcRenderer.invoke` calls from
   the renderer resolve instead of hanging.

This app has no NestJS exception filter — `registerIpcMainBridges` is the one
structural choke point every bridged handler passes through, so it also
catches any rejection there and normalizes it to a plain `Error` (message
only) before rethrowing, logging the pattern name and original message/stack
via the winston `logger`. Without this, a handler that lets a raw SDK/Node
error escape (e.g. an AWS SDK exception carrying non-plain fields like
`$metadata`) fails Electron's structured-clone when the rejection is
marshalled back to the renderer, surfacing as `Error: An object could not be
cloned` and leaving the caller's `invoke()` promise unresolved instead of
the real error message.

There is no listen port, no `NODE_ENV=production` bearer-token check, and no
static-file serving — the renderer is a separate Electron `BrowserWindow`
loading the built Vite bundle (or the Vite dev server in dev mode), and it
never speaks HTTP to this process.

### Module graph

- **`AppModule`** — root. Imports `AwsModule`, `DiscordModule`,
  `DeploymentConfigModule`, `RunRecordModule`, `PulumiEngineModule`,
  `PulumiWorkspaceModule`, `PulumiServiceModule`, `WizardModule`, and
  `ElectronStoreModule` (nine imports; `ConfigModule` and
  `CloudProviderModule` are **not** direct imports — they arrive
  transitively through `AwsModule`/`DeploymentConfigModule`/`RunRecordModule`, each of
  which imports both). Also directly provides a handful of
  controller-adjacent services that don't warrant their own module
  (`DiagnosticsService`, `DriftService`, `GamesWriteService`,
  `AuditService`) plus the `DIAGNOSTICS_LOG_DIR` token.
- **`ConfigModule`** — imports `ElectronStoreModule` and `PulumiServiceModule`
  (so `ConfigService` can inject `PulumiService`); provides just
  `ConfigService`. Extracted on its own so every other feature module can
  depend on it without pulling in `AwsModule`.
- **`CloudProviderModule`** — imports `ConfigModule`. Binds six
  cloud-agnostic contracts (from `@hyveon/shared/cloud.js`) to concrete
  `@hyveon/cloud-aws` implementations via `useFactory` providers keyed off
  `ConfigService.getActiveCloud()`: `CLOUD_PROVIDER`, `SECRETS_STORE`,
  `REMOTE_FILE_STORE`, `DISCORD_RECEIVER`, `AUDIT_LOG_STORE`, and
  `RUN_RECORD_STORE` (all declared in `cloud-provider.tokens.ts`). Consumers
  inject via `@Inject(CLOUD_PROVIDER)` etc. and depend only on the
  `@hyveon/shared` interface — never the concrete AWS class — so swapping the
  active cloud is a one-module change, not a call-site hunt. Today every
  token still resolves to AWS; a future non-AWS provider is added by
  extending the `CLOUD_BINDINGS` registry in `cloud-provider.module.ts`, not
  by touching this module's provider definitions.
- **`AwsModule`** — imports `ConfigModule` and `CloudProviderModule`
  (re-exporting both); provides and exports `Ec2Service`, `EcsService`,
  `LogsService`, `CostService`, `SchedulerService`, `FileManagerService`. It
  no longer provides
  `ConfigService` directly (that's `ConfigModule`'s job — `AwsModule`
  re-exports it for existing consumers that import `AwsModule` expecting
  `ConfigService` to be available) and no longer wires `AwsCloudProvider`/
  `AwsSecretsStore` itself — `EcsService` injects `CLOUD_PROVIDER` and
  `DiscordConfigService` injects `SECRETS_STORE`, both bound by
  `CloudProviderModule`.
- **`DiscordModule`** — imports `AwsModule`; provides
  `DiscordConfigService` and `DiscordCommandRegistrar`. No discord.js,
  no gateway — the bot is two Lambdas plus Discord's REST API.
- **`DeploymentConfigModule`** — imports `ConfigModule` and `CloudProviderModule`
  (for the `REMOTE_FILE_STORE` token); provides `DeploymentConfigService`, the
  S3-backed deployment-config JSON reader/parser. There is no local-file
  fallback — see [`DeploymentConfigModule` / `DeploymentConfigService`](#deploymentconfigmodule--deploymentconfigservice)
  below.
- **`RunRecordModule`** — imports `ConfigModule` and `CloudProviderModule`;
  provides `RunService` (the in-memory + DynamoDB apply lock guarding
  plan/apply/destroy submissions) and `RunRecordService` (run-history
  persistence), bound to the narrow `RUN_LOCK_SERVICE`/`RUN_RECORD_PERSISTER`
  DI tokens that `PulumiService` resolves lazily.
- **`PulumiEngineModule`** — imports nothing; provides `PulumiEngineService`,
  which resolves and provisions the pinned Pulumi CLI engine into an
  app-owned directory (never `~/.pulumi`, never `PATH`) without requiring
  the operator to install anything.
- **`PulumiWorkspaceModule`** — imports `PulumiEngineModule` and
  `ElectronStoreModule`; provides `PulumiWorkspaceService`, the Automation
  API `LocalWorkspace`/S3-backend/secrets-passphrase seam behind
  `getOrCreateStack()`.
- **`PulumiServiceModule`** — imports `PulumiWorkspaceModule`,
  `PulumiEngineModule`, and `ElectronStoreModule`; provides `PulumiService`,
  the plan/apply/destroy/rollback + `getStackOutputs()` engine service. It
  deliberately does **not** import
  `RunRecordModule`, `CloudProviderModule`, or `DeploymentConfigModule` — those would
  close a native-ESM module cycle through `ConfigModule` — so `PulumiService`
  resolves `RUN_RECORD_PERSISTER`, `REMOTE_FILE_STORE`, and the `DeploymentConfigService`
  it needs at call time via `ModuleRef.get(token, { strict: false })` instead
  of constructor injection.
- **`WizardModule`** — imports `ElectronStoreModule`; provides
  `AwsProfileService`, `BootstrapService`, `IamCheckService`,
  `FirstRunWizardService`, and `GuidedIamService` for the first-run setup
  wizard. `GuidedIamService` backs the guided-IAM step: renders the
  `iam-bootstrap.yaml` CloudFormation template, hands off to the console,
  intakes the operator-pasted bootstrap key, and performs the mandatory
  mint-then-revoke rotation onto a freshly-minted key pair — plus a
  standalone manual-revoke action for the rotation's failure path.
  `PrerequisiteService` was deleted (`migrate-iac-to-pulumi` change, tasks
  10.1/10.2) along with the wizard's old prerequisites step.
- **`ElectronStoreModule`** — provides `SafeStorageService` (OS-keychain
  encryption) and `ElectronStoreService` (the typed `electron-store`
  consumer built on top of it). See
  [Credential storage at rest](#credential-storage-at-rest) below.

### Controllers and IPC channels

Every controller is IPC-only: handlers are bound to a channel name via
`@MessagePattern()`/`@Payload()` — there are no HTTP routes anywhere in this
app. The renderer calls into these via `window.hyveon.*` (the preload bridge),
which forwards to `ipcRenderer.invoke(channel, ...)`.

| Controller | Representative channels | Purpose |
|---|---|---|
| `GamesController` | `games.list`, `games.status`, `games.getStatus`, `games.start`, `games.stop`, `games.create`, `games.update`, `games.delete` | List/read status, trigger RunTask/StopTask, manage `gameServers` entries in the JSON configuration object (`deployment-config.json`) via `DeploymentConfigService`. Invalidates `DeploymentConfigService`'s cache on list/status reads so a config edit made outside the app (e.g. by another operator) is picked up without restarting; `ConfigService`'s cached stack outputs are untouched by this and expire on their own 20s/`invalidateCache()` schedule. |
| `CostsController` | `costs.estimate` | Per-game Fargate estimates, derived from each game's `{game}-server` task-definition CPU/memory. The app makes no AWS Cost Explorer API calls — see [Costs](/app/costs). |
| `LogsController` | `logs.get`, `logs.stream` | Snapshot of last N log events; a streaming channel that pushes new events as they arrive (polls `FilterLogEvents` every 2 s under the hood). |
| `FilesController` | `files.list`, `files.start`, `files.stop` | Ad-hoc FileBrowser task against the game's EFS access point. `files.start` seeds a random per-launch password (bcrypt-hashed into the container's `--password` flag), returns the one-time plaintext credential in its response, and creates an EventBridge Scheduler one-time schedule that auto-stops the task after 2 hours; `files.stop` cancels that schedule. |
| `DiscordController` | `discord.getConfig`, `discord.putConfig`, `discord.listGuilds`, `discord.addGuild`, `discord.removeGuild`, `discord.registerCommands`, `discord.getAdmins`, `discord.putAdmins`, `discord.getPermissions`, `discord.putPermission`, `discord.deletePermission` | Read-redacted config, save credentials, manage guild allowlist + commands, admins, per-game permissions. |
| `EnvController`, `DiagnosticsController`, `DriftController`, `AuditController` | `env.get`; `diagnostics.tail`/`diagnostics.path`/`diagnostics.reportError`/`diagnostics.reportLog`; `drift.get`; `audit.list` | Environment info, log-tail diagnostics, config-drift detection, and the audit-log view. Two renderer-forwarding channels land in the same `main-*.log` file but stay distinguishable by line prefix: `diagnostics.reportError` forwards a renderer-side crash (from the top-level `ErrorBoundary` or a `window.onerror`/`unhandledrejection` listener) via `DiagnosticsService.logRendererError`, writing `renderer error (${source}): ${message}`; `diagnostics.reportLog` forwards batched `console.log`/`info`/`warn`/`error` calls (every call, not just crashes — see `installConsoleForwarding()` below) via `DiagnosticsService.logRendererConsoleBatch`, writing one `renderer console (${level}): ${message}` line per entry (level mapped `log`→`debug`, others 1:1) plus a combined `renderer console: ${n} entries dropped (queue capacity exceeded)` warning per flush when the renderer's own queue overflowed. |
| `IacController` | `iac.stack.initialize`, `iac.plan`, `iac.apply`, `iac.destroy.mintToken`, `iac.destroy`, `iac.output`, `iac.approve`, `iac.rollback.resolve`, `iac.rollback.confirm`, `iac.lock.clear` | Drives `PulumiService` (Automation API via `LocalWorkspace`, which launches the pinned `@pulumi/pulumi` engine as a child process through `LocalWorkspaceOptions.pulumiCommand` — the app downloads and verifies that engine itself, so no host-installed or PATH-discovered CLI is ever used) for the plan/apply/destroy/rollback pipeline. `iac.destroy.mintToken` issues the type-to-confirm token the UI requires before a `destroy` call is accepted; `iac.lock.clear` recovers a stale Pulumi backend lock. |
| `IacRunsController` | `iac.runs.get`, `iac.runs.logs`, `iac.runs.list`, `iac.runs.logUrl` | Run history: fetch a record, stream/fetch its log, list/paginate, resolve an offloaded S3 log link. |
| `IacSettingsController` | `iac.settings.get`, `iac.settings.update`, `iac.settings.engineVersion` | Reads/writes every top-level `deployment-config.json` field EXCEPT `gameServers` — backs the Settings page's [General section](/app/settings#general). `update` validates via the shared `validateDeploymentSettingsPatch` (`@hyveon/shared`) before delegating to `DeploymentConfigService.updateTopLevelSettings()`; a stale `expectedVersionId` returns `{ code: 'conflict' }` rather than silently overwriting a concurrent edit. `engineVersion` reads `PulumiEngineService.getResolvedVersion()` (`null` when not yet provisioned) — backs the [Cloud Setup section](/app/settings#cloud-setup)'s Pulumi engine version row. |
| `WizardController` | first-run wizard channels (AWS profile/credentials, bootstrap, IAM check, guided-IAM CloudFormation bootstrap, progress) | Backs the in-app setup wizard — see the [setup guide](/setup). |

### Key services

- **`ConfigService`** — no longer parses any state file off disk. Its
  `getStackOutputs()` is a memoised delegate to `PulumiService.getStackOutputs()`,
  which reads the deployed Pulumi stack's outputs (`StackOutputs` from
  `@hyveon/shared` — cluster ARN, subnets, security groups, EFS access
  points, game names, hosted zone, Discord table + secret ARNs, interactions
  URL) via the Automation API against the S3 backend, not a local state
  file. The in-flight promise is cached so concurrent callers
  coalesce; a resolved `null` (infra not yet deployed) expires after 20 s, a
  resolved value is cached until `invalidateCache()` — called by the games
  controller on list/status so a fresh `pulumi up` is picked up without an
  app restart. The old local-file-parsing path was removed as dead code —
  nothing reads a local state file under
  the Pulumi engine. `getConfigurationBucket()` (the configuration S3 bucket
  name) is a different, unrelated resolution path — see
  [`DeploymentConfigModule` / `DeploymentConfigService`](#deploymentconfigmodule--deploymentconfigservice) below.
- **`DiscordConfigService`** — persistence facade over DynamoDB
  (`CONFIG#discord`) + Secrets Manager. Concurrent reads are coalesced via
  an inflight-promise pattern. `getRedacted()` returns
  `botTokenSet` / `publicKeySet` booleans only.
  `getEffectiveToken()` is the single escape hatch — used only by the
  command registrar.
- **`DiscordCommandRegistrar`** — calls
  `PUT https://discord.com/api/v10/applications/{clientId}/guilds/{guildId}/commands`.
  Validates `guildId` as a 17–20-digit Discord snowflake before calling out
  (no path traversal, no SSRF).
- **`EcsService` / `Ec2Service` / `LogsService` / `SchedulerService` /
  `CostService` / `FileManagerService`** — cloud-facing services.
  `EcsService` routes ECS run/stop/status calls through the injected
  `CLOUD_PROVIDER` token (a `CloudProvider` implementation from
  `@hyveon/cloud-aws`) rather than instantiating an `@aws-sdk/client-ecs`
  client directly; `Ec2Service` / `LogsService` / `SchedulerService` still
  call the AWS SDK v3 clients (EC2, CloudWatch Logs, EventBridge Scheduler)
  directly, since those aren't yet behind a cloud-agnostic contract.
  `FileManagerService` composes `EcsService`/`Ec2Service`/`SchedulerService`
  rather than calling any SDK client itself. `CostService` is pure
  arithmetic — no AWS SDK client at all — since the Cost Explorer call
  chain was removed (see `openspec/changes/remove-cost-explorer-calls`).
  New cloud-facing code should prefer adding to (or consuming) the
  `CLOUD_PROVIDER` / `SECRETS_STORE` / `REMOTE_FILE_STORE` /
  `DISCORD_RECEIVER` / `AUDIT_LOG_STORE` / `RUN_RECORD_STORE` tokens over
  reaching for a new AWS SDK client directly — see the [maintainer
  guide](/guides/maintainer#when-you-touch-the-nest-server).
  `LogsService.streamLogs(game, signal)` is an `AsyncGenerator` that polls
  `FilterLogEvents` every 2 s; `getRecentLogs` remains the snapshot path.
- **`DriftService`** — see [Drift detection](#drift-detection) below.
- **`DeploymentConfigService`** — see [`DeploymentConfigModule` / `DeploymentConfigService`](#deploymentconfigmodule--deploymentconfigservice) below.

### Auth

There is no request-level auth to configure — Electron IPC is only reachable
from the app's own renderer process (via the `contextBridge`-exposed
`window.hyveon`), not from the network. There is no bearer token, no
`API_TOKEN`, and no equivalent of the old `ApiTokenGuard` anywhere in this
app.

### Logging

Winston in `src/logger.ts`. Dev: colourised timestamps + JSON metadata.
Prod: JSON lines with ISO timestamps. Use `logger.info` / `warn` / `error`
everywhere, not `console.log`.

The winston log file is the only durable record of what happened in a given
run — there's no HTTP transport and no NestJS exception filter to fall back
on for tracing (see [Auth](#auth) above). Two conventions keep it useful,
applied across every controller and every service method in
`desktop-main/src/services/*.ts` that can fail (not just controllers): every
`@MessagePattern` handler logs its pattern name on entry via `logger.debug`
(pattern name only, never payload contents — a payload can carry pasted AWS
credentials); and every service method that calls an AWS SDK operation or
the Pulumi engine catches the error, logs it via `logger.warn`
(recoverable/expected) or `logger.error` (unexpected) with just
`err instanceof Error ? err.message : String(err)`, and either returns a
modeled result or rethrows a plain `Error` — a raw AWS SDK/Node error object
is never left to escape a service method uncaught, since it can carry
non-plain fields (e.g. `$metadata`) that fail Electron's structured-clone
when marshalled back to the renderer. Pure helpers with no external call and
no possible failure mode (`CostService.ts`'s arithmetic, `sleep.ts`,
`mergeGameLists.ts`) are exempt — there's nothing to log.

### Env vars

| Name | Default | Purpose |
|---|---|---|
| `AWS_DEFAULT_REGION` | — | AWS SDK region hint, read by `ConfigService.readEnvRegion()`. |
| `CONFIG_CACHE_TTL_MS` | `30000` | In-memory cache TTL for `DeploymentConfigService`'s parsed configuration. Falls back to the default when unset, empty, non-numeric, or non-positive. |
| `RUNS_DIR_PATH` | `<userData>/runs` | Directory `PulumiService` writes per-run plan/apply artifacts under. |
| `HYVEON_CONFIG_BUCKET` | — | Dev/CI override for the S3 configuration bucket name `DeploymentConfigService`/`PulumiService` read/write against — wins over the operator-configured value. Not how the packaged app resolves the bucket in normal use; see [`DeploymentConfigModule` / `DeploymentConfigService`](#deploymentconfigmodule--deploymentconfigservice) below for the real resolution order. |
| `NODE_ENV` | — | `'production'` selects Winston's JSON-lines log format over the dev colourised format; read in `logger.ts`. |
| `DIAGNOSTICS_LOG_DIR` | `os.tmpdir()` | Outside Electron only — the directory `DiagnosticsController`'s log-tail reads from. Inside Electron this is always `<userData>/logs` regardless of the env var. |
| `HYVEON_TEST_MODE` | — | `'1'` enables the `window.hyveon.__test` mock-IPC seam in the preload script for Playwright's `electron` e2e project — see [`@hyveon/desktop-preload`](#hyveondesktop-preload) below. Absent (the default) in packaged/production builds. |

### Credential storage at rest

Two services, both provided by `ElectronStoreModule`:

- **`SafeStorageService`** — wraps Electron's `safeStorage` API, which
  encrypts strings using the OS keychain (Keychain on macOS, libsecret on
  Linux, DPAPI on Windows). `isAvailable()` is `true` only inside an
  Electron process with an unlocked keychain; `encrypt()`/`decrypt()`
  degrade to passthrough (with a warning on `encrypt()`) outside Electron —
  unit tests and plain-Node CI never need environment branching of their
  own. The caller must ensure `isAvailable()` returns the same value at
  write time and read time: a ciphertext written while the keychain was
  available cannot be safely round-tripped if it becomes unavailable later
  (locked keychain, or data shared across an Electron and a non-Electron
  context) — `decrypt()` returns the raw base64 blob unchanged in that case.
- **`ElectronStoreService`** — a typed wrapper over `electron-store` (an
  ESM-only package, loaded via dynamic `import()` gated on
  `process.versions.electron` so plain-Node test environments never hit an
  `ERR_REQUIRE_ESM`). Outside Electron it falls back to an in-memory `Map`
  with an identical public API, so reads/writes just don't persist across
  process restarts in tests/CI. Its `AppStoreSchema` holds
  `wizardCompleted`, the selected `activeCloud`/AWS profile/region, the
  bootstrap step's last-submitted resource names (state bucket, configuration
  bucket — so Settings' "Reconfigure" flow can rehydrate a non-default name),
  and pasted-credentials profiles keyed by profile name. Every secret
  field (`aws.accessKeyId`, `aws.secretAccessKey`,
  `creds.aws.<profile>.accessKeyId`/`secretAccessKey`) is encrypted via
  `SafeStorageService` on write and decrypted on the dedicated getter — there
  is no path that reads or writes those fields' raw ciphertext directly.
  Decrypted pasted credentials must only ever be consumed inside main-process
  SDK client factories (e.g. `CloudProviderModule`'s `useFactory` providers)
  — never echoed back over IPC to the renderer.

### `DeploymentConfigModule` / `DeploymentConfigService`

`DeploymentConfigService` is the S3-backed deployment-config JSON reader/parser
backing the Games page's declared-config view, the add/edit/remove game
flows, and drift detection — see `openspec/specs/desktop-only-operator-surface`'s
"No operator-editable configuration files" requirement. There is no
local-file fallback: `ConfigService.getConfigurationBucket()` resolves the
configured S3 bucket (the `HYVEON_CONFIG_BUCKET` env var as a dev/CI
override, otherwise `ElectronStoreService`'s `bootstrap.configurationBucket`
— the value the First-Run Wizard's bootstrap step persisted), and every
read/write goes through the injected `REMOTE_FILE_STORE` token keyed by the
fixed `CONFIGURATION_OBJECT_KEY` constant (`@hyveon/shared`,
`'deployment-config.json'`). When no bucket is configured,
`getGameServers()` resolves to `[]` (never rejects — its `isConfigured()`
method lets a caller distinguish "unconfigured" from "genuinely zero games"),
while the write paths and `getRawConfig()` throw a typed
`ConfigurationNotConfiguredError`. Parsed results are cached in-memory for
`CONFIG_CACHE_TTL_MS` (default 30 s) so repeated reads (e.g. drift checks)
don't re-fetch from S3 on every call; `invalidateCache()` is called after any
write. `ConfigService.getConfigurationBucket()` is the only backend-selection
path in the app: it checks the `HYVEON_CONFIG_BUCKET` env var (a dev/CI
override) before falling back to the wizard-persisted
`bootstrap.configurationBucket`, and returns `null` — never a local-file
path — when neither is set.

`getTopLevelSettings()`/`updateTopLevelSettings()` are the top-level-field
counterpart to `addGameServer()`/`updateGameServer()`/`removeGameServer()` —
same conditional-put/`OptimisticLockError` contract, but merging a patch onto
every field except `gameServers` (which `updateTopLevelSettings()` always
takes from the freshly-read document, never from the caller's patch, even if
a caller's payload contains a `gameServers` key at runtime). Backs the
`IacSettingsController` row above.

### Drift detection

`DriftService` (provided directly by `AppModule`, backing the `drift.get`
IPC channel and the [`/app/dashboard`](/app/dashboard) and
[`/app/games`](/app/games) pages' drift indicators) computes the difference
between the **declared** game-server config (`DeploymentConfigService.getGameServers()`
— what's in the configuration bucket's `deployment-config.json` right now)
and the **applied** config (`ConfigService.getStackOutputs()`'s
`appliedGameServers` field — what the Pulumi stack last actually applied).
Per game, the pure `computeDrift()` function classifies:

- **`pending_create`** — declared but not yet in the deployed set.
- **`pending_delete`** — deployed but no longer declared.
- **`config_drift`** — declared and deployed, but `image`/`cpu`/`memory`/
  `ports`/`volumes` differ from what was last applied, with `changedFields`
  listing exactly which. `ports`/`volumes` comparisons are order-insensitive
  (canonicalized before comparing), since JSON key order isn't guaranteed
  stable and reordering entries in the configuration isn't a real config
  change.
- Games matching on every compared field produce no entry — the report only
  lists what's out of sync.

`getDrift()` invalidates both `ConfigService`'s cached stack outputs and the
`DeploymentConfigService` cache first, so a fresh Pulumi apply or configuration edit is
reflected without an app restart.

## `@hyveon/cloud-aws`

`app/packages/cloud-aws` — the AWS implementation of the six cloud-agnostic
contracts `@hyveon/shared/cloud.js` declares (`CloudProvider`, `SecretsStore`,
`RemoteFileStore`, `DiscordEventReceiver`, `AuditLogStore`, `RunRecordStore`).
`CloudProviderModule` (see the module graph above) is the only place that
imports from this package directly — every other consumer in `desktop-main`
depends on the `@hyveon/shared` interface via one of the six injection
tokens, never on a concrete class from here. Extracted as its own workspace
package (rather than living inside `desktop-main`) so a future non-AWS cloud
provider package can sit alongside it without `desktop-main` depending on
either concrete implementation.

## `@hyveon/desktop-preload`

`app/packages/desktop-preload` — the Electron preload script, run in a
privileged-but-sandboxed context between the main process and the renderer.
`contextBridge.exposeInMainWorld('hyveon', ...)` exposes the typed IPC
surface the renderer calls as `window.hyveon.*`; every method forwards to
`ipcRenderer.invoke(channel, ...args)`.

### `HYVEON_TEST_MODE` and the test seam

When `process.env.HYVEON_TEST_MODE === '1'` at preload-script load time, the
bridge gains an additional `window.hyveon.__test` namespace:

```ts
window.hyveon.__test.mock(channel, handler)   // handler: replacement fn or plain value
window.hyveon.__test.clearMocks()             // alias: reset()
```

Once a channel is mocked, every subsequent `invoke(channel, ...)` call
consults an internal `Map<string, fn>` before ever reaching
`ipcRenderer.invoke` — so a Playwright spec can drive the real Electron
shell and real React app while the Nest-side main process is never touched
for that channel. This backs the `electron` Playwright project's specs
(`electron-smoke.spec.ts`, `ipc-mock.spec.ts`, `discord.spec.ts`, and the
documentation screenshot harness — see the
[maintainer guide](/guides/maintainer#refreshing-the-documentation-screenshots)).

**This seam is gated off in production.** When `HYVEON_TEST_MODE` is unset —
the default for packaged/production builds and for `npm run desktop:dev`
without the flag explicitly set — the `if (isTestMode)` branch in the preload script
is never entered, and `window.hyveon.__test` is `undefined`. There is no
runtime toggle, config file, or IPC call that can expose the mock registry
to an end user's build.

## `@hyveon/web`

`app/packages/web` — React + Vite.

- **Entry**: `src/main.tsx` → `src/app.component.tsx`, rendered inside an
  Electron `BrowserWindow`. `main.tsx` calls two forwarding installers from
  `src/lib/report-renderer-error.utils.ts` before rendering:
  `installGlobalErrorReporting()` (wires `window.onerror`/`unhandledrejection`
  to `diagnostics.reportError`) and `installConsoleForwarding()` (wraps
  `console.log`/`info`/`warn`/`error` so every call is both printed to
  devtools as normal and queued for batched delivery to
  `diagnostics.reportLog` — a no-op wherever the bridge doesn't implement
  `diagnostics.reportLog`, which includes the `chromium` Playwright
  project's HTTP-polyfilled `window.hyveon` stub as well as a genuinely
  absent bridge). For the Diagnostics panel UI this backs, see
  [`/app/settings`](/app/settings#diagnostics).
- **Auth**: none — there's no bearer token, no login prompt, and nothing in
  `localStorage` gating API access. The renderer's `window.hyveon` bridge is
  only reachable from the app's own preload-scoped context.

### Routes

The renderer is a multi-route single-page app (`react-router`), not a single
dashboard screen. `app.component.tsx` routes via `HashRouter`, not
`BrowserRouter`: the packaged renderer loads via `win.loadFile()`
(`file:///C:/...` on Windows, drive letter included), and `BrowserRouter`'s
absolute-path route matching breaks against that prefix. `HashRouter` keeps
the route entirely after a `#`, unaffected by the underlying `file://` path —
so every path below is addressed at runtime as `/#<path>` (e.g. `/#/costs`),
not the bare path:

| Path | Page | See |
|---|---|---|
| `/` | Dashboard — game cards, KPI strip, start/stop | [`/app/dashboard`](/app/dashboard) |
| `/games`, `/games/:name` | Games list + game detail | [`/app/games`](/app/games) |
| `/iac`, `/iac/history`, `/iac/history/:runId` | Plan/apply/destroy, run history, run detail | [`/app/iac`](/app/iac) |
| `/discord` | Discord bot credentials, guilds, admins, per-game permissions | [`/app/discord`](/app/discord) |
| `/logs` | Live log viewer | [`/app/logs`](/app/logs) |
| `/costs` | Per-game Fargate cost estimates, AWS Cost Explorer link-out | [`/app/costs`](/app/costs) |
| `/audit` | Audit log entries | [`/app/audit`](/app/audit) |
| `/settings` | Watchdog summary, deployment settings, cloud setup, diagnostics | [`/app/settings`](/app/settings) |
| — | First-run setup wizard, shown in place of the router until `wizardCompleted` | [`/app/first-run-wizard`](/app/first-run-wizard) |

For what each screen looks like and how to use it, start at
[Using the app](/app) — this page stays at the wiring level (IPC channels,
services, module graph).

### API layer

`src/api.service.ts` exports a single `api` object with one method per IPC
channel. Every call is delegated straight to `window.hyveon.*` — there are no
`fetch` calls and no bearer-token plumbing anywhere in this module.

### Vite dev config

`vite.config.ts` serves the renderer on `:5173` for HMR purposes only; it is
driven by electron-vite (see `electron.vite.config.ts`), not accessed
directly as a network API. Production builds to `dist/`, packed into the
Electron app's asar archive.

### Running e2e tests

The web package ships a [Playwright](https://playwright.dev/) harness with two projects, migrating from the first to the second: `chromium` runs specs against the **production build** (`vite build` + `vite preview`), polyfilling `window.hyveon` with an HTTP bridge so every `/api/*` call can be stubbed via `page.route()`; `electron` launches the packaged Electron app directly via `_electron.launch()` and stubs IPC responses through the `window.hyveon.__test.mock()` test bridge instead. The Nest server never starts in either project.

```bash
# One-off (builds the app, starts vite preview, runs specs, exits)
npm run app:test:e2e

# Keep vite preview running between runs (set PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD if already installed)
cd app/packages/web
npm run build && npm run preview &   # leave running
npx playwright test                   # fast re-run without rebuilding
```

First-time setup — install the Chromium browser binary:

```bash
cd app/packages/web
npx playwright install chromium
```

Specs live under `app/packages/web/e2e/specs/`. Shared stubs and fixtures are in `app/packages/web/e2e/fixtures/`. On CI, Playwright uploads traces and videos as artifacts when a spec fails; see `.github/workflows/e2e.yml`.
