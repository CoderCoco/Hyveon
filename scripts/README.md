# scripts/

Helper scripts for `Hyveon`. These are intentionally **not** part
of the `app/` workspace — they exist to be run from a *parent* repo that
vendors `Hyveon` as a git submodule, before any of the app's
dependencies have been installed.

## `init-parent.ts`

Interactive scaffolder for the [private parent + submodule deployment
pattern](https://codercoco.github.io/Hyveon/guides/submodule/). It
generates a `Makefile`, `terraform.tfvars`, `.env`, and `.gitignore` in your
parent repo, all wired to the wrapper Make targets (`setup`, `plan`, `apply`,
`update`, `dev`, `tfvars-pull`, `tfvars-push`, `tfvars-diff`) so you can drive
the whole stack from the parent repo root.

### Usage

```bash
init-parent.ts [--force] [--s3-tfvars] [--yes]            Interactive bootstrap (default)
init-parent.ts migrate --to-s3 | --to-local [--yes]        Migrate an existing parent repo's tfvars backend
```

From the parent (private) repo root, after adding the submodule:

```bash
git submodule add https://github.com/CoderCoco/Hyveon.git
(cd Hyveon/scripts && npm install)
node --import tsx Hyveon/scripts/init-parent.ts
# or, equivalently:
npx --prefix Hyveon/scripts tsx Hyveon/scripts/init-parent.ts
```

### Subcommands

`bootstrap` has no subcommand token of its own — it is the implicit default,
selected whenever the first argument is omitted or starts with `--` (e.g.
`tsx init-parent.ts --force` keeps working unchanged). Passing the literal
word `bootstrap` as an argument is **not** supported and exits `1` with
`Unknown subcommand "bootstrap"` — the only recognized subcommand token is
`migrate`.

- **`bootstrap`** (default, invoked with no subcommand token) — the interactive scaffolder described above:
  prompts for parent-repo details and writes `Makefile`, `terraform.tfvars`,
  `.env`, and `.gitignore`, plus (only when requested) the
  `.gsd/tfvars-bucket` S3 backend marker.
- **`migrate --to-s3`** — migrates an already-scaffolded parent repo (one
  that already has a `Makefile`, i.e. `bootstrap` has already run) from a
  local-file tfvars backend onto a versioned S3 bucket. Writes
  `.gsd/tfvars-bucket` (`${project_name}-tfvars`, read out of the existing
  `terraform.tfvars`'s `project_name` key), rewrites the `Makefile` with the
  S3-aware targets, then runs `make setup` with `GSD_TFVARS_BACKEND=s3` so
  `terraform/bootstrap/` provisions the bucket. `terraform.tfvars` itself is
  left untouched — pull it back down from S3 afterwards with `make
  tfvars-pull` if you want confirmation it round-tripped.
- **`migrate --to-local`** — the reverse: drops an already-scaffolded parent
  repo's S3 tfvars backend, reverting `make plan`/`make apply` to reading
  `terraform.tfvars` straight off disk. Resolves the target bucket
  (`GSD_TFVARS_BUCKET` env var, else the parent-root marker, else the
  submodule-local marker), pulls `terraform.tfvars` down from S3 first if
  it's missing locally, aborts with no changes if the local file has
  drifted from the remote object (checked the same way `tfvars-sync.ts
  diff` does — skipped entirely if the remote object was never seeded, in
  which case migration proceeds straight to deleting the markers), then
  deletes both `.gsd/tfvars-bucket` markers and the `terraform.tfvars.lock`
  sidecar. `terraform.tfvars` itself is left in place. The S3 bucket is
  **not** deleted — destroy it manually with `terraform
  -chdir=<submodule>/terraform/bootstrap destroy` if you no longer need it.

### Flags

- `--force` — (`bootstrap` only) overwrite existing files instead of
  skipping them.
- `--s3-tfvars` — (`bootstrap` only) pre-answers the "bootstrap an
  S3-backed tfvars store?" prompt with yes, skipping it, and writes the
  `.gsd/tfvars-bucket` marker up front.
- `--to-s3` / `--to-local` — (`migrate` only) selects the migration
  direction. Exactly one is required; passing both or neither is a usage
  error.
- `--yes` — for `migrate`, skips the "Proceed?" confirmation and runs
  immediately. For `bootstrap`, it only pre-answers the "bootstrap an
  S3-backed tfvars store?" prompt (defaulting to no unless `--s3-tfvars`
  was also passed); all other bootstrap prompts (parent repo path,
  submodule path, project name, AWS region, hosted zone, API token,
  Discord credentials) still run interactively.

An unrecognized subcommand, an unrecognized flag for the resolved
subcommand, or (for `migrate`) anything other than exactly one of
`--to-s3`/`--to-local` prints a usage error to stderr and exits `1`.

From inside this repo's own workspace (e.g. while developing the scaffolder
itself), the `scripts:init-parent` npm script is an equivalent way to invoke
it — pass subcommands/flags after `--`:

