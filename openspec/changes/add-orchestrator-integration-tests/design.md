# Design — Orchestrator Integration Tests

## Context

Tier-2 integration specs (`app/packages/web/e2e/integration-specs/`) dispatch into the real `AppModule` DI container via the `ipc` harness (`e2e/fixtures/ipc-harness.ts`, `workers: 1`, serial). `TerraformService` resolves its binary with `which terraform` (`resolveBinaryPath`), then runs `terraform version -json` (`resolveVersion`), memoizing per instance. `app/test/fake-terraform.mjs` replays scripted stdout/stderr/exit-code fixtures keyed by subcommand (`FAKE_TERRAFORM_SCRIPT` env var) but currently ignores all flags — including `-out=` — and is wired into nothing. Config seams already exist: `TF_DIR` (composer dir), `RUNS_DIR_PATH` (run artifacts), `TF_STATE_PATH` (set by the harness). The apply approval gate lives in `TerraformController.apply` and reads plan records through `RunRecordService` → `RunRecordStore` (DynamoDB; table name from tfstate output `runs_table_name`, absent from `tfstate.fixture.json` today). This is a test-only change — no production behaviour changes.

## Goals / Non-Goals

**Goals:**

- Integration coverage for `TerraformService.plan/apply/destroy/output` per the delta spec: fake binary via PATH, stale-plan rejection, destroy confirmation gate, ANSI passthrough, run-record persistence.
- Reuse `fake-terraform.mjs` as the single scripted-terraform seam; keep it unit-tested.
- Keep specs deterministic and serial-safe (shared process env, `workers: 1`).

**Non-Goals:**

- No changes to `TerraformService`, controllers, or `ConfigService` production code.
- No real terraform, no real AWS, no S3 log-offload coverage (the >350KB offload path stays unit-test territory; integration asserts the inline path).
- No coverage of the tfvars S3 sync / `StalePlanError` tfvars-version check — the tfvars bucket stays unconfigured in the fixture so that guard is inert.

## Decisions

1. **PATH shim, not service patching.** A per-spec temp directory gets an executable `terraform` shell wrapper that `exec`s `node app/test/fake-terraform.mjs "$@"`; the fixture prepends it to `process.env.PATH` before building the harness. `resolveBinaryPath` shells out with the process env, and each spec builds a fresh app context (fresh memoization), so PATH prepending is a clean, zero-patch injection point. *Alternative rejected:* symlinking the `.mjs` directly (relies on shebang + exec bit surviving checkout) or stubbing `getBinaryPath` (bypasses the resolution code we want covered).
2. **Fixtures script a `version` entry.** `fake-terraform.mjs` looks up `argv[2]` in the fixture generically, so a `"version"` key emitting `{"terraform_version":"1.7.0"}` satisfies `resolveVersion` without code changes (the `KNOWN_SUBCOMMANDS` list is error-message-only).
3. **Extend `fake-terraform.mjs` with opt-in `-out=` artifact writing.** `plan()` hashes `<runsDir>/<runId>/<runId>.tfplan` after exit 0; today the fake never writes it, so every plan would fail with `TerraformPlanHashError`. Add an optional per-subcommand fixture field (e.g. `outFileContent`) that writes scripted bytes to the path given by the `-out=` argument, preserving backwards compatibility and extending its unit tests. *Alternative rejected:* writing the artifact from the shell shim — argument parsing in `sh` is fragile and untestable.
4. **Two exercise surfaces.** Apply-gate rejections and acks dispatch `TerraformController.apply` through `ipc.dispatch` with a minimal stub `{ evt }` context (as the controller unit tests do). Streaming assertions (plan chunks, ANSI, destroy) iterate `TerraformService`'s async generators directly; the harness gains a `get(token)` provider accessor so specs can resolve the container-built service. This keeps chunk assertions independent of Electron `webContents` emission, which doesn't exist in the plain-Node harness.
5. **Mock DynamoDB for run records, following `ecs-mock.ts`.** Add `runs_table_name` to `tfstate.fixture.json` and an `installRunRecordDynamoMock()` in `desktop-main/src/test-mocks/` (aws-sdk-client-mock on the DynamoDB client prototype, queues in `MockStore`) so the apply gate's `getByRunId` and `RunRecordService.persist` work in-process. Local `run.json` / `terraform.log` files remain the primary persistence assertions.
6. **Per-spec env hygiene.** Specs set `TF_DIR` (temp composer dir), `RUNS_DIR_PATH` (temp runs dir), `FAKE_TERRAFORM_SCRIPT`, and the PATH prepend inside a fixture that restores prior values and removes temp dirs on teardown. Safe because the integration project is `workers: 1`, `fullyParallel: false`.

## Risks / Trade-offs

- [Env/PATH mutation leaking across specs] → single fixture owns set/restore in setup/teardown; serial workers make mutation windows non-overlapping.
- [Fake-terraform drift from real terraform CLI behaviour] → keep the extension opt-in and minimal (write bytes to `-out=`), covered by `fake-terraform.test.ts`; fixtures assert only behaviour `TerraformService` depends on.
- [Approval-window (15 min) time sensitivity] → craft `approvedAt` timestamps relative to `Date.now()` (fresh vs. `now - 16 min`) instead of fake timers, which don't reach the child process.
- [DynamoDB mock diverging from `AwsRunRecordStore` request shapes] → mirror the proven `ecs-mock.ts` prototype-mock pattern and assert through observable results (gate outcomes, retrievable records), not raw request payloads.
