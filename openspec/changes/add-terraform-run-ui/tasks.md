# Tasks: Terraform Run UI

One task group per GitHub issue; each group is one PR. Order matters: 1 → 2 → 3 → 4 → 5 (group 4 depends on groups 2 and 3). Follow repo test conventions throughout: `it('should …')` test names, TSDoc on non-trivial functions, no raw `process.env` in business logic, vitest with co-located `.test.ts(x)` files, React component tests via Testing Library under jsdom.

## 1. Issue #110 — Plan/Apply page (`/terraform`)

- [x] 1.1 Create the worktree/branch: `git worktree add .worktrees/claude/issue-110-terraform-plan-apply-page -b claude/issue-110-terraform-plan-apply-page`
- [x] 1.2 Build the `AnsiLogViewer` component in `@hyveon/web` (ANSI→HTML rendering of `TerraformRunChunk`s, ordered append, auto-scroll with pause-on-scroll-up) + co-located jsdom unit tests
- [x] 1.3 Build the `/terraform` page: Plan trigger calling `gsd.terraform.plan()`, transition to a run view on `{ started: true, runId }`, attach `gsd.terraform.runs.streamLogs(runId)` for live output
- [x] 1.4 Render the plan result: add/change/destroy summary on plan end, full log expandable, run status via `gsd.terraform.runs.get` (`awaiting_approval` handling)
- [x] 1.5 Implement the Approve gate (`gsd.terraform.approve({ planRunId })`, show `approvedBy`/`approvedAt`, approval-window staleness hint) and the plan-hash-gated Apply (`gsd.terraform.apply({ planRunId, planHash })`, success banner + dashboard link)
- [x] 1.6 Surface BUSY: render a lock banner from any `{ started: false, conflict }` ack (plan and apply), naming the in-flight subcommand; surface non-conflict `error` text inline
- [x] 1.7 Register the `/terraform` route in `app.component.tsx` and add the nav entry; replace the stale `terraform apply` / `make tf-apply` copy in `edit-game-form.component.tsx` and `remove-game-button.component.tsx` with links to `/terraform`
- [x] 1.8 Add routed-page tests via `renderPage()` with a mocked `gsd` bridge (plan happy path, BUSY banner, approve→apply enablement, expired-approval error) and a Playwright page object for the new route
- [x] 1.9 Run `npm run app:test` and `npm run app:lint` — both must pass
- [x] 1.10 Open PR via the `/pr` command with a Conventional Commits title (`feat(web): terraform plan/apply page with live log stream`, <70 chars); PR body's FIRST line must be `Closes #110`

## 2. Issue #111 — Run listing API + Apply-history view (`/terraform/history`)

- [x] 2.1 Create the worktree/branch: `git worktree add .worktrees/claude/issue-111-apply-history -b claude/issue-111-apply-history`
- [x] 2.2 Add `listRuns` to the `RunRecordStore` contract in `@hyveon/shared/cloud.ts` (limit + `before` cursor + optional status filter, resolving the existing `RunPageResult` shape from `runs.ts`) with TSDoc
- [x] 2.3 Implement `AwsRunRecordStore.listRuns`: base-table `Query` on `pk = "RUN"` descending for unfiltered pages, `status-index` GSI query for status-filtered pages; unit tests with `aws-sdk-client-mock` (pagination cursor, empty table, filter path)
- [x] 2.4 Add `RunRecordService.listRuns` (empty page when `runs_table_name` unconfigured, matching `getByRunId`) + unit tests
- [x] 2.5 Add the `terraform.runs.list` IPC channel to `TerraformRunsController` (plain invoke, payload validation) and a `terraform.runs.logUrl` plain-invoke channel resolving `RunRecordService.getLogUrl` for offloaded logs; controller unit tests
- [x] 2.6 Add the preload bridge `gsd.terraform.runs.list` / `gsd.terraform.runs.logUrl` in `preload.ts` + typed mirrors in `gsd-api.ts`
- [x] 2.7 Build the `/terraform/history` page: newest-first table (kind, status, timestamps, approver, `rolledBackFrom` tag when present), load-older via cursor, kind + status filters
- [x] 2.8 Build the read-only run-detail view reusing the run view components from group 1, with the log-source ladder: `streamLogs` replay → `logInline` → presigned URL fetch; no approve/apply controls on terminal runs
- [x] 2.9 Register the `/terraform/history` route + navigation from the Plan/Apply page; routed-page tests with a mocked `gsd` bridge (listing, filters, detail fallback ladder) and a Playwright page object
- [x] 2.10 Run `npm run app:test` and `npm run app:lint` — both must pass
- [x] 2.11 Open PR via the `/pr` command with a Conventional Commits title (`feat(web): apply-history view backed by runs listing API`, <70 chars); PR body's FIRST line must be `Closes #111`

## 3. Issue #260 — `AwsRemoteFileStore.listVersions()` pagination fix

