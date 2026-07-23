# terraform-destroy-flow

## ADDED Requirements

### Requirement: Destroy IPC channel

`TerraformController` SHALL expose a `terraform.destroy` IPC channel following the shipped `terraform.apply` streaming pattern: a self-bridged handler (registered via `onModuleInit` inside a real Electron main process, excluded from the generic bridge via `SELF_BRIDGED_PATTERNS` in `ipc-main-bridge.ts`) that resolves an immediate `{ started, runId?, error?, conflict? }` ack, streams every `TerraformService.destroy` chunk on a chunk side channel tagged with the run's id, sends exactly one terminal end message, and refuses submission with a `conflict` ack when the shared workspace is busy. The handler MUST acquire the durable apply lock (`RunService.createRun`) before spawning and release it on every exit path, record an audit entry for accepted submissions, and rely on `TerraformService.destroy`'s existing run-record persistence so destroy runs appear in run history.

#### Scenario: Destroy streams output and completes

- **WHEN** a valid destroy submission is accepted and `terraform destroy` runs to completion
- **THEN** the renderer receives ordered chunk messages tagged with the run id followed by a single end message with exit code 0, and a `kind: 'destroy'` run record is persisted and visible in run history

#### Scenario: Destroy refused while the workspace is busy

- **WHEN** `terraform.destroy` is invoked while another subcommand is in flight
- **THEN** the ack resolves `{ started: false, conflict }` naming the in-flight operation, no process is spawned, and no audit entry or run record is written

### Requirement: Fresh confirmation token gate

Every destroy attempt SHALL be gated on a fresh, server-minted, single-use, expiring confirmation token: the renderer requests a token via a plain-invoke IPC channel backed by `TerraformService.mintDestroyConfirmationToken()`, and `terraform.destroy` passes the supplied token to `TerraformService.destroy`, which refuses (per `DestroyNotConfirmedError`) when the token is absent, unknown, expired, or already consumed. The system MUST NOT ever invoke `terraform destroy` with `-auto-approve` semantics absent this gate, and tokens MUST NOT be reusable across attempts.

#### Scenario: Destroy without a fresh token is refused

- **WHEN** `terraform.destroy` is invoked with a missing, expired, or previously consumed confirmation token
- **THEN** the submission is refused with the `DestroyNotConfirmedError`-derived error, and no `terraform destroy` process is spawned

#### Scenario: Each attempt needs its own token

- **WHEN** a destroy run completes (or fails) and the operator initiates another destroy
- **THEN** a new token must be minted and confirmed — the prior token is rejected

### Requirement: Preload destroy bridge

The preload SHALL expose the destroy surface on the `gsd.terraform` namespace — a token-minting call plus a `destroy` call following the existing streaming bridge shape (side-channel chunk/end events surfaced to the renderer, honoring the test-mode mock registry) — with typed mirrors in `gsd-api.ts` kept in sync with the controller payload shapes.

#### Scenario: Renderer consumes destroy output through the bridge

- **WHEN** the renderer initiates a destroy through `gsd.terraform` with a freshly minted token
- **THEN** it receives the run's chunks in order and a terminal completion/error through the preload bridge without touching `ipcRenderer` directly

### Requirement: Type-to-confirm destroy UI

The `/terraform` page SHALL offer a destroy entry point that opens an explicit type-to-confirm dialog: the operator MUST type a fixed confirmation phrase before the app mints a token and submits the destroy, the dialog MUST spell out that all managed infrastructure will be destroyed, and the run's output MUST stream live in the same ANSI log viewer used for plan/apply. A BUSY conflict MUST be surfaced the same way as plan/apply conflicts.

#### Scenario: Confirmation phrase gates submission

- **WHEN** the destroy dialog is open and the typed text does not match the required phrase
- **THEN** the destructive confirm button remains disabled and no token is minted

#### Scenario: Confirmed destroy streams live

- **WHEN** the operator types the exact phrase and confirms
- **THEN** a token is minted, the destroy is submitted, and its output streams live with a terminal success or failure state shown when it ends
