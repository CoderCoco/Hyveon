# Design — First-Run Wizard (epic #139)

## Context

The Electron pivot design spec (`docs/superpowers/specs/2026-05-10-electron-desktop-pivot-design.md`, "First-run wizard (`FirstRunWizardService`)" section) locks the wizard's shape: six steps, resumable via `userData/state.json`, never auto-install, never auto-grant, SDK-only bootstrap, safeStorage for pasted keys, Reconfigure re-runs steps 2–5. This change implements that section verbatim.

Substrate that already shipped and is currently dead code — reuse, don't rebuild:

- `SafeStorageService` (`desktop-main/src/services/SafeStorageService.ts`) — OS-keychain encrypt/decrypt with graceful non-Electron degrade, fully tested.
- `ElectronStoreService` — typed store with `wizardCompleted`, `activeCloud: 'aws'` (locked to AWS for v1), and encrypted `aws.accessKeyId`/`aws.secretAccessKey` accessors. Nothing reads these today; no IPC touches credentials.
- `TerraformService` — `lookupCommandFor(platform)` (`which`/`where.exe`), static `resolveVersion`, `TerraformNotFoundError` whose TSDoc already promises it is "surfaced to the first-run wizard's prerequisite check". `fix-path-bootstrap.ts` repairs the GUI-launch PATH at boot.
- `terraform.init` streaming IPC + preload `streamTerraformInit` async iterable (self-bridged via `SELF_BRIDGED_PATTERNS` in `ipc-main-bridge.ts`) — the init step consumes this as-is.
- `terraform/bootstrap/` provisions the tfvars bucket in HCL — the wizard replicates its resource shape via SDK (locked: no shell-out) and must stay behaviorally consistent with it (versioning + 90-day noncurrent-version lifecycle).
- The add-game wizard (`web/src/components/add-game-wizard/`) is the in-repo step-flow pattern (shell component + one component per step + pure `wizard-form.utils.ts`) to mirror for the first-run wizard UI.

## Goals / Non-Goals

**Goals:**

- Clean machine → dashboard-ready purely through the wizard; answers reload on next launch; partial runs resume.
- Pasted keys never appear as plaintext in `electron-store.json` (integration-test verified).
- IAM gaps against `GameServerDeployAll` (source of truth: `docs/docs/setup.md`) surfaced as copy-paste JSON via batched `iam:SimulatePrincipalPolicy`.
- Settings "Reconfigure" re-runs steps 2–5 with per-step Edit, preserving unchanged config and surviving mid-flow cancel.
- Renderer never touches the AWS SDK; main process is the sole cloud authority (enforced by lint).

**Non-Goals:**

- Auto-installing terraform/aws (elevation risk — show instructions + Re-check only).
- Auto-granting IAM permissions.
- Multi-cloud (v1 hard-codes AWS; the pick-cloud step is merely structured for future options).
- Replacing `terraform/bootstrap/` HCL or touching Lambda/Discord/`terraform/` infrastructure.
- SSO / assumed-role credential flows (static profiles + pasted keys only for v1).

## Decisions

1. **New `WizardModule` grouping wizard-scoped providers.** `FirstRunWizardService`, `PrerequisiteService`, `AwsProfileService`, `BootstrapService`, `IamCheckService` live in one feature module (pattern: `TerraformModule`, `DiscordModule`), importing `ConfigModule` and re-using `ElectronStoreService`/`SafeStorageService` providers. Alternative — folding into `AwsModule` — rejected: `AwsModule` is being reduced to a `CloudProviderModule` re-export, and wizard services are cloud-setup, not steady-state operations.

