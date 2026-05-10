# Electron Desktop Pivot — Design Spec

**Date:** 2026-05-10
**Status:** Draft, awaiting user review
**Owner:** @CoderCoco

## Goal

Convert game-server-deploy from a Nest+React web app (operator runs Docker, hand-runs `terraform apply`) into a single-binary cross-platform Electron desktop application that owns the full deploy lifecycle — config editing, plan/apply/destroy, log streaming — while keeping the existing AWS infrastructure intact and leaving room for non-AWS clouds in the future.

## Non-goals

- Bundling the `terraform` or `aws` (or future `gcloud`/`az`) CLI inside the app. The user installs them separately, the way they install Node today.
- Multi-user access to a single desktop install. The desktop UI is single-operator. Discord users — who *are* multi-user — keep their existing per-guild/per-user/per-role permissions enforced by `canRun()` and the followup Lambda.
- Implementing GCP or Azure providers. The architecture leaves seams for them; v1 ships AWS-only.
- Code signing and auto-update for v1. Releases ship unsigned with documented "right-click Open" / "More info → Run anyway" instructions. `electron-updater` is wired but disabled.
- Backwards compatibility with the Docker-compose deployment story. The pivot is full; the old story is dropped.

## Decisions (locked)

| Decision | Choice |
|---|---|
| Scope | Full pivot to desktop. S3 (or future cloud-native object store) is the remote source of truth for tfvars so a fresh install can re-sync. |
| Terraform model | Local CLI invoked from main process. Remote S3 backend (terraform state) + DynamoDB lock + versioned S3 tfvars bucket. |
| Nest ↔ renderer | Pattern B — IPC bridge via `nestjs-electron-ipc-transport`. No HTTP listener. SSE replaced by IPC streaming channels. |
| Cloud abstraction | Provider-interface seams in `@gsd/shared`. AWS-only impl in `@gsd/cloud-aws` for v1. Terraform splits into `terraform/aws/` with a top-level composer. |
| Discord bot | `DiscordEventReceiver` interface; AWS Lambda + DynamoDB impl is the v1 concrete. Multi-user permissions stack (`canRun`, admin roles, per-game gates) untouched. |
| Auth on desktop | None. IPC bridge is the trust boundary. `ApiTokenGuard` is removed. |
| Existing epics | #80, #81, #82 repurposed (numbers preserved, scope shifts to desktop main process). #83 closed; viable children moved into new Epic D. |
| Distribution | Win NSIS + macOS DMG + Linux AppImage from a CI matrix. Unsigned MVP. Auto-update infrastructure scaffolded but disabled. |

## Architecture

### Process model

```
┌──────────────────────────────────────────────────────────────┐
│ Electron application                                         │
│                                                              │
│  ┌────────────────────────┐      ┌────────────────────────┐  │
│  │ Main process           │      │ Renderer (BrowserWindow)│ │
│  │ ── Nest microservice   │      │ ── React + Vite         │ │
│  │   (IPC transport)      │◀─IPC▶│ ── window.gsd.* (preload)│ │
│  │ ── TerraformService    │      │                          │ │
│  │ ── FirstRunWizard      │      └────────────────────────┘  │
│  │ ── CloudProviderModule │                                  │
│  │   (AWS impls today)    │                                  │
│  │ ── Winston → userData/ │                                  │
│  └─────────┬──────────────┘                                  │
│            │                                                 │
│  ┌─────────▼─────────┐  spawn   ┌─────────────────────────┐  │
│  │ child_process     │─────────▶│ system terraform CLI    │  │
│  │ stream stdio      │          │ aws CLI (where used)    │  │
│  └───────────────────┘          └─────────────────────────┘  │
└──────────────────────────────────────────────────────────────┘
                │                              │
                ▼                              ▼
       ┌─────────────────┐            ┌────────────────────────┐
       │ AWS SDK calls   │            │ Remote AWS resources   │
       │ (ECS, CWLogs,   │            │ S3 state, S3 tfvars,   │
       │  Cost Explorer, │            │ DynamoDB lock + runs + │
       │  Secrets Mgr,   │            │ Discord config,        │
       │  DynamoDB)      │            │ Discord Lambdas        │
       └─────────────────┘            └────────────────────────┘
```