- [ ] 3.1 Create the worktree/branch: `git worktree add .worktrees/claude/issue-260-listversions-pagination -b claude/issue-260-listversions-pagination`
- [ ] 3.2 Update `listVersions` in `app/packages/cloud-aws/src/AwsRemoteFileStore.ts` to loop while `IsTruncated`, passing `NextKeyMarker`/`NextVersionIdMarker` as `KeyMarker`/`VersionIdMarker`, accumulating all pages' `Versions` before the existing filter/sort
- [ ] 3.3 Extend `AwsRemoteFileStore.test.ts` with multi-page tests (`IsTruncated: true` page(s) then a final `IsTruncated: false` page; marker forwarding asserted; single-page behavior unchanged)
- [ ] 3.4 Run `npm run app:test` and `npm run app:lint` — both must pass
- [ ] 3.5 Open PR via the `/pr` command with a Conventional Commits title (`fix(cloud-aws): paginate listVersions past 1000 versions`, <70 chars); PR body's FIRST line must be `Closes #260`

## 4. Issue #112 — Rollback flow (depends on groups 2 and 3)

- [ ] 4.1 Create the worktree/branch: `git worktree add .worktrees/claude/issue-112-rollback-flow -b claude/issue-112-rollback-flow`
- [ ] 4.2 Add optional `rolledBackFrom?: string` to `RunRecord` in `@hyveon/shared/runs.ts` with TSDoc; plumb it through the `terraform.plan` IPC payload, `TerraformService.plan`, and run-record persistence (unit tests at each layer)
- [ ] 4.3 Implement the rollback backend path: resolve the tfvars version live before the target apply run (complete `listVersions` history), read its bytes (clear error naming the version when it no longer exists), write them as a new head via `TfvarsService`, and start a plan against the new `versionId` tagged `rolledBackFrom`
- [ ] 4.4 Add the "Rollback" action to apply rows in `/terraform/history` (hidden when no `tfvarsVersionId`), with a confirmation dialog identifying the target version and stating that the tfvars head will be rewritten before planning
- [ ] 4.5 Route the confirmed rollback into the group 1 run view so the tagged plan streams live and goes through the standard approve + apply gates unchanged
- [ ] 4.6 Display the `rolledBackFrom` tag on history rows and in run detail; surface the missing-version error without writing anything
- [ ] 4.7 Component/page tests: rollback action visibility, confirmation gating, tag rendering, missing-version error path
- [ ] 4.8 Run `npm run app:test` and `npm run app:lint` — both must pass
- [ ] 4.9 Open PR via the `/pr` command with a Conventional Commits title (`feat(web): rollback flow from apply history`, <70 chars); PR body's FIRST line must be `Closes #112`

## 5. Issue #307 — Destroy flow (last open child of epic #138)

- [ ] 5.1 Create the worktree/branch: `git worktree add .worktrees/claude/issue-307-destroy-flow -b claude/issue-307-destroy-flow`
- [ ] 5.2 Add a `terraform.destroy.mintToken` plain-invoke IPC channel on `TerraformController` delegating to `TerraformService.mintDestroyConfirmationToken()`
- [ ] 5.3 Add the self-bridged streaming `terraform.destroy` channel following `apply`'s pattern: workspace conflict ack, `RunService.createRun('destroy', …)` lock with post-await re-check and unconditional `releaseRun` in `finally`, synchronous first-`.next()` reservation, audit entry, chunk/end side channels tagged with the run id; register in `onModuleInit` and add the channel to `SELF_BRIDGED_PATTERNS` in `ipc-main-bridge.ts`
- [ ] 5.4 Controller unit tests: token-gate refusal (`DestroyNotConfirmedError` path spawns nothing and writes no record/audit), BUSY conflict ack, lock release on every exit path, destroy run visible via `terraform.runs.get`/history
- [ ] 5.5 Add the preload bridge (`gsd.terraform.destroy` async-iterable + token mint) in `preload.ts` honoring the test-mode mock registry, with typed mirrors in `gsd-api.ts`
- [ ] 5.6 Build the guarded destroy UI on `/terraform`: type-to-confirm dialog (exact phrase enables the destructive button, copy states all managed infrastructure is destroyed), mint token on confirm, stream output through `AnsiLogViewer`, BUSY surfaced like plan/apply
- [ ] 5.7 Component/page tests: phrase gating (button disabled on mismatch, no token minted), confirmed destroy streams and shows terminal state, fresh token required per attempt
- [ ] 5.8 Run `npm run app:test` and `npm run app:lint` — both must pass
- [ ] 5.9 Open PR via the `/pr` command with a Conventional Commits title (`feat(desktop): guarded terraform destroy IPC + UI`, <70 chars); PR body's FIRST line must be `Closes #307`, and — as this PR completes the last open issue of epic #138 — the body must also include `Closes #138` on its own line so the epic auto-closes
