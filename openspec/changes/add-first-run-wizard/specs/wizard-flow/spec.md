# Wizard Flow

## ADDED Requirements

### Requirement: Wizard launch gating
The app SHALL open into the first-run wizard when `wizardCompleted` in electron-store is false (or unset), and into the dashboard when it is true. Completing the wizard SHALL set `wizardCompleted: true` and navigate to the dashboard.

#### Scenario: First launch on a clean machine
- **WHEN** the app launches with no prior wizard completion recorded
- **THEN** the renderer shows the first-run wizard instead of the dashboard

#### Scenario: Subsequent launches
- **WHEN** the app launches after the wizard has been completed
- **THEN** the dashboard opens directly and the wizard is not shown

### Requirement: FirstRunWizardService with resumable state
A `FirstRunWizardService` in the desktop main process SHALL own wizard progress, persisting per-step completion and answers to `userData/state.json` after each step so a partial run resumes at the first incomplete step on next launch. State reads/writes go through the service (no raw `process.env` or ad-hoc file access in business logic), and the file path is resolved through an Electron seam that degrades gracefully outside Electron for tests.

#### Scenario: Resume after interrupted run
- **WHEN** the operator quits the app after completing steps 1–3 and relaunches
- **THEN** the wizard reopens at step 4 with the answers from steps 1–3 preserved

#### Scenario: Corrupt or missing state file
- **WHEN** `userData/state.json` is missing or unparseable
- **THEN** the wizard starts from step 1 without crashing

### Requirement: Pick-cloud step
The second wizard step SHALL present the cloud choice as a single-option selection hard-coded to "AWS" for v1, with a "more clouds coming" footer, and persist the choice to electron-store as `activeCloud: 'aws'` via `ElectronStoreService`. The step's data model MUST be structured so additional options (`gcp`, `azure`) can be added without reworking the step (options driven by a list, not a hard-coded single control).

#### Scenario: Choosing AWS
- **WHEN** the operator confirms the cloud step
- **THEN** `activeCloud: 'aws'` is persisted and survives an app relaunch

#### Scenario: Only AWS is offered in v1
- **WHEN** the cloud step renders
- **THEN** AWS is the only selectable option and the footer indicates more clouds are coming

### Requirement: Terraform init step with live log
The final configuration step SHALL invoke `TerraformService.init({ backendConfig: { bucket, region, dynamodbTable } })` using the bootstrapped backend resources, streaming stdout/stderr live into a wizard log pane via the existing `terraform.init` streaming IPC channel (`gsd.terraform.init` async iterable). ANSI colors in the output MUST render correctly. The completion control SHALL enable only when the run exits with code 0; a non-zero exit SHALL surface an error state with the captured log and allow retry.

#### Scenario: Successful init
- **WHEN** `terraform init` streams output and exits 0
- **THEN** the log pane shows the live output with ANSI colors rendered and the completion button becomes enabled

#### Scenario: Failed init
- **WHEN** `terraform init` exits non-zero
- **THEN** the step shows an error UI with the log, keeps the completion button disabled, and offers a retry

### Requirement: Wizard completion
On finishing the final step, the wizard SHALL persist all answers (via `ElectronStoreService` and the wizard state file), set `wizardCompleted: true`, and open the dashboard. A fresh install on a clean machine MUST reach "dashboard ready" through the wizard without manual file editing.

#### Scenario: End-to-end completion
- **WHEN** the operator completes all wizard steps on a clean machine
- **THEN** answers are persisted, `wizardCompleted` is true, and the dashboard opens without any hand-edited config files

### Requirement: Reconfigure entry point in Settings
The Settings page SHALL surface a "Reconfigure" button that relaunches the wizard against the existing electron-store state, re-running steps 2–5 (cloud, credentials, bootstrap, init) — prerequisite detection is step 1 and is not repeated. Steps already satisfied by existing state SHALL render as completed with a per-step "Edit" affordance rather than forcing re-entry. Reconfigure MUST preserve existing configuration except the fields the operator changes, and cancelling mid-flow MUST leave the pre-reconfigure configuration intact and the app usable.

#### Scenario: Reconfigure with one change
- **WHEN** the operator opens Reconfigure and edits only the region in the credentials step
- **THEN** the region updates while every other stored setting is preserved

#### Scenario: Completed steps are skippable
- **WHEN** Reconfigure opens with all steps previously completed
- **THEN** each step shows as completed with an "Edit" affordance and the operator can jump straight to finishing

#### Scenario: Mid-flow cancel
- **WHEN** the operator cancels Reconfigure partway through
- **THEN** no partial changes are committed and the app returns to Settings in its prior working state

### Requirement: Resolved Terraform version in Settings
Settings SHALL display the Terraform version resolved by the detection service alongside the pinned minimum supported version, so operators can see what the wizard validated against.

#### Scenario: Settings shows versions
- **WHEN** the operator opens Settings after wizard completion
- **THEN** the resolved Terraform version and the pinned minimum are both visible
