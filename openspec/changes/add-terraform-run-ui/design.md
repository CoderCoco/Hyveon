# Design: Terraform Run UI

## Context

Epic #138's backend is complete: `TerraformService` (init/plan/apply/destroy/output as streaming async generators, SHA-256 planHash, stale-plan and stale-tfvars guards), `RunService` (in-memory mutex + DynamoDB apply lock, `RunLockHeldError`), `RunRecordService` (DynamoDB persistence with 350KB inline-vs-S3 log offload, `getByRunId`, `getLogUrl`, `approveRun`), IPC controllers (`terraform.init/plan/approve/apply/output`, `terraform.runs.get/logs`) and the `gsd.terraform.*` preload bridge. The renderer has zero `gsd.terraform` references — no UI exists for any of it.

Three backend gaps remain: no run-listing API (`RunRecordService` only has `getByRunId`; `RunPageResult` in `@hyveon/shared/runs.ts` was defined and explicitly deferred), no `terraform.destroy` IPC channel (the service method exists, gated by `mintDestroyConfirmationToken()` / `DestroyNotConfirmedError`, but is unreachable), and `AwsRemoteFileStore.listVersions()` fetches a single `ListObjectVersionsCommand` page (#260), which breaks rollback for keys with >1,000 versions.

Locked decisions from `docs/superpowers/specs/2026-05-10-electron-desktop-pivot-design.md` constrain this work: ANSI preserved end-to-end with renderer-side ANSI→HTML; plan → approve → apply with the same tfvarsHash and refusal of stale plans; concurrency refusals surface as BUSY; destroy requires fresh explicit confirmation, never `-auto-approve`; run records carry runId/kind/startedAt/completedAt/exitCode/tfvarsVersionId/logS3Key; `RunDetailStatus` includes `awaiting_approval`.

## Goals / Non-Goals

**Goals:**

- Ship the operator UI that closes epic #138: `/terraform` plan/approve/apply, `/terraform/history`, rollback, and guarded destroy — entirely over the shipped IPC surface.
- Fill the three backend gaps (listRuns, destroy channel, listVersions pagination) with minimal, pattern-following additions.
- Replace the stale `make tf-apply` copy so the app stops sending operators to a terminal.

**Non-Goals:**

- No changes to `TerraformService`'s process-spawning, hashing, locking, or persistence logic beyond plumbing `rolledBackFrom`.
- No HTTP/SSE endpoints — issue #110's body predates the Electron pivot; only IPC is targeted.
- No multi-user/remote access model; the initiator/approver remains the local OS user.
- No cancel-run UI (the controllers' `AbortController` maps anticipate it; out of scope here).
- No changes to the runs-table Terraform resources — the existing table + `status-index` GSI suffice.

## Decisions

1. **Renderer consumes run output via `gsd.terraform.runs.streamLogs(runId)`, not new per-op chunk bridges.** `TerraformService.streamRunOutput` already replays an in-flight run's buffered output and follows it live, and the preload bridge exists. The plan/apply/destroy pages call the mutating channel for the ack, then attach `streamLogs(ack.runId)` for output. Alternative — exposing `terraform.plan.chunk`/`terraform.apply.chunk` listeners in the preload — duplicates buffering logic the service already owns and loses the reattach-after-reload property.

2. **ANSI→HTML happens in a dedicated `AnsiLogViewer` React component.** A small, dependency-light converter (either a hand-rolled SGR-subset parser or a tiny vetted lib bundled locally — no CDN, per repo constraints) renders chunks into styled spans; auto-scroll with a pause-on-scroll-up affordance mirrors the existing logs page behavior. Main/preload never strip escapes (locked design decision).

3. **`listRuns` queries the base table partition for the unfiltered list and the `status-index` GSI for status filters.** All records share `pk = "RUN"` with `sk = <startedAt>#<runId>`, so `Query(pk = RUN, ScanIndexForward = false, Limit, ExclusiveStartKey from the `before` cursor)` yields newest-first pages across all statuses without a scan; a status filter switches to the GSI (hash = status, range = startedAt, descending). The result maps onto the pre-existing `RunPageResult` shape (`records`, `nextBefore`). Kind filtering is done client-side on the fetched page (kind is not indexed; run volume is tiny). Not-configured table resolves an empty page, matching `getByRunId`'s behavior.

4. **Run-detail log resolution ladder: local replay → `logInline` → presigned S3 URL.** History detail reuses the live run view's components. When `streamLogs` errors because local `<runsDir>/<runId>` artifacts are gone, the record's `logInline` is rendered directly; when the log was offloaded, a new plain-invoke `terraform.runs.logUrl` channel resolves `RunRecordService.getLogUrl(logS3Key)` server-side and the renderer fetches the presigned URL. The secret-free presigned URL is the only thing crossing the bridge.

5. **#260 fix loops on `IsTruncated` manually.** A `do/while` accumulating `Versions` and passing `NextKeyMarker`/`NextVersionIdMarker` as `KeyMarker`/`VersionIdMarker` keeps the diff small and mock-friendly with `aws-sdk-client-mock` (the SDK paginator works too, but the explicit loop matches the file's existing style and makes the multi-page unit tests direct). Filtering/sorting stays exactly as-is, applied after accumulation. Ships as its own PR before #112.

6. **Rollback = restore-as-new-head, then normal plan.** Rolling back apply run `R` resolves the tfvars version live before `R` from the complete `listVersions` history, reads that version's bytes, and writes them as a **new** head version through `TfvarsService` (history is append-only; never delete or revert S3 versions). The returned new `versionId` is passed to `gsd.terraform.plan`, so the existing stale-tfvars guard keeps working unchanged. A missing historic version fails the read step before any write. Alternative — planning directly against the historic version without restoring — would leave head and applied state divergent and break the stale-tfvars guard's invariant.

7. **`rolledBackFrom` is an optional `RunRecord` field plumbed through plan submission.** `@hyveon/shared/runs.ts` gains `rolledBackFrom?: string`; the `terraform.plan` payload accepts it, `TerraformService.plan` stamps it onto the persisted record, and history renders it as a tag. No new run kind — a rollback is an ordinary plan/apply pair with provenance.

8. **Destroy needs two channels: a plain-invoke token mint plus the streaming `terraform.destroy`.** The token gate lives in `TerraformService` (single-use, expiring, minted server-side), so the renderer must mint via IPC (`terraform.destroy.mintToken`, generic-bridged) and then submit `terraform.destroy` (self-bridged streaming, added to `SELF_BRIDGED_PATTERNS`) with `{ confirmationToken }`. The controller mirrors `apply`'s shape: workspace conflict check, `RunService.createRun('destroy', …)` lock acquisition with post-await re-check, synchronous first-`.next()` workspace reservation, audit entry, fire-and-forget streaming loop, unconditional `releaseRun` in `finally`. The type-to-confirm phrase is validated in the renderer before minting; the token is what the backend trusts.

9. **One PR per GitHub issue, in dependency order #110 → #111 → #260 → #112 → #307.** Each PR is independently shippable; #112 depends on #111 (history entry point) and #260 (complete versions). #307's PR is the last open child of epic #138 and additionally carries `Closes #138`.

## Risks / Trade-offs

- **[Approval expires (15 min) while the operator reads the plan]** → surface `approvedAt` and a visible countdown/staleness hint on the run view; the backend rejection already prompts re-approval, so worst case is one extra click.
- **[Kind filter is client-side only]** → with large histories a kind-filtered page can render fewer rows than the page size; acceptable at this project's run volume, and the cursor still pages correctly. Revisit with a GSI only if it ever matters.
- **[Log source divergence: local `run.json`/log vs DynamoDB record]** → the detail view treats local replay as best-effort and falls back through the persisted ladder (Decision 4), so a wiped `runsDir` degrades gracefully instead of erroring.
- **[Destroy is catastrophic if the gate regresses]** → the token gate stays in `TerraformService` (already tested), the controller adds unit tests for refused submissions, and the UI phrase check is defense-in-depth, never the only barrier.
- **[Restoring tfvars head then failing to plan leaves head changed]** → acceptable: the restore is itself a versioned, auditable write and the next plan picks it up; the confirmation dialog states that rollback rewrites the head before planning.
- **[Electron e2e flakiness for new page specs]** → new UI ships with jsdom component/page tests (renderPage helper, mocked `gsd`) per the repo's testing tiers; Electron-project e2e additions follow the Epic F seam (`window.gsd.__test.mock`) and stay minimal.

## Migration Plan

No infrastructure or data migration: the runs table, GSI, and secrets are already provisioned, and `rolledBackFrom` is an optional attribute (old records simply lack it). Each PR is additive and independently revertable; the stale-copy replacement lands with #110 and can be reverted without touching the new pages.

## Open Questions

- Exact confirmation phrase for destroy (e.g. the project name vs a fixed `destroy` literal) — decide during #307 implementation; the spec only requires an exact-match typed phrase.
- Whether the history table shows an initiator column: `RunRecord` has no initiator field today (only `RunLock` does). Deferred — adding it is a small shared-type change if wanted later, and the spec deliberately requires only fields that exist.
