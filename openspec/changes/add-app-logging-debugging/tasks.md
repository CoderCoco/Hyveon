## 1. Console forwarding — IPC surface (Group 1 PR: `logging-1-console-forwarding`)

- [x] 1.1 Add a new `diagnostics.reportLog` payload type (`ReportRendererLogBatchInput`: `{ entries: RendererLogEntry[], droppedCount?: number }`, `RendererLogEntry`: `{ level: 'log' | 'info' | 'warn' | 'error', message: string }`) in `diagnostics.controller.ts` — the existing `diagnostics.reportError`/`ReportRendererErrorInput` are left unchanged, per `design.md` Decision 1
- [x] 1.2 Add the `diagnostics.reportLog` `@MessagePattern` handler with the required entry `logger.debug` line, accepting a batch of entries in one call
- [x] 1.3 Add `DiagnosticsService.logRendererConsoleBatch(entries, droppedCount?)` to write forwarded console entries into the same winston log file as `renderer console (${level}): ${message}` (level mapped `log→debug`/`info→info`/`warn→warn`/`error→error`), distinguishable from the existing crash-only `renderer error (${source}): ${message}` lines; dropped entries are reported as one combined `renderer console: ${n} entries dropped (queue capacity exceeded)` warning per flush
- [x] 1.4 Never log secret values or raw IPC payload contents from forwarded console entries, per `.claude/rules/logging.md` — this mechanism provides no automatic sanitization; callers remain responsible
- [x] 1.5 Unit tests: successful forward, batch write, and no-crash-on-malformed-entry

## 2. Console forwarding — preload bridge (Group 1 PR, same as above)

- [x] 2.1 Add `reportLog(entries, droppedCount?)` to `HyveonDiagnosticsApi` in `hyveon-api.ts`, alongside the existing `tail`/`path`/`reportError`
- [x] 2.2 Add the `reportLog` `invoke('diagnostics.reportLog', { entries, droppedCount })` call in `preload.ts`'s `diagnostics` object literal
- [x] 2.3 Confirm the new channel is covered by the generic `registerIpcMainBridges()` bridge (no self-bridging needed — this is a one-shot batch call, not a stream)

## 3. Console forwarding — renderer install (Group 1 PR, same as above)

- [x] 3.1 Implement `installConsoleForwarding()` in `report-renderer-error.utils.ts`: override `console.log`/`info`/`warn`/`error` to call through to the original method, then enqueue an entry
- [x] 3.2 Implement the batching queue with two independent caps: a `FLUSH_INTERVAL_MS`/`MAX_BATCH_ENTRIES` per-flush send cap (entries beyond it stay queued for the next flush — never dropped) and a separate `MAX_QUEUE_SIZE` pending-queue cap (the only point entries are actually dropped, reported as one combined "N entries dropped" marker per flush, not one line per entry)
- [x] 3.3 Reuse the existing no-op-when-no-bridge guard pattern (`typeof window.hyveon?.diagnostics?... !== 'function'`) so the override is safe with no Electron bridge present
- [x] 3.4 Wire `installConsoleForwarding()` alongside `installGlobalErrorReporting()` in `main.tsx`
- [x] 3.5 Unit tests (Vitest + jsdom): override forwards to IPC, original console behavior preserved, per-flush-cap retention across multiple flushes, queue-cap drop-and-report, no-op without a bridge

## 4. Service-layer diagnostic logging sweep (Group 2 PR: `logging-2-service-layer-sweep`)

