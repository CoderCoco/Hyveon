## Why

Debugging operator-reported issues today means relying on the winston log file
(`userData/logs/main-*.log`) as the only record of what happened, per
`.claude/rules/logging.md` — this app has no HTTP request/response cycle and
no exception filter to fall back on. That record has two real gaps.

First, it is incomplete on the renderer side. `installGlobalErrorReporting()`
(`app/packages/web/src/lib/report-renderer-error.utils.ts`) already forwards
*uncaught* errors — `window.onerror`, `unhandledrejection`, and the React
`ErrorBoundary`'s `componentDidCatch` — through the `diagnostics.reportError`
IPC channel into `DiagnosticsService.logRendererError()`, landing in the same
log file. But ordinary `console.log`/`console.info`/`console.warn`/
`console.error` calls made by app code — the kind used to narrate "this is
what the UI thinks is happening" while chasing a bug — go nowhere but
DevTools. When an operator reports something like "the wizard hung" without
DevTools open, that narration is lost entirely, the same gap the guided-IAM
wizard incident (PR #436) surfaced on the main-process side before
`.claude/rules/logging.md` existed.

Second, it is incomplete on the main-process side. `.claude/rules/logging.md`
already guarantees every IPC controller handler logs on entry — confirmed
100% compliant across all 65 `@MessagePattern` handlers in
`app/packages/desktop-main/src/controllers/`. But the rule's other half —
"every service method that can fail in a way the operator needs to
understand logs the failure" — is unevenly applied below the controller
layer: only 8 of 34 files under
`app/packages/desktop-main/src/services/*.ts` contain any `logger.debug`
call at all, despite that layer being where the actual AWS SDK and Pulumi
calls happen.

Third, the one UI surface built specifically to let an operator read the
app's own log without SSH access — Settings → Diagnostics
(`DiagnosticsPanel.tsx`) — is a bare auto-scrolling `<div>` with no pause,
level filter, or search, unlike the more capable `/logs` (CloudWatch) page
operators already use for game-server logs.

## What Changes

### Renderer console/log forwarding

- Install a `console.*` override in the renderer (alongside, not replacing,
  the existing uncaught-error/rejection/boundary reporting) that forwards
  `log`/`info`/`warn`/`error` calls to the main-process log via IPC, batched
  and throttled so console chatter cannot flood the winston log file or the
  IPC channel.
- Add a new sibling `diagnostics.reportLog` IPC channel (the existing
  `diagnostics.reportError` channel and its crash-only payload are left
  untouched) so forwarded console calls land in `main-*.log` as
  `renderer console (${level}): ${message}` lines, distinct from the
  existing crash-only `renderer error (${source}): ${message}` shape.
- Console argument forwarding relies on **caller discipline, not
  automatic redaction** — this change does not sanitize or scan console
  arguments for secret-shaped values. App code is expected to already
  follow `.claude/rules/logging.md`'s no-secrets rule for anything it
  logs, the same discipline already required of every other logged value
  in this codebase; forwarding does not add a new exemption or a new
  guarantee beyond that.

### Service-layer debug logging sweep

- Extend `.claude/rules/logging.md` service-method coverage into the
  services that currently have none: every method in
  `app/packages/desktop-main/src/services/*.ts` that calls an AWS SDK
  operation or invokes the Pulumi engine gets a `logger.debug` on entry
  and a `logger.warn`/`logger.error` on the failure path it doesn't
  already have, mirroring the modeled-result pattern already used in
  `GuidedIamService`/`AwsProfileService`/`IamCheckService`.
- Trivial pure-function helpers (e.g. `sleep.ts`, `mergeGameLists.ts`) are
  explicitly out of scope — they cannot fail in a way that needs a log line.
- No new winston level: use the existing `debug` (normal diagnostic detail)
  and `silly` (very verbose/hot-path detail, currently configured but
  unused) levels rather than adding a custom `trace` level, since winston's
  default levels object already covers this without touching `logger.ts`'s
  transport/level configuration.

### Diagnostics panel parity

- Bring `DiagnosticsPanel.tsx` (Settings → Diagnostics) to functional parity
  with the level-filter, search-highlight, pause/resume, and autoscroll
  affordances the `/logs` page's `ansi-log-viewer.component.tsx` already
  has, so the app's own log is as usable as the CloudWatch log view.

### Explicitly out of scope

- **A custom winston `trace` level.** Decided with the user: use
  `debug`/`silly` as they exist today.
- **Changing IPC controller entry-logging.** Already 100% compliant per
  `.claude/rules/logging.md`; this change touches only the service layer.
- **Forwarding renderer console output from a plain browser context** (the
  Playwright `chromium` E2E project, which runs the app outside Electron).
  `reportRendererError`'s existing no-op-when-no-bridge guard is reused
  as-is for the new console override.
- **A structured/queryable log format** (e.g. JSON-lines search index,
  external log aggregation). Out of scope; this stays within the existing
  winston file + tail-based reading model.

## Capabilities

### New Capabilities

- `app-diagnostics-logging`: renderer console/log forwarding to the
  main-process log, service-layer diagnostic logging coverage, and the
  Diagnostics panel's pause/filter/search UX.

### Modified Capabilities

None — no existing `openspec/specs/` capability describes logging or
diagnostics today; this is net-new.

## Impact

**Code**

- `app/packages/web/src/lib/report-renderer-error.utils.ts` — new
  `installConsoleForwarding()` (or equivalent), batching/throttling logic.
- `app/packages/web/src/main.tsx` — wire the new installer alongside
  `installGlobalErrorReporting()`.
- `app/packages/web/src/components/DiagnosticsPanel.tsx` — pause, level
  filter, search.
- `app/packages/desktop-main/src/controllers/diagnostics.controller.ts` —
  extended/new `@MessagePattern` handler for forwarded console entries.
- `app/packages/desktop-main/src/services/DiagnosticsService.ts` — extended
  logging method, batched-write handling.
- `app/packages/desktop-preload/src/preload.ts` +
  `app/packages/desktop-preload/src/hyveon-api.ts` — bridge surface for the
  new/extended channel.
- `app/packages/desktop-main/src/services/*.ts` — `logger.debug`/`warn`
  additions across the services identified in `design.md`'s coverage table.

**Dependencies**

- No new runtime dependencies expected.

**Security**

- Console forwarding provides no automatic sanitization of forwarded
  console arguments — it relies on the same caller discipline
  `.claude/rules/logging.md` already requires of every other logged
  value, not a new redaction guarantee. It does not introduce a new
  exposure: the forwarded content already existed in DevTools output
  today, unforwarded; this change routes it into a local log file the
  operator already controls, not a new external destination.

**Documentation**

- `docs/docs/components/management-app.md` (logging/diagnostics section),
  `docs/docs/app/settings.md` (Diagnostics panel section).

**Delivery**

- Per `.claude/rules/pr-stacking.md`, this ships as a stack of PRs rather
  than one: console forwarding, service-layer sweep, and Diagnostics panel
  UX are independent groups with no cross-dependency other than all
  building on `main`. See `design.md`'s Migration Plan and `tasks.md` for
  the grouping.
