# Tasks — First-Run Wizard (epic #139)

One PR per GitHub issue (12 issues → 12 PRs). Groups 1–3 (#182, #189, #197) are the parallel-first entry points per initiative #214 and have no dependencies on each other. Each group ends with the test/lint gate and a `/pr` task; the PR body's FIRST line is the `Closes #<N>` keyword. The PR that completes the last open child of epic #139 (group 12, #211, when done in this order) additionally includes `Closes #139` on its own line.

## 1. Issue #182 — prerequisite-detection service (desktop-main)

- [ ] 1.1 Create worktree: `git worktree add .worktrees/claude/issue-182-prereq-detection -b claude/issue-182-prereq-detection`
- [ ] 1.2 Add `MINIMUM_TERRAFORM_VERSION` constant to `@hyveon/shared` with TSDoc
- [ ] 1.3 Implement `PrerequisiteService` in `desktop-main/src/services/PrerequisiteService.ts`: probe `terraform` and `aws` via `execFile` + existing `lookupCommandFor`; return `{ found, path?, version? }` per tool; environment/platform access behind protected seams for `vi.spyOn` (no raw `process.env`)
- [ ] 1.4 Implement version parsing for Terraform 1.x (`Terraform vX.Y.Z`) and AWS CLI v2 (`aws-cli/X.Y.Z ...`); unparseable output degrades to `found: true` with undefined version; compare terraform against `MINIMUM_TERRAFORM_VERSION` and flag unsatisfied
- [ ] 1.5 Add `WizardModule` (`desktop-main/src/modules/wizard.module.ts`) and IPC-only `WizardController` with `@MessagePattern('wizard.prereqs.check')`; wire into `AppModule`; gate any electron imports on `process.versions.electron`
- [ ] 1.6 Add preload `gsd.wizard.checkPrereqs()` + typed mirror in `gsd-api.ts`
- [ ] 1.7 Co-located vitest specs ("should …" names, TSDoc'd helpers): found/missing/spawn-failure paths, both version formats, minimum-version flagging, controller dispatch
- [ ] 1.8 Verify `npm run app:test` and `npm run app:lint` pass
- [ ] 1.9 Open PR via `/pr` with Conventional Commits title (<70 chars); PR body FIRST line `Closes #182`

## 2. Issue #189 — AwsProfileService (desktop-main)

- [ ] 2.1 Create worktree: `git worktree add .worktrees/claude/issue-189-aws-profile-service -b claude/issue-189-aws-profile-service`
- [ ] 2.2 Implement `AwsProfileService` in `desktop-main/src/services/AwsProfileService.ts` parsing `~/.aws/credentials` + `~/.aws/config` (prefer `@aws-sdk/shared-ini-file-loader`) into `{ profileName, region? }` summaries; home-dir resolution behind a service seam; missing files return `[]`; never expose key material
- [ ] 2.3 Add `@MessagePattern('wizard.aws.listProfiles')` to the wizard IPC controller (or create it here if #182 has not merged) + preload `gsd.wizard.listAwsProfiles()` + `gsd-api.ts` mirror
- [ ] 2.4 Co-located vitest specs: profiles from both files with `profile <name>` aliasing, region pickup, missing files, assertion that responses contain no key material; parity with `aws configure list-profiles` semantics via fixtures
- [ ] 2.5 Verify `npm run app:test` and `npm run app:lint` pass
- [ ] 2.6 Open PR via `/pr` with Conventional Commits title (<70 chars); PR body FIRST line `Closes #189`

## 3. Issue #197 — safeStorage paste-flow (desktop-main)

- [ ] 3.1 Create worktree: `git worktree add .worktrees/claude/issue-197-safestorage-paste-flow -b claude/issue-197-safestorage-paste-flow`
- [ ] 3.2 Extend `ElectronStoreService` schema with `creds.aws.<profileName>` entries (encrypted accessKeyId/secretAccessKey + region), reusing its existing encrypted-accessor pattern and `SafeStorageService`
- [ ] 3.3 Implement paste-flow save in the wizard service layer: encrypt via `SafeStorageService`, default profile name `gsd-pasted`; surface an explicit error when safeStorage is unavailable (no plaintext fallback)
- [ ] 3.4 Add `@MessagePattern('wizard.aws.saveCredentials')` + preload/`gsd-api.ts` mirror; decrypted values never returned over IPC
- [ ] 3.5 Ensure decryption is consumed only in main-process factories (`CloudProviderModule` / SDK-client factory seam) with TSDoc noting the constraint
- [ ] 3.6 Vitest specs: round-trip encrypt/decrypt returns original strings, default profile naming, safeStorage-unavailable error; integration-style spec asserting the persisted store file contains no plaintext key material
- [ ] 3.7 Verify `npm run app:test` and `npm run app:lint` pass
- [ ] 3.8 Open PR via `/pr` with Conventional Commits title (<70 chars); PR body FIRST line `Closes #197`

## 4. Issue #184 — wizard step: install prerequisites (web, after #182)

- [ ] 4.1 Create worktree: `git worktree add .worktrees/claude/issue-184-wizard-prereq-step -b claude/issue-184-wizard-prereq-step`
- [ ] 4.2 Scaffold the first-run wizard shell (`web/src/components/first-run-wizard/first-run-wizard.component.tsx`) mirroring the add-game-wizard step-flow pattern (shell + per-step components + pure utils), with router gating on `wizardCompleted`
- [ ] 4.3 Implement `prerequisites-step.component.tsx`: per-tool detection results, OS-specific install instructions (macOS/Windows/Linux) with vendor links, Re-check button invoking `gsd.wizard.checkPrereqs()`, Next disabled until both tools satisfied, no auto-install path
- [ ] 4.4 React Testing Library/jsdom specs (co-located, "should …" names, `gsd` stubbed via the test-mock-registry pattern): blocked progression when missing, Re-check re-invocation, per-platform instructions, enable-on-green
- [ ] 4.5 Verify `npm run app:test` and `npm run app:lint` pass
- [ ] 4.6 Open PR via `/pr` with Conventional Commits title (<70 chars); PR body FIRST line `Closes #184`

## 5. Issue #186 — wizard step: pick cloud (web)

- [ ] 5.1 Create worktree: `git worktree add .worktrees/claude/issue-186-wizard-pick-cloud -b claude/issue-186-wizard-pick-cloud`
- [ ] 5.2 Implement `pick-cloud-step.component.tsx`: options driven by a list (AWS only in v1) with "more clouds coming" footer; persist `activeCloud: 'aws'` via a `wizard.state.save`-style IPC into `ElectronStoreService`
- [ ] 5.3 Add/extend the IPC + preload surface for persisting the cloud choice (`gsd.wizard.*`), with `ElectronStoreService.activeCloud` as the durable store
- [ ] 5.4 RTL/jsdom specs: single AWS option renders, footer present, confirm persists choice; service spec asserting persistence survives a store reload (relaunch semantics)
- [ ] 5.5 Verify `npm run app:test` and `npm run app:lint` pass
- [ ] 5.6 Open PR via `/pr` with Conventional Commits title (<70 chars); PR body FIRST line `Closes #186`

## 6. Issue #192 — wizard step: pick or paste credentials (web, after #189 + #197)

- [ ] 6.1 Create worktree: `git worktree add .worktrees/claude/issue-192-wizard-credentials-step -b claude/issue-192-wizard-credentials-step`
- [ ] 6.2 Implement `credentials-step.component.tsx`: profile dropdown from `gsd.wizard.listAwsProfiles()`, "paste keys instead" toggle opening a key-ID/secret/region form, region selector defaulting from the selected profile with override
- [ ] 6.3 Wire submission: profile selection persists `{ profileName, region }`; paste form invokes `gsd.wizard.saveCredentials` (safeStorage flow from #197)
- [ ] 6.4 RTL/jsdom specs: dropdown population, paste toggle, region default + override, both submission paths round-tripping through the mocked `gsd.wizard` namespace
- [ ] 6.5 Verify `npm run app:test` and `npm run app:lint` pass
- [ ] 6.6 Open PR via `/pr` with Conventional Commits title (<70 chars); PR body FIRST line `Closes #192`

## 7. Issue #200 — SDK bootstrap: S3 state bucket (desktop-main)

- [ ] 7.1 Create worktree: `git worktree add .worktrees/claude/issue-200-bootstrap-state-bucket -b claude/issue-200-bootstrap-state-bucket`
- [ ] 7.2 Add `@aws-sdk/client-s3` to `@hyveon/desktop-main`; add the ESLint `no-restricted-imports` rule banning `@aws-sdk/*` in `packages/web/**` (renderer never touches the SDK)
- [ ] 7.3 Implement `BootstrapService.ensureStateBucket()`: `CreateBucket` + `PutBucketVersioning` + `PutBucketEncryption`; idempotent (`BucketAlreadyOwnedByYou` ⇒ ensure settings and succeed); clear error when the name is owned by another account; SDK client built from the credentials/region chosen in the wizard
- [ ] 7.4 Add `@MessagePattern('wizard.bootstrap.stateBucket')` + preload/`gsd-api.ts` mirror returning per-resource status (`created`/`exists`/`failed` + message)
- [ ] 7.5 Vitest specs with `aws-sdk-client-mock`: fresh-create path, already-owned no-op, foreign-owner error, versioning + SSE always ensured
- [ ] 7.6 Verify `npm run app:test` and `npm run app:lint` pass
- [ ] 7.7 Open PR via `/pr` with Conventional Commits title (<70 chars); PR body FIRST line `Closes #200`

## 8. Issue #203 — SDK bootstrap: DynamoDB lock table (desktop-main)

- [ ] 8.1 Create worktree: `git worktree add .worktrees/claude/issue-203-bootstrap-lock-table -b claude/issue-203-bootstrap-lock-table`
- [ ] 8.2 Implement `BootstrapService.ensureLockTable()` with `@aws-sdk/client-dynamodb`: `CreateTable` with `LockID` string hash key, waiter until `ACTIVE`; idempotent (`ResourceInUseException` ⇒ success)
- [ ] 8.3 Add `@MessagePattern('wizard.bootstrap.lockTable')` + preload/`gsd-api.ts` mirror with per-resource status
- [ ] 8.4 Vitest specs with `aws-sdk-client-mock`: fresh create + ACTIVE wait, already-exists no-op, failure surfaces `failed` status; assert key schema matches Terraform S3-backend locking requirements
- [ ] 8.5 Verify `npm run app:test` and `npm run app:lint` pass
- [ ] 8.6 Open PR via `/pr` with Conventional Commits title (<70 chars); PR body FIRST line `Closes #203`

## 9. Issue #205 — SDK bootstrap: versioned S3 tfvars bucket (desktop-main)

- [ ] 9.1 Create worktree: `git worktree add .worktrees/claude/issue-205-bootstrap-tfvars-bucket -b claude/issue-205-bootstrap-tfvars-bucket`
- [ ] 9.2 Implement `BootstrapService.ensureTfvarsBucket()`: create-if-missing, `PutBucketVersioning`, `PutBucketLifecycleConfiguration` expiring noncurrent versions after 90 days; idempotent; TSDoc noting behavioral parity with `terraform/bootstrap/`
- [ ] 9.3 Add `@MessagePattern('wizard.bootstrap.tfvarsBucket')` + preload/`gsd-api.ts` mirror; bucket name feeds the `RemoteFileStore` configuration
- [ ] 9.4 Vitest specs with `aws-sdk-client-mock`: fresh create with versioning + lifecycle, existing-bucket no-op with settings ensured, failure path
- [ ] 9.5 Verify `npm run app:test` and `npm run app:lint` pass
- [ ] 9.6 Open PR via `/pr` with Conventional Commits title (<70 chars); PR body FIRST line `Closes #205`

## 10. Issue #208 — IAM SimulatePrincipalPolicy check (desktop-main + web panel)

- [ ] 10.1 Create worktree: `git worktree add .worktrees/claude/issue-208-iam-simulate-check -b claude/issue-208-iam-simulate-check`
- [ ] 10.2 Extract the `GameServerDeployAll` action set from `docs/docs/setup.md` (single source of truth) into a shared constant, with a test asserting the constant stays in sync with the doc's policy JSON
- [ ] 10.3 Implement `IamCheckService`: `sts:GetCallerIdentity` → batched `iam:SimulatePrincipalPolicy` calls (~50 actions per request); diff denied actions into minimal pasteable policy JSON; simulation errors degrade to a non-blocking warning with the full checklist; never auto-grant
- [ ] 10.4 Add `@MessagePattern('wizard.iam.simulate')` + preload/`gsd-api.ts` mirror; render the "Required IAM JSON" panel in the bootstrap wizard step (passed / missing-actions JSON / best-effort warning states)
- [ ] 10.5 Vitest specs with `aws-sdk-client-mock`: all-allowed, partial-deny JSON generation, batching across >50 actions, simulate-access-denied warning path; RTL specs for the three panel states
- [ ] 10.6 Verify `npm run app:test` and `npm run app:lint` pass
- [ ] 10.7 Open PR via `/pr` with Conventional Commits title (<70 chars); PR body FIRST line `Closes #208`

## 11. Issue #210 — wizard step: terraform init with live log (web, after #200/#203/#205)

- [ ] 11.1 Create worktree: `git worktree add .worktrees/claude/issue-210-wizard-terraform-init -b claude/issue-210-wizard-terraform-init`
- [ ] 11.2 Implement `terraform-init-step.component.tsx` consuming the existing `gsd.terraform.init` async iterable with `backendConfig` (bucket/region/dynamodbTable) from the bootstrap step; live log pane with ANSI rendering (reuse the existing ANSI-to-HTML helper)
- [ ] 11.3 Completion button enabled only on exit code 0; non-zero exit shows error UI with the captured log and a retry affordance
- [ ] 11.4 Wire wizard completion: `FirstRunWizardService` persists answers + `wizardCompleted: true` (`wizard.complete` IPC) and the app navigates to the dashboard; resumable `userData/state.json` updated per step
- [ ] 11.5 RTL/jsdom specs (mock the async iterable): streaming render, ANSI colors, enable-on-zero, error + retry on non-zero, completion invoking `wizard.complete`; service specs for state.json resume + corrupt-file fallback
- [ ] 11.6 Verify `npm run app:test` and `npm run app:lint` pass
- [ ] 11.7 Open PR via `/pr` with Conventional Commits title (<70 chars); PR body FIRST line `Closes #210`

## 12. Issue #211 — Reconfigure entry point in Settings (web)

- [ ] 12.1 Create worktree: `git worktree add .worktrees/claude/issue-211-settings-reconfigure -b claude/issue-211-settings-reconfigure`
- [ ] 12.2 Add a "Reconfigure" section to `settings.page.tsx` (alongside Watchdog + Diagnostics) launching the wizard shell in `mode: 'reconfigure'` (steps 2–5; prerequisites not repeated); also surface the resolved Terraform version + pinned minimum in Settings
- [ ] 12.3 Reconfigure semantics: steps pre-marked complete from stored state with per-step "Edit" affordances; edits buffered in component state and committed in a single IPC on finish so mid-flow cancel writes nothing and preserves all unchanged config
- [ ] 12.4 RTL/jsdom specs (via `renderPage()` for the Settings page): Reconfigure entry renders, completed-step Edit affordances, single-field edit preserves everything else, mid-flow cancel commits nothing, version display
- [ ] 12.5 Verify `npm run app:test` and `npm run app:lint` pass
- [ ] 12.6 Open PR via `/pr` with Conventional Commits title (<70 chars); PR body FIRST line `Closes #211`; if this PR completes the last open child of epic #139, also include `Closes #139` on its own line
