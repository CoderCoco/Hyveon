## ADDED Requirements

### Requirement: Updater is wired but inert by default

The Electron main process SHALL construct the `electron-updater` integration in a dedicated `desktop-main/src/updater.ts` module during application startup, and it MUST NOT call `checkForUpdates` (or any other method that performs network I/O against an update feed) unless the `enableAutoUpdate` feature flag is `true`. A first launch with default settings MUST produce zero outbound traffic to update servers.

#### Scenario: First launch with default settings performs no update check

- **WHEN** the packaged app starts and `enableAutoUpdate` is unset or `false` in electron-store
- **THEN** the updater module is initialized but `checkForUpdates` is never invoked and no network request is made to any update feed

#### Scenario: Flag enabled triggers an update check

- **WHEN** the app starts and `enableAutoUpdate` is `true` in electron-store
- **THEN** the updater calls `checkForUpdates` against the GitHub Releases feed and surfaces update events (available / downloaded / error) through the main-process logger

#### Scenario: Updater initialization is skipped outside Electron

- **WHEN** the desktop-main code runs in a plain-Node environment (unit tests, integration harness) where `process.versions.electron` is undefined
- **THEN** updater initialization is a no-op and no Electron-only module import is attempted

### Requirement: Update-check telemetry is gated by the same flag

All logging, event reporting, or telemetry emitted as part of update checks SHALL be gated by the `enableAutoUpdate` flag so that a disabled updater produces no update-related network calls and no silent background activity.

#### Scenario: Disabled updater emits no update telemetry

- **WHEN** `enableAutoUpdate` is `false` and the app runs through a full session
- **THEN** no update-check events are emitted and no update-related network activity occurs beyond at most a single local log line stating the updater is disabled

### Requirement: enableAutoUpdate flag lives in the typed electron-store schema

The `AppStoreSchema` in `ElectronStoreService` SHALL include an `enableAutoUpdate: boolean` field. Reads MUST treat an absent value as `false` (default off). The flag SHALL be readable and writable through the existing typed `get`/`set` surface of `ElectronStoreService`.

#### Scenario: Absent flag defaults to disabled

- **WHEN** the updater module reads `enableAutoUpdate` from a store that has never persisted the key
- **THEN** the value resolves to `false` and the updater stays inert

#### Scenario: Flag round-trips through the store

- **WHEN** `enableAutoUpdate` is set to `true` via `ElectronStoreService.set` and read back via `ElectronStoreService.get`
- **THEN** the read returns `true`, in both the real electron-store backing and the in-memory Map backing used outside Electron

### Requirement: Packaged builds carry GitHub publish metadata

`electron-builder.yml` SHALL declare `publish: github` so packaged artifacts embed the update-feed metadata (`app-update.yml`) that `electron-updater` requires. Adding the publish configuration MUST NOT cause CI packaging runs to publish releases themselves — release publishing remains owned by the tag-triggered workflow.

#### Scenario: Packaging embeds the update feed configuration

- **WHEN** `npm run desktop:package` builds an installer
- **THEN** the packaged app contains electron-updater feed metadata pointing at the project's GitHub Releases

#### Scenario: CI packaging does not auto-publish

- **WHEN** the Package workflow runs `npm run desktop:package` on a pull request
- **THEN** electron-builder does not attempt to publish to GitHub Releases (publishing stays gated to the tag-triggered release job)
