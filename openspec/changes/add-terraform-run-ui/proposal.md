# Proposal: Terraform Run UI (close out epic #138)

## Why

Epic #138 (local terraform orchestration) shipped a complete backend — `TerraformService` (init/plan/apply/destroy/output with streaming async generators, planHash + stale-plan guards), `RunService` (in-memory mutex + DynamoDB apply lock), `RunRecordService` (DynamoDB persistence with S3 log offload), the `terraform.*` IPC controllers, and the `gsd.terraform.*` preload bridge — but the renderer contains **zero** `gsd.terraform` references. Operators still cannot plan, apply, review history, roll back, or destroy from the app, and stale UI copy (`edit-game-form.component.tsx`, `remove-game-button.component.tsx`) tells them to run `terraform apply` / `make tf-apply` in a terminal. Initiative #214 requires "plan/apply/destroy entirely from the UI"; this change delivers the operator-facing UI plus the three remaining backend gaps that block it.

## What Changes

- **New `/terraform` route (issue #110):** trigger `terraform plan` over IPC, watch the live ANSI log stream, review the resource-change summary, approve the plan, and run the plan-hash-gated apply — with a BUSY banner whenever the workspace or apply lock is held. The issue body's HTTP/SSE endpoint descriptions are stale; the UI targets the shipped IPC surface (`gsd.terraform.plan/approve/apply`, `gsd.terraform.runs.get/streamLogs`).
- **New `/terraform/history` route (issue #111):** table of past runs, newest-first, with kind/status filters and a read-only run-detail view. Requires a **new `listRuns` API** — `RunRecordStore.listRuns` (DynamoDB query, reusing the `RunPageResult` page shape already defined in `@hyveon/shared/runs.ts`), `RunRecordService.listRuns`, a `terraform.runs.list` IPC channel, and the preload bridge — plus a server-side log-URL resolution path for records whose logs were offloaded to S3.
- **Fix `AwsRemoteFileStore.listVersions()` pagination (issue #260):** loop on `IsTruncated`/`NextKeyMarker`/`NextVersionIdMarker` so keys with >1,000 versions return complete history. Rollback correctness depends on this.
- **Rollback flow (issue #112):** from an apply run in history, pick the prior tfvars S3 version, restore it as the new head, queue a plan tagged `rolledBackFrom: <applyRunId>` (new optional `RunRecord` field), then approve + apply through the normal gates. Errors clearly when the historic version has expired.
- **Destroy flow (issue #307):** expose the already-implemented `TerraformService.destroy()` via a self-bridged streaming `terraform.destroy` IPC channel + preload bridge, and a guarded type-to-confirm destroy UI backed by the fresh single-use confirmation-token gate (`DestroyNotConfirmedError`). Never `-auto-approve`.
- **Copy cleanup:** replace the stale `terraform apply` / `make tf-apply` instructions in the game-edit and game-remove flows with links to the new `/terraform` page.

## Capabilities

### New Capabilities

- `terraform-plan-apply-page`: the `/terraform` operator page — plan trigger, live ANSI log streaming, plan summary, approve gate, plan-hash-gated apply, BUSY/lock surfacing, and replacement of the stale CLI copy.
- `terraform-run-history`: the run-listing backend (`listRuns` store method, service method, IPC channel, preload bridge, log-URL resolution) and the `/terraform/history` page with filters and read-only run detail.
- `terraform-rollback`: complete S3 version listing (pagination fix), rollback initiation from history, the `rolledBackFrom` run tag, and the restore-then-plan-then-approve-then-apply flow.
- `terraform-destroy-flow`: the `terraform.destroy` IPC channel, preload bridge, confirmation-token minting, and the guarded type-to-confirm destroy UI with live logs and history visibility.

### Modified Capabilities

None — `openspec/specs/` is empty; every capability here is new.

## Impact

- `@hyveon/web`: new routes `/terraform` and `/terraform/history`, new components (plan/apply page, ANSI log viewer, history table, rollback + destroy dialogs), nav changes, copy changes in `edit-game-form.component.tsx` and `remove-game-button.component.tsx`, co-located Testing Library specs, Playwright page objects.
- `@hyveon/desktop-preload`: `gsd.terraform.runs.list`, `gsd.terraform.destroy` (+ token mint), typed mirrors in `gsd-api.ts`.
- `@hyveon/desktop-main`: `terraform.runs.list` handler in `TerraformRunsController`, log-URL resolution, `terraform.destroy` (+ mint) handlers in `TerraformController` (self-bridged streaming, `SELF_BRIDGED_PATTERNS` update in `ipc-main-bridge.ts`), `RunRecordService.listRuns`, `rolledBackFrom` plumbing through `TerraformService.plan` run-record persistence.
- `@hyveon/shared`: `RunRecordStore.listRuns` contract in `cloud.ts`, optional `RunRecord.rolledBackFrom` field in `runs.ts`.
- `@hyveon/cloud-aws`: `AwsRunRecordStore.listRuns` query, `AwsRemoteFileStore.listVersions` pagination fix.
- GitHub: closes #110, #111, #260, #112, #307, and epic #138 — one PR per issue.
