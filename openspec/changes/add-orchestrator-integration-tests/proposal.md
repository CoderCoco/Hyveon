# Add Orchestrator Integration Tests

## Why

`TerraformService` (plan/apply/destroy/output) is the highest-risk orchestration surface in the desktop app — it shells out to a real binary, gates destructive operations behind hashes and confirmation tokens, and persists run history — yet it has **zero tier-2 integration coverage**. The scripted terraform stand-in built for exactly this purpose (`app/test/fake-terraform.mjs`) exists and is unit-tested, but is referenced nowhere outside its own test. Issue #204 is the last open child of epic #140; closing it completes the test-migration epic.

## What Changes

- New integration specs under `app/packages/web/e2e/integration-specs/` exercising `TerraformService.plan`, `apply`, `destroy`, and `output` through the real `AppModule` Nest DI container (the existing `ipc` harness), with `fake-terraform.mjs` resolved as the `terraform` binary via a PATH shim — no real terraform, no real AWS.
- Coverage of the four mandated behaviours at minimum: stale-plan rejection (planHash mismatch, unapproved and expired approvals), the destroy confirmation-token gate (`DestroyNotConfirmedError`), ANSI passthrough in streamed run chunks, and run-record persistence (`<runsDir>/<runId>/run.json` + `RunRecordService`).
- Test-infrastructure additions to make that possible: an opt-in `-out=` artifact-writing extension to `fake-terraform.mjs` (so `plan()`'s SHA-256 `planHash` has a real `.tfplan` to hash), a PATH-shim fixture, a DynamoDB run-record mock following the existing `ecs-mock.ts` pattern, a `runs_table_name` output in `tfstate.fixture.json`, and a provider accessor on the `ipc` harness.
- Documentation update to `docs/docs/components/integration-tests.md` describing the new orchestrator tier wiring.

No production code changes — `TerraformService`, its controllers, and `ConfigService` are exercised as-is through their existing env-var seams (`TF_DIR`, `RUNS_DIR_PATH`, `TF_STATE_PATH`, `FAKE_TERRAFORM_SCRIPT`).

## Capabilities

### New Capabilities

- `orchestrator-integration-coverage`: tier-2 integration test coverage for the Terraform orchestrator — fake-binary injection via PATH, plan artifact/hash production, apply's stale-plan and approval gates, destroy's confirmation gate, ANSI-preserving streaming, and run-record persistence.

### Modified Capabilities

_None — this change adds test coverage and test fixtures only; no existing spec-level behaviour changes._

## Impact

- **Test code**: new specs in `app/packages/web/e2e/integration-specs/`; fixture additions in `app/packages/web/e2e/fixtures/` (PATH shim helper, harness accessor, `tfstate.fixture.json` output); new DynamoDB mock in `app/packages/desktop-main/src/test-mocks/`; extension + tests for `app/test/fake-terraform.mjs`.
- **Docs**: `docs/docs/components/integration-tests.md`.
- **CI**: `npm run app:test:integration` gains specs; still `workers: 1`, no new external dependencies.
- **Issues**: closes #204 and completes epic #140.
