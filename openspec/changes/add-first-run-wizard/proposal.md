# Add First-Run Wizard

## Why

A fresh install of the Hyveon desktop app currently requires hand-editing config files, pre-creating the Terraform S3 backend by hand, and knowing which CLIs must be on PATH before anything works. Epic #139 closes that gap: a resumable multi-step wizard takes a clean machine to "dashboard ready" with no manual file editing, and a Settings "Reconfigure" entry point re-runs it later. The supporting substrate (`SafeStorageService`, `ElectronStoreService` with `wizardCompleted`/`activeCloud`/encrypted `aws.*` accessors, `TerraformService` binary detection, the `terraform.init` streaming IPC channel) already shipped as dead code awaiting this epic.

## What Changes

- New `FirstRunWizardService` in `@hyveon/desktop-main`, resumable via `userData/state.json`, orchestrating six steps: prerequisite detection → pick cloud → credentials → SDK backend bootstrap → `terraform init` → persist & open dashboard.
- New prerequisite-detection service probing `terraform` and `aws` on PATH via `which`/`where.exe` (reusing `lookupCommandFor` and the fix-path boot PATH), exposed over IPC with a blocking wizard step, per-OS install instructions, and a Re-check button. The wizard never auto-installs.
- New `AwsProfileService` parsing `~/.aws/credentials` + `~/.aws/config` into `{ profileName, region }` summaries; key material never crosses IPC to the renderer.
- Paste-flow credentials encrypted via `safeStorage.encryptString` and stored in electron-store under `creds.aws.<profileName>` (default profile name `gsd-pasted`); decryption happens only inside main-process cloud-provider factories.
- SDK-driven backend bootstrap (no shell-out, locked decision): S3 tf-state bucket (versioning + SSE), DynamoDB lock table (`LockID` key), versioned S3 tfvars bucket (90-day noncurrent-version lifecycle) — all idempotent.
- Best-effort `iam:SimulatePrincipalPolicy` dry-run against the `GameServerDeployAll` action set (source of truth: `docs/docs/setup.md`), surfacing missing actions as copy-paste IAM JSON. Never auto-grants.
- Final wizard step runs `TerraformService.init({ backendConfig })` streaming live ANSI log output into the wizard pane via the already-shipped `terraform.init` IPC channel.
- Wizard UI in `@hyveon/web` (step shell + five step components), gated on `wizardCompleted`; "Reconfigure" button in Settings re-runs steps 2–5 with per-step Edit affordances.
- Lint rule banning `@aws-sdk/*` imports from `@hyveon/web` — the main process is the sole AWS authority.
- Wizard pins a minimum Terraform version; the resolved version is shown in Settings.

## Capabilities

### New Capabilities

- `prerequisite-detection`: probing for `terraform`/`aws` binaries, version parsing, IPC exposure, and the blocking "install prerequisites" wizard step.
- `aws-credentials`: `~/.aws` profile discovery, the pick-or-paste credentials wizard step, and safeStorage-encrypted paste-flow storage.
- `cloud-bootstrap`: idempotent AWS SDK creation of the tf-state bucket, lock table, and tfvars bucket, plus the `SimulatePrincipalPolicy` IAM check.
- `wizard-flow`: the wizard shell — launch gating, step sequencing, resumable state, pick-cloud step, terraform-init step, completion persistence, and Settings Reconfigure.

### Modified Capabilities

None — all capabilities are new (no existing spec in `openspec/specs/` covers first-run setup).

## Impact

- **Code**: new services/controllers/module in `app/packages/desktop-main/src/` (wizard, prerequisites, AWS profiles, bootstrap); new `gsd.wizard.*` preload namespace + `gsd-api.ts` mirrors in `app/packages/desktop-preload/`; new wizard components and a Settings section in `app/packages/web/src/`; consumes previously-dead `SafeStorageService`/`ElectronStoreService` code.
- **Dependencies**: first in-app use of `@aws-sdk/client-s3`, `@aws-sdk/client-dynamodb`, `@aws-sdk/client-iam`, `@aws-sdk/client-sts` in `@hyveon/desktop-main`.
- **Issues/PRs**: 12 child issues of epic #139 (#182, #184, #186, #189, #192, #197, #200, #203, #205, #208, #210, #211) — one PR each.
- **Not affected**: Terraform HCL under `terraform/` (the wizard bootstraps via SDK, not the `terraform/bootstrap/` module), the Lambdas, and the Discord path.