```bash
npm run scripts:init-parent -- migrate --to-s3
npm run scripts:init-parent -- migrate --to-local
npm run scripts:init-parent -- --force --s3-tfvars
```

`bootstrap` never reads or modifies anything inside the submodule, and is
safe to re-run; without `--force` it leaves existing files alone. `migrate`
is the exception: `--to-local` may delete the submodule-local
`.gsd/tfvars-bucket` marker (see above), and `--to-s3` runs `make setup`,
which executes `setup.sh` inside the submodule.

### Requirements

- Node.js 20+ (the same minimum the rest of the project enforces).
- `git` on `$PATH` (used to detect `.gitmodules`).
- Windows users should run this under WSL or Git Bash — the generated
  `Makefile` uses `bash`, `sha256sum`, and `cp`, which mirrors the upstream
  Makefile's shell expectations.

## `tfvars-sync.ts`

Standalone CLI for syncing `terraform.tfvars` with the versioned S3 bucket
provisioned by `terraform/bootstrap` (see `docs/docs/setup.md` for the
bootstrap flow): pulls, pushes, diffs, and reports status. Useful when you
want to sync tfvars from a shell or CI job without going through the desktop
app. (A `RemoteTfvarsStore` service exposing the same pull/push/diff/status
operations to `desktop-main` is planned as a follow-up; this CLI does not
depend on it.)

### Usage

```bash
tsx scripts/tfvars-sync.ts pull   [--bucket <name>] [--path <file>] [--key <key>] [--region <region>]
tsx scripts/tfvars-sync.ts push   [--bucket <name>] [--path <file>] [--key <key>] [--region <region>]
tsx scripts/tfvars-sync.ts diff   [--bucket <name>] [--path <file>] [--key <key>] [--region <region>]
tsx scripts/tfvars-sync.ts status [--bucket <name>] [--path <file>] [--key <key>] [--region <region>]
tsx scripts/tfvars-sync.ts check  [--bucket <name>] [--path <file>] [--key <key>] [--region <region>]
```

### Subcommands

- **`pull`** — downloads the remote tfvars object to `--path`, creating parent
  directories as needed, and writes a sidecar lock file recording the version
  just pulled.
- **`push`** — uploads the local `--path` file to the remote bucket/key.
  Refuses to overwrite the remote object if the local lock is missing (never
  pulled) or stale (the remote object's current version id doesn't match the
  lock's recorded version) — run `pull` again to resolve, then retry `push`.
- **`diff`** — prints a unified diff (`remote → local`) between the remote
  object and the local file. Prints `✓ local and remote match` and exits `0`
  when the contents are byte-for-byte identical; otherwise prints
  `✗ local and remote differ` and **exits `1`**.
- **`status`** — prints the bucket/key/path, whether the local file exists,
  the sidecar lock's recorded version/etag/pulled-at timestamp (or "none —
  never pulled"), the remote object's current version/etag/last-modified (or
  "object does not exist"), and whether the local lock is in sync with the
  remote version.