The renderer never talks to AWS or to the network directly. Every cross-process call goes through the preload bridge `window.gsd.*`. The main process is the sole authority for AWS SDK calls, terraform spawning, and disk I/O.

### Workspace layout

```
@gsd/shared              types, canRun, sanitizers, command descriptors,
                         CloudProvider/SecretsStore/RemoteFileStore/
                         DiscordEventReceiver INTERFACES (no impls).

@gsd/cloud-aws           NEW. Concrete AWS implementations of all four
                         interfaces. Wraps EcsService, Ec2Service,
                         CostService, LogsService, DiscordConfigService,
                         and a new RemoteTfvarsStore.

@gsd/desktop-main        RENAMED from @gsd/server. Electron main entry
                         point; bootstraps the Nest microservice with
                         IPC transport; hosts TerraformService,
                         FirstRunWizardService, AwsProfileService.
                         CloudProviderModule binds @gsd/cloud-aws impls.

@gsd/desktop-preload     NEW. Defines the typed `window.gsd` surface via
                         contextBridge. One file per Nest module
                         (games, status, logs, costs, discord, files,
                         env, config, terraform, wizard).

@gsd/web                 React SPA. api.service.ts is rewritten over
                         window.gsd.*. EventSource consumers replaced
                         with IPC subscriptions. ApiTokenModal removed
                         (no token concept).

@gsd/lambda-interactions, lambda-followup, lambda-update-dns,
@gsd/lambda-watchdog     Unchanged. They are AWS-bound code that backs
                         the AWS DiscordEventReceiver impl.

@gsd/scripts             Maintainer scripts. init-parent reframed as a
                         developer scaffolder; first-run wizard is the
                         user-facing equivalent.
```

### Cloud provider seams

Four interfaces in `@gsd/shared`, each with one AWS impl in `@gsd/cloud-aws` for v1.

```ts
// @gsd/shared/cloud.ts
export interface CloudProvider {
  startWorkload(game: string, opts: StartOpts): Promise<WorkloadHandle>;
  stopWorkload(game: string): Promise<void>;
  getWorkloadStatus(game: string): Promise<WorkloadStatus>;
  streamWorkloadLogs(game: string, signal: AbortSignal): AsyncIterable<LogChunk>;
  getCostEstimate(): Promise<CostBreakdown>;
  getActualCosts(range: DateRange): Promise<CostBreakdown>;
}

export interface SecretsStore {
  get(name: string): Promise<string | undefined>;
  put(name: string, value: string): Promise<void>;
  exists(name: string): Promise<boolean>;
}

export interface RemoteFileStore {
  get(path: string): Promise<{ body: Uint8Array; etag: string } | undefined>;
  put(path: string, body: Uint8Array, opts?: { ifMatch?: string }): Promise<{ etag: string }>;
  listVersions(path: string): Promise<Array<{ versionId: string; lastModified: Date }>>;
}

export interface DiscordEventReceiver {
  // implemented per cloud; v1 is AWS Lambda Function URL
  getInteractionEndpointUrl(): Promise<string | null>;
  // provisioning is handled in terraform per cloud, not via SDK calls here
}
```

`CloudProviderModule` (Nest module) reads the active cloud profile from electron-store and `provide`s the bound implementation:

```ts
@Module({
  providers: [
    { provide: CLOUD_PROVIDER, useFactory: (cfg) => new AwsCloudProvider(cfg.region), inject: [ConfigService] },
    { provide: SECRETS_STORE,  useFactory: (cfg) => new AwsSecretsManagerStore(cfg.region), inject: [ConfigService] },
    { provide: REMOTE_FILE_STORE, useFactory: (cfg) => new AwsS3Store(cfg.tfvarsBucket, cfg.region), inject: [ConfigService] },
    { provide: DISCORD_RECEIVER, useFactory: (cfg) => new AwsLambdaDiscordReceiver(cfg), inject: [ConfigService] },
  ],
  exports: [CLOUD_PROVIDER, SECRETS_STORE, REMOTE_FILE_STORE, DISCORD_RECEIVER],
})
export class CloudProviderModule {}
```

