# Cloud Bootstrap

## ADDED Requirements

### Requirement: SDK-only bootstrap in the main process
All backend bootstrap operations (state bucket, lock table, tfvars bucket, IAM simulation) SHALL be performed via AWS SDK v3 clients in the desktop main process — never by shelling out to the `aws` CLI or Terraform. The renderer MUST NOT import any `@aws-sdk/*` package; an ESLint rule SHALL enforce this ban for `@hyveon/web`. SDK clients MUST be constructed with the credentials and region selected in the credentials step (profile via the SDK credential chain, or paste-flow values decrypted in the main process).

#### Scenario: Bootstrap uses SDK clients only
- **WHEN** any wizard bootstrap step runs
- **THEN** the work is done through `@aws-sdk/client-s3` / `@aws-sdk/client-dynamodb` / `@aws-sdk/client-iam` calls in the main process, with no child-process shell-out

#### Scenario: Renderer AWS SDK import is a lint error
- **WHEN** a file under `app/packages/web/` imports from `@aws-sdk/*`
- **THEN** `npm run app:lint` fails on that import

### Requirement: Terraform state bucket bootstrap
The bootstrap service SHALL create the Terraform S3 state bucket when it does not exist, then enable bucket versioning (`PutBucketVersioning`) and default server-side encryption (`PutBucketEncryption`). The operation MUST be idempotent: an already-existing bucket owned by the caller (`BucketAlreadyOwnedByYou`, or a successful existence check) is a success no-op, while a bucket owned by another account surfaces a clear error.

#### Scenario: Fresh bucket
- **WHEN** the state bucket does not exist
- **THEN** the service creates it and enables versioning and SSE, and the step reports success

#### Scenario: Bucket already exists and is owned by the caller
- **WHEN** the state bucket already exists in the caller's account
- **THEN** the step succeeds without error and versioning/SSE are ensured

#### Scenario: Bucket name taken by another account
- **WHEN** `CreateBucket` fails because the name is owned elsewhere
- **THEN** the wizard surfaces an actionable error and does not mark the step complete

### Requirement: Terraform lock table bootstrap
The bootstrap service SHALL create the DynamoDB state-lock table via `CreateTable` with a `LockID` string hash key (the schema Terraform's S3 backend locking requires), and SHALL wait until the table is `ACTIVE` before reporting success. The operation MUST be idempotent — `ResourceInUseException` (table already exists) is a success no-op.

#### Scenario: Fresh lock table
- **WHEN** the lock table does not exist
- **THEN** the service creates it with the `LockID` hash key and reports success once the table is `ACTIVE`

#### Scenario: Lock table already exists
- **WHEN** `CreateTable` throws `ResourceInUseException`
- **THEN** the step succeeds without error

### Requirement: Tfvars bucket bootstrap
The bootstrap service SHALL create the versioned tfvars bucket when missing, enable versioning, and apply a lifecycle configuration expiring noncurrent object versions after 90 days — matching what the `terraform/bootstrap/` module provisions, so the bucket is usable as the canonical `RemoteFileStore`. The operation MUST be idempotent.

#### Scenario: Fresh tfvars bucket
- **WHEN** the tfvars bucket does not exist
- **THEN** the service creates it with versioning enabled and a 90-day noncurrent-version-expiration lifecycle rule

#### Scenario: Tfvars bucket already exists
- **WHEN** the tfvars bucket already exists in the caller's account
- **THEN** the step succeeds and versioning plus the lifecycle rule are ensured

### Requirement: IAM permission simulation
After credentials are wired, the wizard SHALL run a best-effort dry-run via `iam:SimulatePrincipalPolicy` against the calling identity (resolved via `sts:GetCallerIdentity`) for the action set of the `GameServerDeployAll` policy, whose single source of truth is the policy JSON in `docs/docs/setup.md`. Simulation requests MUST be batched to stay within API limits and minimize false positives. Missing actions SHALL be surfaced in the wizard as a "Required IAM JSON" panel containing copy-paste-able policy JSON covering the denied actions. The wizard MUST NEVER attempt to grant permissions itself, and simulation failure (e.g. the caller lacks `iam:SimulatePrincipalPolicy` itself) MUST degrade to a warning with the full checklist shown — it does not block wizard progression.

#### Scenario: All actions allowed
- **WHEN** the simulation reports every `GameServerDeployAll` action as allowed
- **THEN** the wizard shows the IAM check as passed with no JSON panel

#### Scenario: Missing actions surfaced as pasteable JSON
- **WHEN** the simulation reports one or more actions as denied
- **THEN** the wizard renders a "Required IAM JSON" panel whose policy JSON the operator can paste into the AWS console, and no auto-grant is attempted

#### Scenario: Simulation itself is not permitted
- **WHEN** the `SimulatePrincipalPolicy` call fails with an access error
- **THEN** the wizard shows a non-blocking warning with the full permission checklist instead of a hard failure

### Requirement: Bootstrap IPC and progress reporting
Each bootstrap operation (state bucket, lock table, tfvars bucket, IAM check) SHALL be invocable from the renderer through IPC-only controller message patterns under a `wizard.bootstrap.*` namespace, mirrored in the typed preload API, reporting per-resource status (`pending` / `creating` / `exists` / `created` / `failed` with an error message) so the wizard step can render granular progress.

#### Scenario: Renderer runs the bootstrap step
- **WHEN** the renderer invokes the bootstrap IPC methods for the three resources
- **THEN** each resolves with a per-resource status the step renders, and a failure in one resource reports `failed` with its error message without masking the others
