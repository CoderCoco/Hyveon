# Orchestrator Integration Coverage

## ADDED Requirements

### Requirement: Fake terraform binary injected via PATH

The integration test harness SHALL cause `TerraformService` to resolve `app/test/fake-terraform.mjs` as the `terraform` binary through its normal PATH lookup (`which`/`where.exe`), without patching `TerraformService` internals. No integration spec SHALL invoke a real `terraform` binary or reach real AWS. The scripted fixture MUST include a `version` entry so `TerraformService`'s `terraform version -json` resolution succeeds against the fake.

#### Scenario: Fake binary resolved through normal PATH lookup

- **WHEN** an integration spec prepends the shim directory (containing an executable `terraform` wrapper for `fake-terraform.mjs`) to `PATH` and sets `FAKE_TERRAFORM_SCRIPT`, then boots the `ipc` harness and triggers any terraform subcommand
- **THEN** `TerraformService` resolves and spawns the shim as `terraform`, and the run's output matches the scripted fixture lines rather than real terraform output

#### Scenario: Version resolution succeeds against the fake

- **WHEN** `TerraformService` performs its memoized binary/version resolution during a spec
- **THEN** the fixture's scripted `version` response is parsed and resolution succeeds without throwing `TerraformNotFoundError`

### Requirement: Plan integration coverage

The integration suite SHALL verify that `TerraformService.plan` run through the real DI container produces the `.tfplan` artifact at `<runsDir>/<runId>/<runId>.tfplan`, computes its SHA-256 `planHash`, and reports the scripted plan summary — and that a failing plan yields a failed outcome with no `planHash`.

#### Scenario: Successful plan produces artifact and planHash

- **WHEN** a spec drives `plan()` with a fixture scripting a zero-exit `plan` response whose `-out=` artifact is written by the fake
- **THEN** the run completes with a success outcome whose `artifactPath` exists on disk and whose `planHash` equals the SHA-256 hex digest of that artifact's bytes

#### Scenario: Failed plan yields no planHash

- **WHEN** a spec drives `plan()` with a fixture scripting a non-zero exit code
- **THEN** the run completes with a failed outcome and no `planHash` is computed or persisted

### Requirement: Apply rejects stale and unapproved plans

The integration suite SHALL verify `terraform.apply`'s pre-spawn gates through the real controller wiring: apply MUST be rejected (with no terraform process spawned) when the plan run has no approval, when the approval is older than the 15-minute `APPROVAL_WINDOW_MS`, or when the supplied `planHash` does not match the approved record — and MUST proceed to spawn the fake terraform when a fresh, matching approval exists.

#### Scenario: Unapproved plan rejected

- **WHEN** `TerraformController.apply` is dispatched for a plan run whose persisted record has no `approvedBy`/`approvedAt`
- **THEN** the ack is `{ started: false }` with an error describing the missing approval, and the fake terraform binary is never spawned for `apply`

#### Scenario: Expired approval rejected

- **WHEN** `TerraformController.apply` is dispatched for a plan run whose `approvedAt` is older than the 15-minute approval window
- **THEN** the ack is `{ started: false }` with an approval-expired error, and the fake terraform binary is never spawned for `apply`

#### Scenario: Mismatched planHash rejected

- **WHEN** `TerraformController.apply` is dispatched with a `planHash` that does not match the approved plan record's stored hash
- **THEN** the ack is `{ started: false }` with a stale/mismatched-plan error, and the fake terraform binary is never spawned for `apply`

#### Scenario: Fresh approved plan applies

- **WHEN** `TerraformController.apply` is dispatched with the correct `planHash` for a plan record approved within the window, whose on-disk `.tfplan` artifact still hashes to that value
- **THEN** the ack is `{ started: true }` and the fake terraform's scripted `apply` response is executed to completion

### Requirement: Destroy gated by fresh confirmation token

The integration suite SHALL verify that `TerraformService.destroy` refuses to spawn terraform without a fresh confirmation token minted via `mintDestroyConfirmationToken()` — throwing `DestroyNotConfirmedError` for missing, expired, superseded, or already-consumed tokens — and runs the scripted `destroy` when a valid token is supplied.

#### Scenario: Destroy without a token rejected

- **WHEN** a spec invokes `destroy()` without minting a confirmation token
- **THEN** `DestroyNotConfirmedError` is thrown and the fake terraform binary is never spawned for `destroy`

#### Scenario: Consumed token cannot be reused

- **WHEN** a spec mints a token, completes one `destroy()` run with it, and invokes `destroy()` again with the same token
- **THEN** the second call throws `DestroyNotConfirmedError` and no second `destroy` process is spawned

#### Scenario: Fresh token permits destroy

- **WHEN** a spec mints a confirmation token and invokes `destroy()` with it immediately
- **THEN** the scripted `destroy` response is streamed to completion and the run's exit code matches the fixture

### Requirement: Streamed run chunks preserve ANSI escape sequences

The integration suite SHALL verify that `TerraformService`'s streamed `TerraformRunChunk`s and the persisted `<runsDir>/<runId>/terraform.log` pass scripted stdout/stderr lines through verbatim — including ANSI colour escape sequences — without stripping or re-encoding, and preserve each line's stream attribution.

#### Scenario: ANSI sequences survive streaming and the run log

- **WHEN** a spec runs a subcommand whose fixture lines contain ANSI escape sequences on both stdout and stderr
- **THEN** every collected chunk's text contains the escape sequences byte-for-byte with correct stdout/stderr attribution, and the persisted `terraform.log` for the run contains them unmodified

### Requirement: Run records persisted for every run

The integration suite SHALL verify that each completed plan/apply/destroy run persists a local `<runsDir>/<runId>/run.json` record capturing `runId`, `kind`, timestamps, `exitCode`, and (for successful plans) `planHash`, that the run is persisted to the `RunRecordStore` via `RunRecordService` with its log embedded inline when under the 350KB limit, and that the run is subsequently retrievable through the runs IPC surface.

#### Scenario: Successful plan writes run.json with planHash

- **WHEN** a spec completes a successful `plan()` run
- **THEN** `<runsDir>/<runId>/run.json` exists with `kind: "plan"`, `exitCode: 0`, and a `planHash` matching the returned result's hash

#### Scenario: Failed run still persisted

- **WHEN** a spec completes a run whose fixture scripts a non-zero exit code
- **THEN** `run.json` is still written with the non-zero `exitCode` and no `planHash`

#### Scenario: Store record embeds inline log

- **WHEN** a spec completes a run whose scripted output is under the 350KB inline limit
- **THEN** the record persisted through the mocked `RunRecordStore` carries the run log inline (no S3 offload key), matching the persisted `terraform.log` content

### Requirement: Output subcommand integration coverage

The integration suite SHALL verify that `terraform.output` dispatched through the real controller runs the fake binary's scripted `output` response and returns the parsed Terraform outputs.

#### Scenario: Scripted outputs parsed and returned

- **WHEN** `TerraformController.output` is dispatched with a fixture scripting a zero-exit `output` response containing valid `terraform output -json` JSON
- **THEN** the dispatch resolves with the parsed outputs matching the fixture's scripted values