2. **IPC-only controllers with `@MessagePattern('wizard.<verb>')`, request/response only.** Patterns: `wizard.prereqs.check`, `wizard.state.get`/`wizard.state.save`, `wizard.aws.listProfiles`, `wizard.aws.saveCredentials`, `wizard.bootstrap.stateBucket`/`lockTable`/`tfvarsBucket`, `wizard.iam.simulate`, `wizard.complete`, `wizard.reconfigure.start`. All are short-lived request/response calls handled by the generic `registerIpcMainBridges` bridge — nothing new goes into `SELF_BRIDGED_PATTERNS`. The only streaming step, terraform init, reuses the shipped `terraform.init` channel. Per the paired-controller pattern (memory: IPC conversions #152–159), any HTTP shim needed for the integration tier stays a separate `*-http.controller.ts`; electron imports stay gated on `process.versions.electron`.

3. **Preload namespace `gsd.wizard.*` mirrored in `gsd-api.ts`.** Typed methods matching the patterns above; the init step consumes the existing `gsd.terraform.init` async iterable. Renderer gets summaries and statuses only — never key material.

4. **Wizard progress in `userData/state.json`, answers in electron-store.** The design doc names `state.json` for resumable progress; durable answers (`activeCloud`, credentials, backend resource names, `wizardCompleted`) live in `ElectronStoreService` where accessors already exist. `FirstRunWizardService` owns `state.json` I/O behind a protected `userDataPath()` seam (Electron `app.getPath('userData')`, temp-dir fallback outside Electron) so vitest can `vi.spyOn` it. Corrupt/missing state ⇒ start at step 1. Alternative — everything in electron-store — rejected: keeps ephemeral flow state out of the durable config file and matches the locked design verbatim.

5. **Credentials model.** Profile path: store the chosen `{ profileName, region }` only; SDK clients use `fromIni({ profile })` so key material stays in `~/.aws`. Paste path: `SafeStorageService.encrypt` each value, store under `creds.aws.<profileName>` (default `gsd-pasted`), extending `ElectronStoreService`'s schema alongside its existing `aws.*` accessors. Decryption only inside main-process factories (`CloudProviderModule` / SDK-client factory); an integration test greps the store file for plaintext.

6. **Bootstrap = three idempotent SDK operations + IAM simulation, each its own service method and IPC call.** Granular calls (not one mega "bootstrap" call) let the UI render per-resource status and retry a single failed resource. Idempotency mapping: S3 `BucketAlreadyOwnedByYou` ⇒ success then ensure versioning/SSE/lifecycle; DynamoDB `ResourceInUseException` ⇒ success; DynamoDB waiter until `ACTIVE`. IAM check: `sts:GetCallerIdentity` → parse `GameServerDeployAll` action list from `docs/docs/setup.md`'s JSON at build/test time into a shared constant, batch `SimulatePrincipalPolicy` calls (~50 actions per request), diff denied actions into a minimal pasteable policy JSON. Best-effort: simulation errors degrade to a warning, never block.

7. **Renderer AWS ban via ESLint.** `no-restricted-imports` (pattern `@aws-sdk/*`) scoped to `packages/web/**` in `app/eslint.config.js`.

8. **Wizard UI mirrors the add-game wizard pattern.** `first-run-wizard.component.tsx` shell owning step index + gathered state, one component per step, pure helpers in a `wizard.utils.ts`. Launch gating in the router: `wizardCompleted === false` ⇒ render wizard route. Reconfigure mounts the same shell with `mode: 'reconfigure'` (starts at step 2, steps pre-marked complete from stored state, per-step Edit, commit-on-finish so cancel is safe — edits buffer in component state, not the store).

9. **Terraform minimum version pin.** A `MINIMUM_TERRAFORM_VERSION` constant in `@hyveon/shared` (compared with a semver-lite check in `PrerequisiteService`); Settings shows resolved vs. minimum.

## Risks / Trade-offs

- [Ad-hoc INI parsing of `~/.aws` drifts from AWS CLI behavior] → Use `@aws-sdk/shared-ini-file-loader` (already an SDK transitive) instead of hand-rolling; acceptance test compares against `aws configure list-profiles` output shape.
- [`SimulatePrincipalPolicy` false positives (condition-keyed statements, service-linked actions)] → batch requests, mark the panel explicitly "best-effort", never block progression on it.
- [SDK bootstrap drifting from `terraform/bootstrap/` HCL] → mirror the HCL's resource settings in the SDK service and note the coupling in TSDoc on each bootstrap method; a follow-up could generate both from one source, out of scope here.
- [safeStorage unavailable on some Linux setups (no keyring)] → `SafeStorageService` already degrades detectably; the paste flow surfaces an explicit error rather than storing plaintext (spec'd).
- [Reconfigure corrupting a working install on cancel] → buffer edits in renderer state, single commit IPC on finish; mid-flow cancel writes nothing.
- [Wizard e2e on clean machines is hard to automate] → tier-2 integration specs drive controllers with `aws-sdk-client-mock`; the Electron e2e tier covers the wizard shell via `window.gsd.__test.mock` seams; the true clean-machine run stays a manual release check.

## Migration Plan

No data migration — all stores are new or previously unread. Ship order follows the task groups (parallel entry points #182/#189/#197 per initiative #214). Existing users (dev machines with working config but `wizardCompleted` unset) would see the wizard once; completing or Reconfigure-cancelling restores normal operation. Rollback = revert the PR(s); dead-code substrate returns to dormant.

## Open Questions

- Default names for the state bucket / lock table / tfvars bucket (derive from `project_name` + account ID vs. operator-editable fields in the bootstrap step). Leaning operator-editable with a sensible derived default; finalize in #200's PR.
- Whether Reconfigure's step 5 (`terraform init`) should auto-run when backend settings are unchanged, or always require an explicit run. Leaning always-explicit; finalize in #211's PR.
