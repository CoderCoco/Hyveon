## ADDED Requirements

### Requirement: Renderer console forwarding to the main-process log

The renderer SHALL forward `console.log`, `console.info`, `console.warn`,
and `console.error` calls to the main-process winston log file via a
dedicated `diagnostics.reportLog` IPC channel, in addition to the existing
uncaught-error/unhandled-rejection/error-boundary reporting on
`diagnostics.reportError` (which this requirement leaves unchanged).
Forwarding MUST NOT replace or suppress the original `console.*` output in
DevTools. Each batch entry carries only `{ level, message }` — there is no
per-entry source discriminant; the channel a batch arrives on is what
identifies it as console-originated. Entries are mapped to winston levels
as `log → debug`, `info → info`, `warn → warn`, `error → error`, and
written as `renderer console (${level}): ${message}`, distinguishable from
the existing crash-only `renderer error (${source}): ${message}` lines.

Forwarded entries MUST be queued client-side and flushed every 2,000 ms,
bounded by two independent caps: a per-flush send cap of 50 entries that
limits how many entries one `diagnostics.reportLog` call carries, and a
pending-queue cap of 200 entries that bounds how many entries may be
buffered awaiting a flush. Entries beyond the 50-entry per-flush send cap
MUST NOT be dropped — they remain queued and are sent on a subsequent
flush. Only entries that arrive once the 200-entry pending-queue cap is
already full MAY be dropped, and when that happens the app MUST emit a
single, explicit "N entries dropped (queue capacity exceeded)" marker per
flush rather than silently discarding them or emitting one marker line per
dropped entry. This mechanism provides no automatic sanitization or
redaction of console argument values — callers remain responsible for not
logging secrets, per `.claude/rules/logging.md`, the same discipline
already required of every other logged value in this codebase.

#### Scenario: A console.log call reaches the app log

- **WHEN** app code calls `console.log('some diagnostic message')` in the
  renderer
- **THEN** the message appears in `main-*.log` as
  `renderer console (log): some diagnostic message`, at debug level,
  within the flush interval

#### Scenario: DevTools output is unaffected

- **WHEN** console forwarding is active
- **THEN** the same message still appears in the browser/Electron DevTools
  console exactly as it would without forwarding installed

#### Scenario: A burst within the queue cap is delivered in full, not dropped

- **WHEN** app code logs more entries in one flush window than the
  per-flush send cap, but fewer than the pending-queue cap
- **THEN** every entry is eventually forwarded across however many flushes
  it takes, and no "entries dropped" marker is emitted

#### Scenario: Entries beyond the queue cap are dropped and reported

- **WHEN** app code logs more entries than the pending-queue cap can hold
  before a flush drains it
- **THEN** only the entries beyond the queue cap are dropped, and the log
  file shows a single explicit marker stating how many were dropped

#### Scenario: No bridge available

- **WHEN** the renderer runs outside Electron (no `window.hyveon` bridge,
  e.g. the Playwright `chromium` E2E project)
- **THEN** console forwarding is a silent no-op and does not throw or break
  the surrounding code

### Requirement: Service-layer diagnostic logging coverage

Every method in `app/packages/desktop-main/src/services/*.ts` that invokes
an AWS SDK operation or the Pulumi engine SHALL log entry via
`logger.debug` (method name only, never payload contents) and SHALL log any
failure via `logger.warn` or `logger.error` before returning a modeled
result or rethrowing a plain `Error`, matching the pattern already
established by `GuidedIamService`/`AwsProfileService`/`IamCheckService` and
required of IPC handlers by `.claude/rules/logging.md`. No raw AWS SDK or
Node error object may propagate out of a service method uncaught. Pure
helper functions with no external call and no possible failure mode (e.g.
`sleep.ts`, `mergeGameLists.ts`) are exempt.

#### Scenario: A service method's external call fails

- **WHEN** a service method's AWS SDK or Pulumi call throws
- **THEN** the failure is logged via `logger.warn` or `logger.error` with
  the underlying error message before the method returns a modeled failure
  result or rethrows a plain `Error`

#### Scenario: A service method's external call succeeds

- **WHEN** a service method that calls an AWS SDK operation or the Pulumi
  engine is invoked
- **THEN** a `logger.debug` entry line is written identifying the method,
  without logging its payload or arguments

### Requirement: Diagnostics panel pause, level filter, search, and autoscroll

The Settings → Diagnostics panel (`DiagnosticsPanel.tsx`) SHALL support
pausing the displayed log view while polling continues in the background,
filtering displayed lines by level (INFO/WARN/ERROR/DEBUG), searching
displayed lines by substring with match highlighting, and autoscrolling to
the bottom on update — matching the interaction patterns already available
on the `/logs` page's `ansi-log-viewer.component.tsx`, and preserving the
autoscroll-on-update behavior `DiagnosticsPanel.tsx` already has today.

`diagnostics.tail` returns the current cumulative tail (the last N lines as
of that call), not an incremental delta — unlike `/logs`'s CloudWatch-backed
stream, there is no line-identity or sequence number to key an append on.
Pausing therefore MUST NOT stop the underlying poll, but MUST stop the
*displayed* lines from changing: each poll response while paused SHALL
update only an internal "latest fetched" reference, not the rendered view.
On resume, the view SHALL be replaced with that latest fetched snapshot in
one step — never by appending successive poll responses to each other,
which would duplicate or misorder lines given the snapshot (not delta)
shape of `diagnostics.tail`'s response. Autoscroll-to-bottom applies only
when the view is not paused; a paused view MUST NOT autoscroll out from
under an operator reading it.

#### Scenario: Pausing freezes the view

- **WHEN** the operator pauses the Diagnostics panel while new log lines
  are being written
- **THEN** the displayed lines do not change until the operator resumes,
  even though polling continues in the background

#### Scenario: Resuming shows the latest snapshot

- **WHEN** the operator resumes after pausing through several poll cycles
- **THEN** the view updates once to the most recently fetched
  `diagnostics.tail` snapshot, with no duplicated or reordered lines from
  the intermediate polls that occurred while paused

#### Scenario: Filtering by level

- **WHEN** the operator enables the ERROR-only filter
- **THEN** only lines classified as ERROR are shown, using the same
  classification logic `/logs` already applies

#### Scenario: Searching highlights matches

- **WHEN** the operator types a search term
- **THEN** matching substrings are highlighted in the visible lines,
  without removing non-matching lines from view

#### Scenario: Autoscroll follows new lines while not paused

- **WHEN** the panel is not paused and a poll returns a newer snapshot
- **THEN** the view scrolls to the bottom, matching today's
  `DiagnosticsPanel.tsx` behavior

#### Scenario: Autoscroll does not fight a paused view

- **WHEN** the panel is paused
- **THEN** the view does not scroll, even though polling continues in the
  background
