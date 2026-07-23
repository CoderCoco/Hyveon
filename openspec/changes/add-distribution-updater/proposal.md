## Why

Epic #141 ("distribution + auto-update scaffolding") is the final open epic of the Electron desktop pivot initiative (#214). The tag-triggered release workflow (#202) already ships, but the remaining scaffolding is missing: `electron-updater` is not wired at all (zero references in the codebase), there are no per-OS install instructions for the unsigned MVP builds, no code-signing roadmap for future maintainers, and the packaged app still ships with electron-builder's default icon (#275). Closing these out completes M4 and lets initiative #214 be closed.

## What Changes

- Wire `electron-updater` into the Electron main process via a new `desktop-main/src/updater.ts`, gated **off by default** behind an `enableAutoUpdate` boolean in electron-store. When the flag is false (the default), the updater is constructed but never calls `checkForUpdates` — first launch produces zero outbound traffic to update servers, and any update-check telemetry is gated by the same flag. (#206)
- Extend the typed `AppStoreSchema` in `ElectronStoreService` with the `enableAutoUpdate` flag.
- Add `publish: github` to `electron-builder.yml` so packaged builds carry the update-feed metadata `electron-updater` needs once the flag is flipped.
- Write `docs/docs/install.md`: unsigned-MVP install instructions per OS — macOS right-click → Open (Gatekeeper), Windows SmartScreen "More info → Run anyway", Linux AppImage `chmod +x` — linked from the README and the existing "Option C — packaged Electron app" section of `docs/docs/setup.md`. (#207)
- Write `docs/docs/code-signing-roadmap.md`: path to signed releases (Apple Developer account + notarization config, Azure Trusted Signing for Windows), the flow for enabling auto-update once signing lands, cost/ownership notes, and the note that `hardenedRuntime: false` in `electron-builder.yml` stays until signing arrives. (#209)
- Produce the Hyveon app-icon asset set (`build/icon.icns`, `build/icon.ico`, `build/icon.png` ≥512×512) from operator-supplied/approved artwork, wire `icon:` into `electron-builder.yml` for all three targets, and add a matching favicon to `app/packages/web/index.html`. (#275)
- Housekeeping: verify the already-implemented `.github/workflows/package.yml` satisfies #202's acceptance criteria and close #202 with an evidence comment (no code change needed).
- Auto-update remains explicitly **disabled** for v1 — this change scaffolds it only.

## Capabilities

### New Capabilities

- `auto-update-scaffold`: `electron-updater` wired into the main process behind a default-off `enableAutoUpdate` electron-store flag, with `publish: github` feed metadata in electron-builder.
- `install-and-signing-docs`: operator-facing docs for installing the unsigned MVP builds on each OS, plus the code-signing roadmap for future signed releases and auto-update enablement.
- `app-icon`: platform-specific Hyveon icon assets wired into electron-builder (installer, taskbar/dock, exe) and a matching web favicon.

### Modified Capabilities

_None — `openspec/specs/` contains no existing capabilities touched by this change._

## Impact

- **Code**: `app/packages/desktop-main/src/updater.ts` (new), `app/packages/desktop-main/src/electron-entry.ts` (invoke updater init), `app/packages/desktop-main/src/services/ElectronStoreService.ts` (schema field), `electron-builder.yml` (`publish`, `icon`), `app/packages/web/index.html` (favicon), `build/` icon assets (new directory).
- **Dependencies**: adds `electron-updater` to the desktop-main workspace.
- **Docs**: `docs/docs/install.md` (new), `docs/docs/code-signing-roadmap.md` (new), `docs/docs/setup.md` (link), `README.md` (Install link).
- **Issues/PRs**: closes #206, #207, #209, #275, epic #141, housekeeping-closes #202, and unblocks closing initiative #214. One PR per issue, per repo convention.
- **No runtime behaviour change** for existing users: the updater is inert until an operator flips `enableAutoUpdate`, and unsigned builds keep working exactly as today.
