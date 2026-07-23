# Tasks — Add Orchestrator Integration Tests

## 1. Branch setup

- [ ] 1.1 Create the worktree and branch: `git worktree add .worktrees/claude/issue-204-orchestrator-integration -b claude/issue-204-orchestrator-integration`
- [ ] 1.2 Run `npm install` and `npm run app:build` in the worktree so `@hyveon/desktop-main/dist` exists for the `ipc` harness deep imports

## 2. Fake-terraform and fixture infrastructure

- [ ] 2.1 Extend `app/test/fake-terraform.mjs` with an opt-in per-subcommand `outFileContent` fixture field that writes scripted bytes to the path supplied via the `-out=` CLI argument (backwards compatible; existing fixtures unaffected); document the field in the file-header TSDoc
- [ ] 2.2 Extend `app/test/fake-terraform.test.ts` with "should ..." cases covering the new `-out=` writing (written bytes, no-op when field absent, error path when `-out=` missing but field present); TSDoc any new test helpers
- [ ] 2.3 Add a PATH-shim fixture helper in `app/packages/web/e2e/fixtures/` that creates a temp dir with an executable `terraform` wrapper exec-ing `node app/test/fake-terraform.mjs "$@"`, prepends it to `process.env.PATH`, sets `FAKE_TERRAFORM_SCRIPT`/`TF_DIR`/`RUNS_DIR_PATH` to per-spec temp locations, and restores all prior env values and removes temp dirs on teardown (TSDoc the helper; no raw `process.env` outside the fixture seam)
- [ ] 2.4 Add `runs_table_name` to `app/packages/web/e2e/fixtures/tfstate.fixture.json` outputs
- [ ] 2.5 Add `installRunRecordDynamoMock()` in `app/packages/desktop-main/src/test-mocks/` following the `ecs-mock.ts` prototype-mock pattern (aws-sdk-client-mock + `MockStore` queues) so `RunRecordStore.getByRunId`/`putRecord` work in-process; wire it into `createIpcHarness()` alongside `installEcsMock()`
- [ ] 2.6 Add a `get(token)` provider accessor to `IpcHarness` (`e2e/fixtures/ipc-harness.ts`) so specs can resolve `TerraformService` from the built container; update the harness TSDoc
- [ ] 2.7 Create scripted fixture JSON(s) for the specs — every fixture includes a `version` entry emitting `{"terraform_version":"..."}`; plan fixtures use `outFileContent`; ANSI fixtures interleave stdout/stderr lines containing escape sequences

## 3. Integration specs

- [ ] 3.1 `terraform-plan.spec.ts` — successful plan produces the `.tfplan` artifact and a SHA-256 `planHash` matching the artifact bytes; failed (non-zero exit) plan yields a failed outcome with no `planHash`; binary/version resolution succeeds through the PATH shim (test names read "should ...")
- [ ] 3.2 `terraform-apply.spec.ts` — dispatch `TerraformController.apply` with a stub `{ evt }` context: rejected when unapproved, when `approvedAt` exceeds the 15-minute window, and when `planHash` mismatches the approved record (fake terraform never spawned for `apply` in all three); `{ started: true }` and scripted apply runs for a fresh matching approval
- [ ] 3.3 `terraform-destroy.spec.ts` — `destroy()` without a token throws `DestroyNotConfirmedError`; a consumed token cannot be reused; a fresh token streams the scripted destroy to completion
- [ ] 3.4 `terraform-streaming.spec.ts` — ANSI escape sequences and stdout/stderr attribution preserved byte-for-byte in streamed chunks and in the persisted `<runsDir>/<runId>/terraform.log`
- [ ] 3.5 `terraform-run-records.spec.ts` — `run.json` written per run (`kind`, `exitCode`, `planHash` for successful plans; non-zero exit still persisted without `planHash`); mocked `RunRecordStore` record embeds the inline log (no offload key) and the run is retrievable via the runs IPC surface
- [ ] 3.6 `terraform-output.spec.ts` — `TerraformController.output` returns parsed outputs from the scripted `output -json` response
- [ ] 3.7 TSDoc all new spec-file helpers/fixtures; import `{ test, expect }` from `./index.js`, include `serverMocks` in test parameters, and confirm no raw `process.env` access outside the fixture seam

## 4. Documentation

- [ ] 4.1 Update `docs/docs/components/integration-tests.md` — document the PATH-shim injection, the `outFileContent` fake-terraform extension, the run-record DynamoDB mock, the harness `get()` accessor, and the new orchestrator specs

## 5. Verification and PR

- [ ] 5.1 `npm run app:test` passes
- [ ] 5.2 `npm run app:lint` passes
- [ ] 5.3 `npm run app:test:integration` passes
- [ ] 5.4 Open PR via `/pr` with a Conventional Commits title (e.g. `test(integration): cover TerraformService via fake-terraform`, <70 chars); PR body FIRST line `Closes #204`, next line `Closes #140` (this PR completes epic #140 — the epic closing keyword must be present)