- [ ] 4.1 `AuditService.ts` — entry `logger.debug` + failure logging on AWS SDK calls
- [ ] 4.2 `AwsProfileService.ts` — same
- [ ] 4.3 `ConfigService.ts` — same
- [ ] 4.4 `CostService.ts` — same
- [ ] 4.5 `DiagnosticsService.ts` — same (excluding the Group-1-added forwarding method, which already gets its own entry log in Group 1)
- [ ] 4.6 `DiscordCommandRegistrar.ts` — same
- [ ] 4.7 `DiscordConfigService.ts` — same
- [ ] 4.8 `DriftService.ts` — same
- [ ] 4.9 `EcsService.ts` — same
- [ ] 4.10 `GamesWriteService.ts` — same
- [ ] 4.11 `GuidedIamService.ts` — same (already follows the modeled-result pattern in places; confirm every AWS-calling method has entry debug logging, fill gaps only)
- [ ] 4.12 `IamCheckService.ts` — same
- [ ] 4.13 `LogsService.ts` — same
- [ ] 4.14 `PulumiCancellation.ts` — same
- [ ] 4.15 `PulumiCredentialResolver.ts` — same
- [ ] 4.16 `PulumiEngineService.ts` — same
- [ ] 4.17 `PulumiLeakedPromise.ts` — same
- [ ] 4.18 `PulumiLockRecovery.ts` — same
- [ ] 4.19 `PulumiService.ts` — same
- [ ] 4.20 `RunRecordService.ts` — same
- [ ] 4.21 `RunService.ts` — same
- [ ] 4.22 `SafeStorageService.ts` — same
- [ ] 4.23 `awsCredentialSource.ts` — same
- [ ] 4.24 `verifyAccessKeyWithRetry.ts` — same
- [ ] 4.25 Confirm `mergeGameLists.ts` and `sleep.ts` are deliberately left untouched (pure helpers, no failure mode) — no task needed, just verify no debug lines were added there
- [ ] 4.26 Unit tests: for each file touched, at least one test asserting a failure path logs via `logger.warn`/`logger.error` rather than letting a raw error escape (extend existing test files; do not create parallel logging-only test suites)

## 5. Diagnostics panel UX (Group 3 PR: `logging-3-diagnostics-panel-ux`)

- [ ] 5.1 Add pause/resume state to `DiagnosticsPanel.tsx`: polling continues in the background; while paused, each poll response updates only an internal "latest fetched" reference, not the rendered view; on resume, the view is replaced with that latest snapshot in one step (never appended poll-by-poll, since `diagnostics.tail` returns a cumulative snapshot, not a delta — appending would duplicate/misorder lines)
- [ ] 5.2 Add level classification (reuse the regex classification `/logs`'s `ansi-log-viewer.component.tsx` already applies) and level-filter toggles (INFO/WARN/ERROR/DEBUG)
- [ ] 5.3 Add substring search with match highlighting, no regex support, matching `/logs`'s existing scope
- [ ] 5.4 Preserve today's autoscroll-to-bottom-on-update behavior, but only while not paused — a paused view must not autoscroll out from under the operator
- [ ] 5.5 Component tests (Vitest + jsdom): pause freezes the view, resume swaps to the latest snapshot with no duplicated/reordered lines across several paused poll cycles, level filter narrows the visible set, search highlights matches without removing non-matching lines, autoscroll follows updates when not paused and is inert while paused

## 6. Documentation (Group 4 PR: `logging-4-docs`, per pr-stacking.md's sanctioned "docs land once the flow is verifiable end-to-end" exception)

- [ ] 6.1 Update `docs/docs/components/management-app.md` — document renderer console forwarding via the new `diagnostics.reportLog` channel, and the service-layer logging convention now covering the service layer, not just controllers
- [ ] 6.2 Update `docs/docs/app/settings.md`'s Diagnostics panel section — document pause/filter/search/autoscroll
- [ ] 6.3 Confirm no other `docs/docs/**` page describes the old crash-only-forwarding or bare-scrolling-panel behavior in a way that now reads as stale

## 7. Verification (run before opening each PR in the stack, per `CLAUDE.md`)

- [ ] 7.1 `npm run app:lint` clean
- [ ] 7.2 `npm run app:typecheck` clean
- [ ] 7.3 `npm run app:test` green
- [ ] 7.4 `npm run app:test:integration` green (Group 1 and Group 4 touch controllers/services)
- [ ] 7.5 `npm run app:test:e2e` — the `chromium` project MUST pass; the `electron` project's known pre-existing failures (verified identical against an unmodified `main` baseline — see PR #453) are accepted only when they still match that baseline exactly, never as a blanket pass