When (future) GCP support lands, the change is:
1. New package `@gsd/cloud-gcp` with the four impls.
2. `terraform/gcp/` directory with the equivalent Terraform module.
3. `CloudProviderModule` switches on `cfg.activeCloud`.
4. First-run wizard offers "GCP" alongside "AWS".

No call sites in `@gsd/desktop-main` or `@gsd/web` change.

### Terraform layout

```
terraform/
├── main.tf                # cloud-agnostic top-level: variable "active_cloud", module composition
├── variables.tf           # game_servers, project_name, etc — cloud-agnostic
├── aws/
│   ├── ecs.tf, efs.tf, route53.tf, interactions.tf, followup.tf,
│   │   update-dns.tf, watchdog.tf, ... (all current AWS resources)
│   ├── outputs.tf         # exposes cluster_id, log groups, function_url, etc.
│   └── variables.tf       # AWS-specific inputs (vpc_id, hosted_zone, ...)
└── (gcp/, azure/ — future)
```

Top-level `main.tf` includes `module "cloud" { source = "./aws" }` (today) or via `count`/`for_each` keyed on the active provider once a second cloud lands. Operator chooses the cloud at first-run; the wizard writes that into a top-level `tfvars` and `terraform/<cloud>/` is the only module evaluated.

## Runtime

### First-run wizard (`FirstRunWizardService`)

Runs once per machine. Persists progress to `userData/state.json` so partial runs can resume.

1. **Detect prerequisites.** `execFile` `which terraform` / `where.exe terraform`; same for `aws`. Missing? Show install instructions per OS, link to vendor download. Block until both are present (Re-check button). Do not auto-install (avoids elevation).
2. **Pick cloud.** v1 hard-codes "AWS". Future: dropdown.
3. **Credentials.**
   - Read `~/.aws/credentials` and `~/.aws/config`. List profiles.
   - Operator picks a profile, OR pastes an access key + secret. Pasted keys are encrypted via `safeStorage.encryptString` and stored in electron-store under `creds.aws.<profileName>`.
   - Region selector defaults from the profile, allows override.
