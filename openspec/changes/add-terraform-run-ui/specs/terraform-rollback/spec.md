# terraform-rollback

## ADDED Requirements

### Requirement: Complete remote file version listing

`AwsRemoteFileStore.listVersions()` SHALL return the complete version history for a key by paginating `ListObjectVersionsCommand`: while a response reports `IsTruncated: true`, the next request MUST pass the response's `NextKeyMarker`/`NextVersionIdMarker` as `KeyMarker`/`VersionIdMarker`, accumulating every page's `Versions` entries before the existing key-match filtering and newest-first sorting are applied. (Fixes issue #260 — rollback depends on complete version listing.)

#### Scenario: Key with more than one page of versions

- **WHEN** `listVersions` is called for a key whose versions span multiple S3 pages (first response `IsTruncated: true` with continuation markers, final response `IsTruncated: false`)
- **THEN** the returned array contains the versions from every page, filtered to the exact key and sorted newest-`lastModified`-first

#### Scenario: Single-page listing is unchanged

- **WHEN** `listVersions` is called for a key whose versions fit in one response (`IsTruncated` false or absent)
- **THEN** exactly one request is issued and the existing filtering/sorting behavior is preserved

### Requirement: Rollback initiation from history

The history view SHALL offer a "Rollback" action on apply runs that recorded a `tfvarsVersionId`. Initiating a rollback MUST resolve the tfvars S3 version that was live before that run (using the complete version listing) and present it to the operator for confirmation before anything is written.

#### Scenario: Operator starts a rollback

- **WHEN** the operator clicks "Rollback" on an apply run in history
- **THEN** the app resolves the prior tfvars version and shows a confirmation identifying the target version before proceeding

#### Scenario: Runs without a tfvars version offer no rollback

- **WHEN** a history row is a run with no recorded `tfvarsVersionId` (or not an apply run)
- **THEN** no Rollback action is offered for that row

### Requirement: Rollback restores the version and queues a tagged plan

Confirming a rollback SHALL restore the selected historic tfvars version's content as the new head of the tfvars object (a new S3 version — history is never rewritten) and then start a `terraform plan` against that restored version. The resulting plan run's record MUST carry `rolledBackFrom: <applyRunId>` (a new optional `RunRecord` field in `@hyveon/shared/runs.ts`, plumbed through run-record persistence), and the history view MUST display the tag on rollback runs.

#### Scenario: Rollback plan is tagged

- **WHEN** the operator confirms a rollback of apply run `R`
- **THEN** the historic tfvars content is written as the new head version and a plan run starts whose persisted record has `rolledBackFrom: R`, visible as a tag in the history view

### Requirement: Rollback goes through the standard approve and apply gates

A rollback plan SHALL be approved and applied through exactly the same flow as any other plan — explicit approval, the 15-minute approval window, the plan-hash gate, workspace/apply-lock checks. Rollback MUST NOT bypass or weaken any gate.

#### Scenario: Rollback apply requires approval

- **WHEN** a rollback plan completes successfully
- **THEN** its status is `awaiting_approval` and the apply remains blocked until the operator approves it, identically to a normal plan

### Requirement: Missing historic version is a clear error

If the historic tfvars version no longer exists (e.g. removed by S3 lifecycle expiry), the rollback SHALL fail before any write occurs, surfacing an error that names the missing version, and MUST leave the current tfvars head untouched.

#### Scenario: Historic version expired

- **WHEN** the operator confirms a rollback whose target version id no longer exists in S3
- **THEN** the app surfaces an error identifying the missing version, no new tfvars head is written, and no plan run is started