- **`check`** — drift gate intended for `make apply` (or any CI/pre-flight
  step): compares the local lock's recorded version id against the remote
  object's current version id. Prints `✓ in sync: ...` and **exits `0`** when
  they match; prints `✗ drift detected: <reason>` and **exits `1`** otherwise
  (no lock file, remote object missing, the bucket lacking S3 versioning, or
  a version mismatch), with a clear, specific reason in each case.

### Flags

- `--bucket <name>` — target S3 bucket. See resolution order below.
- `--path <file>` — local file to read from / write to. Defaults to
  `terraform/terraform.tfvars`.
- `--key <key>` — S3 object key. Always defaults to the fixed key
  `terraform.tfvars`, regardless of `--path` — pass it explicitly if the
  bucket should hold the object under a different key.
- `--region <region>` — AWS region override; falls back to the AWS SDK's
  default provider chain when omitted.

### `--bucket` resolution order

`--bucket` is resolved through a fallback chain when the flag is omitted:

1. The `--bucket` flag, if passed.
2. The `GSD_TFVARS_BUCKET` environment variable.
3. The contents of the nearest `.gsd/tfvars-bucket` marker file, found by
   walking up from the current working directory.

The CLI exits with an error (`--bucket is required (or set
GSD_TFVARS_BUCKET, or create a .gsd/tfvars-bucket marker file)`) if none of
these resolve.

### Lock-file mechanism

A sidecar lock file (`${path}.lock`, e.g. `terraform/terraform.tfvars.lock`)
records the S3 version id, etag, size, last-modified timestamp, and
pulled-at timestamp from the last successful `pull` or `push`. On `pull`,
`lastModified` and `pulledAt` reflect the object's `LastModified` value as
observed from S3. On `push`, both fields are instead the client-side write
timestamp (`new Date().toISOString()` in `tfvars-sync.ts`, line ~393),
recorded right after the upload completes rather than read back from S3.
It is JSON and safe to inspect or commit-ignore alongside the tfvars file
it tracks.

`push` uses the lock as an optimistic-concurrency check before uploading:

- If the remote object exists but no lock file is present locally, `push`
  throws (`Run "pull" first.`) rather than overwriting an object it has
  never seen.
- If the remote object exists and the lock's `versionId` doesn't match the
  remote object's current `versionId` (i.e. someone else pushed since the
  last local `pull`), `push` throws (`Run "pull" to refresh before
  pushing.`) instead of clobbering the newer remote version.
- If the remote object doesn't exist yet, `push` proceeds without a lock
  check (first push).

On success, both `pull` and `push` (re)write the lock file with the new
version — `pull` from the version it observed on S3, `push` from the
response returned by its own upload — so the next `push` is validated
against it.

### Diff exit codes

`diff` sets `process.exitCode`:

- **`0`** — local and remote are byte-for-byte identical (`matches: true`).
- **`1`** — local and remote differ (`matches: false`); the unified diff is
  printed to stdout before the exit code is set.

### Check exit codes

`check` sets `process.exitCode`:

- **`0`** — the local lock's version id matches the remote object's current
  version id (`inSync: true`).
- **`1`** — the versions don't match, printing the specific reason: no local
  lock file was found, the remote object doesn't exist, the bucket doesn't
  appear to have S3 versioning enabled (`HeadObject` returned no
  `VersionId`, so drift can't be detected), or the lock's recorded version
  id differs from the remote's current version id. Wire this into
  `make apply` (or CI) as a pre-flight drift gate so an apply never runs
  against a `terraform.tfvars` that has silently drifted from the version
  stored in S3.

### Requirements

- Node.js 20+.
- AWS credentials resolvable by the AWS SDK v3's default credential
  provider chain (env vars, shared credentials file, IAM role, etc.).
- A region, resolved via `--region` or the SDK's own region config —
  this only selects the region and is unrelated to credential resolution.
