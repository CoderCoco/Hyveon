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
`update`, `dev`) so you can drive the whole stack from the parent repo root.

### Usage

From the parent (private) repo root, after adding the submodule:

```bash
git submodule add https://github.com/CoderCoco/Hyveon.git
(cd Hyveon/scripts && npm install)
node --import tsx Hyveon/scripts/init-parent.ts
# or, equivalently:
npx --prefix Hyveon/scripts tsx Hyveon/scripts/init-parent.ts
```

Flags:

- `--force` — overwrite existing files instead of skipping them.

The script never reads or modifies anything inside the submodule. Safe to
re-run; without `--force` it leaves existing files alone.

### Requirements

- Node.js 20+ (the same minimum the rest of the project enforces).
- `git` on `$PATH` (used to detect `.gitmodules`).

Windows users should run this under WSL or Git Bash — the generated
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
pulled-at timestamp observed on the last successful `pull` or `push`. It is
JSON and safe to inspect or commit-ignore alongside the tfvars file it
tracks.

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

On success, both `pull` and `push` (re)write the lock file with the
newly-observed version, so the next `push` is validated against it.

### Diff exit codes

`diff` sets `process.exitCode`:

- **`0`** — local and remote are byte-for-byte identical (`matches: true`).
- **`1`** — local and remote differ (`matches: false`); the unified diff is
  printed to stdout before the exit code is set.

### Requirements

- Node.js 20+.
- AWS credentials resolvable by the AWS SDK v3's default provider chain
  (env vars, shared config/credentials file, or `--region`/SDK defaults).