4. **Bootstrap remote backend.** Using AWS SDK directly (no shell-out):
   - Create the S3 state bucket if missing (with versioning + SSE).
   - Create the DynamoDB lock table if missing.
   - Create the versioned S3 tfvars bucket if missing (epic #80).
   - Show the required IAM permissions checklist (resolved from `GameServerDeployAll` in `docs/docs/setup.md`) and run a best-effort dry-run via `iam:SimulatePrincipalPolicy` to flag missing actions. Never auto-grant; show JSON the operator can paste into the AWS console.
5. **`terraform init`.** `TerraformService.init({ backendConfig: { bucket, region, dynamodbTable } })`. Output streams live into the wizard pane.
6. **Done.** Wizard answers persisted; main window opens to the dashboard.

A "Reconfigure" button in Settings re-runs steps 2–5 against the current install.

### Tfvars sync model

- Canonical storage: `s3://${bucket}/tfvars/terraform.tfvars.json`. JSON form (not HCL) so we can parse it with `JSON.parse` — terraform reads `*.tfvars.json` natively.
- On launch, `TfvarsService.pull()` does a `GetObject` and caches `(parsedConfig, etag, versionId)` in memory.
- Mutations call `PutObject` with `IfMatch: etag`. A 412 surfaces a "remote has changed" modal that reloads the live state and re-validates the user's pending edits.
- Each `terraform plan/apply` re-pulls before running. Local copies of every applied tfvars version are written to `userData/tfvars-history/<versionId>.json` for cheap rollback.
- `terraform.tfstate` itself is not on the desktop disk — the S3 backend handles it. The desktop reads outputs via `terraform output -json` (spawn) or `aws s3api get-object` against the state file when an output is needed before init has run.

Schema validation: a Zod schema in `@gsd/shared` validates the parsed JSON. Invalid remote tfvars surface a "remote config is invalid" UI rather than crashing the app — operators can fix it via the AWS console or a "fix and re-push" UX.

### Terraform orchestrator (`TerraformService`)

Single service in `@gsd/desktop-main`. Public surface (also the IPC contract):

| Method | Purpose |
|---|---|
| `init(config)` | Run `terraform init -backend-config=...`. Idempotent. |
| `plan(runId, tfvarsHash)` | Run `terraform plan -out=tfplan -var-file=<pulled>`. Returns plan summary + plan artifact path. |
| `apply(runId, tfvarsHash, planFile)` | Run `terraform apply tfplan`. Requires the same hash that was planned against (refuses stale plans). |
| `destroy(runId)` | Run `terraform destroy -auto-approve=false` with explicit confirmation. |
| `output()` | Run `terraform output -json`. Used by the dashboard to discover ECS/Lambda IDs after apply. |

Implementation details:
- Binary detection at construction time; result cached. `fix-path` runs once at app boot to fix the GUI PATH issue on macOS/Linux.
- `child_process.spawn('terraform', [...args], { cwd: path.join(resourcesPath, 'terraform/<cloud>'), env: cloudEnv })` where `cloudEnv` is constructed from electron-store + decrypted `safeStorage` blobs.
- Stdout/stderr are line-buffered and emitted via `ipcMain.emit('terraform.run.${runId}.chunk', { stream, line, timestamp })`. End event: `terraform.run.${runId}.end` with exit code.
- Concurrency guard: in-memory `Mutex` keyed on the active cloud profile. Refuses a second concurrent op with `BUSY`. The DynamoDB tf-state-lock catches concurrent ops across desktops.
- Run records persisted to a `${project_name}-runs` DynamoDB table: `runId`, `kind`, `startedAt`, `completedAt`, `exitCode`, `tfvarsVersionId`, `logS3Key` (large logs offloaded to `s3://${bucket}/runs/${runId}.log`).
- ANSI color preserved in the captured log; the renderer renders with a small ANSI-to-HTML helper.

### Logs page (existing) under IPC

The current SSE-based `/api/logs/:game/stream` becomes:

```ts
// preload
gsd.logs.stream(game: string): AsyncIterable<LogChunk>
```

Implemented via two IPC channels — `logs.stream.start(game)` and `logs.stream.${id}.chunk` / `.end` — wrapped in an async iterator on the renderer side. The existing `logs.page.tsx` component changes from `new EventSource(...)` to `for await (const chunk of gsd.logs.stream(game))`. Pause/resume/search UX preserved.

The terraform run logs follow the same pattern under `gsd.terraform.runs.stream(runId)`. The Plan/Apply page (formerly #110) consumes that.

### Discord receiver under abstraction

`AwsLambdaDiscordReceiver` is a thin SDK-wrapping class. It exposes:

```ts
class AwsLambdaDiscordReceiver implements DiscordEventReceiver {
  // Reads interactions_invoke_url from terraform outputs (S3 state backend).
  async getInteractionEndpointUrl(): Promise<string | null> { ... }
}
```

The provisioning of the Lambda + DynamoDB + Secrets Manager remains 100% in `terraform/aws/interactions.tf` and `followup.tf`. Adding GCP later means writing `terraform/gcp/discord-events.tf` (Cloud Functions + Firestore + Secret Manager) and a corresponding `GcpDiscordReceiver`.

The `/discord` UI in the renderer (already shipped under epic #57) calls `gsd.discord.*` IPC methods that read/write the same DynamoDB items the followup Lambda reads. The multi-user permission model (`canRun` + admins + per-game gates) is unchanged because that data lives in the cloud, not the desktop, and is enforced in the followup Lambda — which the desktop never calls.

### Storage on the desktop

| Data | Where | Encryption |
|---|---|---|
| Wizard answers, active cloud profile | `userData/electron-store.json` | None (non-secret config) |
| AWS access key + secret (paste flow) | `userData/electron-store.json` under `creds.aws.<profile>` | `safeStorage.encryptString` |
| Pulled tfvars cache | `userData/tfvars-history/<versionId>.json` | None (also on S3 versioned) |
| Main-process logs | `userData/logs/main-${date}.log`, daily rotated | None |
| Renderer state (UI prefs, etc.) | `localStorage` inside the BrowserWindow | None |
| Terraform run cache | `userData/runs/<runId>/` (plan files, partial logs) | None |

Lambda CJS bundles and `terraform/<cloud>/` HCL ship in `process.resourcesPath` via `extraResources` (read-only at runtime, but `spawn` can `cwd` into them).

## Build & distribution

### Dev loop

```
npm run desktop:dev    # electron-vite dev — main + preload + renderer with HMR
```

`electron-vite` runs three Vite/Rollup pipelines in one process. The renderer gets HMR; the main process auto-restarts on file change. No more separate `vite dev` + `nest start --watch`.

The integration test tier still uses `vite preview` against a mocked Nest microservice for IPC — see Testing.

### Production build

```
npm run desktop:build      # electron-vite build → out/main, out/preload, out/renderer
npm run desktop:package    # electron-builder → release/{*.exe, *.dmg, *.AppImage}
```

`electron-builder.yml` snippet:

```yaml
appId: dev.gsd.desktop
productName: Game Server Deploy
asar: true
extraResources:
  # placed in process.resourcesPath at runtime, OUTSIDE app.asar.
  # terraform spawn cwds into here; Lambda bundles read from here at terraform-apply time.
  - from: "../terraform"
    to: "terraform"
  - from: "../app/packages/lambda/*/dist/handler.cjs"
    to: "lambda"
win:
  target: nsis
mac:
  target: dmg
  hardenedRuntime: false   # unsigned MVP; flip when signing arrives
linux:
  target: [AppImage]
publish: github             # auto-update infra; updater currently disabled in main process
```

At runtime: `path.join(process.resourcesPath, 'terraform/aws')` for `cwd`, `path.join(process.resourcesPath, 'lambda')` for the Lambda CJS bundles that `archive_file` data sources zip up during `terraform apply`. These paths are read-only on macOS/Windows, which is fine — terraform writes its working state under `userData` via `-state` / a configured backend, never into `resourcesPath`.

CI matrix: GitHub Actions runners `ubuntu-latest` (Linux), `macos-latest` (DMG), `windows-latest` (NSIS). Releases pushed to GitHub Releases on tag.

### Auto-update

`electron-updater` wired in `desktop-main/updater.ts`, **disabled by default**. A feature flag `enableAutoUpdate` in electron-store flips it on. v1 ships unsigned; on macOS the updater would fail Gatekeeper checks regardless, so leaving it off is correct. Documented "manually re-download from Releases" until signing lands.

## Testing strategy

The three existing tiers carry over with one substitution per tier:

| Tier | Today | After pivot |
|---|---|---|
| Unit / integration | vitest, AWS mocked via `aws-sdk-client-mock`, web component specs under jsdom | Unchanged. `@gsd/desktop-main` services use the same fixtures. `TerraformService` tests stub `child_process.spawn`. Web specs mock `window.gsd` instead of `fetch`. |
| E2E | Playwright vs `vite preview` + stubbed `/api` via `page.route()` | Replaced with `Playwright's Electron API (`@playwright/test`'s `_electron.launch()`)` launching the packaged main+renderer. Stubbing now happens at the IPC layer via a test-only `window.gsd.__test.mock(channel, response)` injected by the preload in test mode. Page objects unchanged. |
| Integration | Playwright + real Nest server + AWS-SDK-mock | Recast as "main-process + IPC + AWS-mock". Boots the Nest microservice in-process; drives IPC channels directly without a BrowserWindow; `aws-sdk-client-mock` intercepts SDK calls. ServerMocks fixture pattern preserved. |

A new tier is added for terraform-spawn behaviors: a thin "fake terraform" binary checked into `app/test/fake-terraform.mjs` that prints scripted output, gets put on PATH for the integration tier, exercises the orchestrator against realistic stdout/stderr without real AWS or real terraform.

## Migration plan

### Stale issues — close immediately

| # | Reason |
|---|---|
| #5 | Class-based React refactor — pre-Nest, obsolete. |
| #6 | Express+tsyringe → Nest evaluation — already shipped. |
| #7 | Discord slash-command class hierarchy — replaced by JSON descriptors. |
| #10 | Discord serverless migration — already shipped. |
| #43 | SSE log streaming — delivered with #63. |
| #103 | RBAC for desktop API operators — descoped (single-user desktop). |

Each closed with: `Closed as obsolete by the Electron desktop pivot — see <link to this spec>.`

### Repurposed epics (numbers preserved)

| # | New title | Notes |
|---|---|---|
| #80 | Remote tfvars storage — `RemoteFileStore` interface + AWS S3 impl | Children #84–#86, #90 carry over. #87–#89 (script helpers) reframed as `RemoteTfvarsStore` service in `@gsd/desktop-main` — same outcomes, different host. |
| #81 | `TfvarsService` reads from `RemoteFileStore` in desktop-main | Children #91–#95 carry over verbatim — host process moves from Nest-on-:3001 to Nest microservice. |
| #82 | Add/edit/remove games via desktop UI | Children #96–#102 carry over. #103 closed (RBAC out of scope). |

### Closed: epic #83 + child handling

| # | Disposition |
|---|---|
| #83 | Closed. Replaced by Epic D below. |
| #104 | Closed (no CodeBuild). |
| #105 | Moved into Epic D — runs table is still wanted, just locally driven. |
| #106 | Moved into Epic D — apply-lock model preserved (in-memory mutex + DynamoDB lock). |
| #107–#109 | Moved into Epic D — plan/apply/approve become IPC handlers. |
| #110–#112 | Moved into Epic D — Plan/Apply page, Apply-history, rollback UI work carries over. |

### New epics

| Epic | Scope summary |
|---|---|
| **A — Electron shell + build pipeline** | Add `@gsd/desktop-main` (rename of `@gsd/server`) and `@gsd/desktop-preload`. Adopt `electron-vite` + `electron-builder`. Three-target CI matrix. `asarUnpack` for Lambda bundles + `terraform/`. `userData` paths for caches and logs. `fix-path` at boot. Main-process Winston logger. |
| **B — IPC migration of Nest controllers** | Adopt `nestjs-electron-ipc-transport`. Convert every `@Controller` route to `@MessagePattern`. Drop `ApiTokenGuard` and the HTTP bootstrap. Replace SSE with IPC streaming. Rewrite `api.service.ts` over `window.gsd.*`. Replace `EventSource` log consumer with IPC subscription. Decommission `embed-tfstate.mjs`. |
| **C — Cloud provider abstraction + AWS impl** | Define `CloudProvider`, `SecretsStore`, `RemoteFileStore`, `DiscordEventReceiver` in `@gsd/shared`. Extract AWS-specific code from server services into new `@gsd/cloud-aws`. Bind impls in `CloudProviderModule`. Split `terraform/` into `terraform/aws/` + a top-level composer. |
| **D — Local terraform orchestration** | `TerraformService`, IPC-driven plan/apply/destroy/output. Run records in DynamoDB. Mutex + tf state lock. Plan/Apply page, Apply-history page, rollback flow. Inherits #105, #106, #110, #111, #112. |
| **E — First-run wizard + credentials UX** | Multi-step wizard: detect CLIs, pick cloud (v1: AWS only), profile selection from `~/.aws`, paste-and-encrypt for ad-hoc keys, bootstrap S3 state + tfvars + DynamoDB lock via SDK, run `terraform init`. Re-runnable from Settings as "Reconfigure". |
| **F — Test migration to Playwright's Electron API (`@playwright/test`'s `_electron.launch()`)** | Convert e2e specs from `vite preview` to `Playwright's Electron API (`@playwright/test`'s `_electron.launch()`)`. Recast integration tier as "main-process + IPC + AWS-mock". Add `fake-terraform.mjs` for orchestrator coverage. Page objects unchanged. |
| **G — Distribution + auto-update scaffolding** | Three-target CI artifacts. Release workflow with GitHub Releases. `electron-updater` wired but disabled. Documented unsigned-MVP install instructions per OS. |

### Releasable milestones

```
M1 "Runs as Electron"        :  Epic A → Epic B
M2 "Manages config"          :  Epic C → repurposed-#80 → repurposed-#81 → repurposed-#82
M3 "Runs terraform"          :  Epic D → Epic E
M4 "Polish & ship"           :  Epic F + Epic G (parallel)
```

Dependencies:

- **A** unblocks **B** and **C** (chassis must exist first).
- **B** unblocks repurposed-#82 UI work (UI changes ride on top of the IPC contract) and Epic F (Playwright's Electron API (`@playwright/test`'s `_electron.launch()`) needs the IPC surface).
- **C** unblocks **D**, repurposed-#80, repurposed-#81 (cloud-side work goes through the abstracted store).
- repurposed-#80 → repurposed-#81 → **D** and repurposed-#82.
- **F** runs after **B** (when IPC is the contract).
- **G** can scaffold in parallel with M2/M3 and finalize at M4.

Each milestone is releasable. M1 ships an Electron app that does what today's web app does (operators still hand-run terraform out-of-band). M2 ships in-app config editing. M3 makes the desktop self-managing. M4 polishes for distribution.

### Issues parked (not closed, not epic'd)

- **#36** multiple EFS mounts per game — parked under "future game-server features".
- **#38** declarative file_seeds for EFS — same.
- **#40** Discord per-game connection message — parked.
- **#47, #48, #50** init-parent CLI improvements — parked; first-run wizard supersedes operator-facing concerns. Re-evaluate at M3.
- **#72** TSDoc lint — parked, unrelated.
- **#78** GameCard error-recovery flow — kept open, slot into M2 or earlier.
- **#113** Temporal API migration — parked.

## Open questions

1. **Discord receiver provisioning gating** — when an operator switches active cloud (future-state) does the Discord page hide entirely, or stay visible with a "not supported on $CLOUD" banner? Decide at the time, doesn't block v1.
2. **Lambda bundle distribution** — pre-built bundles ship inside the desktop app's `extraResources`. If a user wants to deploy from a fork with custom Lambda code, they need a "rebuild lambdas" affordance. Out of scope for v1.
3. **Crash reporting** — Sentry / native Electron crash reporter? Defer to post-MVP.

## Risks

| Risk | Mitigation |
|---|---|
| `nestjs-electron-ipc-transport` is a small library; could go unmaintained. | The library is thin (~300 LOC). If it breaks, fork it. The IPC contract itself is stable Electron API. |
| AWS SDK from the renderer would be a security regression — ensure no leakage. | Lint rule banning `@aws-sdk/*` imports from `@gsd/web`. The preload has zero AWS SDK references. |
| Windows EV signing cost when we want auto-update. | Track Azure Trusted Signing pricing; prepare a signed track on a separate branch when budget allows. |
| Terraform CLI version skew between operator machines. | Pin a minimum version in the wizard prerequisites check. Display the resolved version in Settings. |
| `app.getPath('userData')` differs between Electron versions — historical incidents. | Lock Electron major version in `package.json`; don't bump in patch releases. |

## Out of scope for this spec

- The full implementation plan (file-by-file diff, sub-issues per Epic). That's the next step — `writing-plans` skill takes this spec as input.
- Operator-facing release notes / install docs (covered by Epic G).
- Marketing site or in-app onboarding beyond the first-run wizard.
