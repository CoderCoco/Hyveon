---
title: S3 tfvars storage
sidebar_position: 5
---

# S3 tfvars storage

`terraform.tfvars` holds your hosted zone, Discord credentials, and the
`game_servers` map — everything a deployment needs but nothing you want to
lose or hand-edit blind on a second machine. This guide covers the optional
**versioned S3 backend** for that one file: bootstrapping it, the day-to-day
CLI and `make` targets that keep a local copy and the remote object in sync,
migrating an existing parent repo onto (or off) it, and what to do when the
sync check fails.

If you haven't set up a [submodule-based parent repo](/guides/submodule) yet,
start there — this page assumes the wrapper `Makefile` it generates already
exists. Everything here also works standalone via `scripts/tfvars-sync.ts`
if you're not using the submodule pattern.

## Why bother

Local-file `terraform.tfvars` works fine for a single operator on a single
machine. The S3 backend earns its keep once more than one of these is true:

- More than one person (or CI job) needs to run `terraform plan`/`apply`.
- You want version history / recoverability for tfvars edits, independent of
  git (tfvars is deliberately gitignored — see
  [What NOT to do](/guides/submodule#what-not-to-do)).
- You want `terraform apply` to refuse to run against a stale local copy.

If none of that applies, skip this page — `local` mode (the default) needs
no S3 bucket and no extra commands.

## Bootstrapping the S3 backend

`terraform/bootstrap/` is a small, standalone Terraform module that
provisions a dedicated, versioned S3 bucket (default name
`{project_name}-tfvars`) whose only job is to hold `terraform.tfvars`. It's
unrelated to the `{project_name}-tf-state` bucket the main `setup.sh`
bootstrap creates for the Terraform state backend.

Three ways to bootstrap it, in order of convenience:

1. **`./setup.sh` (Linux/macOS)** — prompts interactively
   (`Store terraform.tfvars in a versioned S3 bucket (terraform/bootstrap)? [y/N]`)
   unless `GSD_TFVARS_BACKEND` is already set:
   - `GSD_TFVARS_BACKEND=s3` — bootstraps non-interactively.
   - `GSD_TFVARS_BACKEND=local` — skips entirely, no AWS/Terraform calls.
   - Unset + non-interactive shell (CI) — silently defaults to `local`.

   On `s3`, it runs `terraform init`/`terraform apply` inside
   `terraform/bootstrap/`, records the bucket name at `.gsd/tfvars-bucket`
   (repo root, gitignored), and uploads the local `terraform.tfvars` to the
   bucket — but only if that key doesn't already exist remotely, so
   re-running `setup.sh` never clobbers a tfvars file someone else already
   pushed or edited in S3.

2. **`init-parent.ts bootstrap --s3-tfvars`** — when scaffolding a fresh
   [submodule parent repo](/guides/submodule#quick-start-interactive-scaffolder),
   pre-answers the same prompt up front and writes the `.gsd/tfvars-bucket`
   marker at the *parent repo root* before `setup.sh` ever runs, so `make
   setup` bootstraps the S3 backend on its first run without asking.

3. **Manual** — for `setup.ps1` users (not yet ported) or anyone who wants
   to run it standalone:

   ```bash
   cd terraform/bootstrap
   terraform init
   terraform apply
   ```

   The resulting bucket has versioning enabled, AES-256 server-side
   encryption, all four public-access-block settings on, and a lifecycle
   rule that expires noncurrent object versions after 90 days. Its own
   Terraform state stays local (`terraform/bootstrap/terraform.tfstate`,
   already gitignored) — it can't use the S3 backend it's bootstrapping, so
   keep a personal backup of that state file.

Already have a tfvars bucket some other way? That's fine too, as long as its
name matches `tfvars_bucket_name` (defaults to `{project_name}-tfvars`) so
the root module's `data "aws_s3_bucket" "tfvars"` resolves correctly.

See [Bootstrap the tfvars bucket](/setup#bootstrap-the-tfvars-bucket-required-before-the-first-terraform-apply)
in the setup guide for the full walkthrough, including IAM permissions.

## Day-to-day: the `tfvars-sync` CLI

`scripts/tfvars-sync.ts` is the CLI that actually talks to S3. It pulls,
pushes, diffs, and reports status for a local `terraform.tfvars` against the
bucket:

```bash
tsx scripts/tfvars-sync.ts pull   [--bucket <name>] [--path <file>] [--key <key>] [--region <region>]
tsx scripts/tfvars-sync.ts push   [--bucket <name>] [--path <file>] [--key <key>] [--region <region>]
tsx scripts/tfvars-sync.ts diff   [--bucket <name>] [--path <file>] [--key <key>] [--region <region>]
tsx scripts/tfvars-sync.ts status [--bucket <name>] [--path <file>] [--key <key>] [--region <region>]
tsx scripts/tfvars-sync.ts check  [--bucket <name>] [--path <file>] [--key <key>] [--region <region>]
```

| Command | What it does |
|---|---|
| `pull` | Downloads the remote object to `--path` (default `terraform/terraform.tfvars`), creating parent directories as needed, and writes a sidecar lock file (`<path>.lock`) recording the version just pulled. |
| `push` | Uploads the local file to the bucket/key. Refuses to overwrite the remote object if the local lock is missing or stale — see [Troubleshooting](#troubleshooting) below. |
| `diff` | Prints a unified diff (`remote → local`). Exits `0` and prints `✓ local and remote match` when byte-identical; otherwise exits `1` and prints `✗ local and remote differ`. |
| `status` | Prints bucket/key/path, the local lock's recorded version/etag/pulled-at, the remote object's current version/etag/last-modified, and whether the two agree. |
| `check` | Drift gate for CI/`make apply`: exits `0` (`✓ in sync: ...`) when the local lock's version id matches the remote's current version id, `1` (`✗ drift detected: <reason>`) otherwise. |

`--bucket` is resolved through a fallback chain when omitted: the flag
itself, then the `GSD_TFVARS_BUCKET` environment variable, then the nearest
`.gsd/tfvars-bucket` marker file found walking up from the current
directory. The CLI errors out if none of these resolve. `--key` always
defaults to the fixed key `terraform.tfvars` regardless of `--path` — pass
it explicitly only if the bucket should hold the object under a different
name.

Run it directly from this repo's own workspace via
`npm run scripts:tfvars-sync -- <command> [flags]`.

### The lock file

Every successful `pull` or `push` (re)writes `<path>.lock` — JSON recording
the S3 `bucket`, `key`, `versionId`, `etag`, `size`, `lastModified`, and
`pulledAt`. It's the optimistic-concurrency check `push` uses before
uploading: if the remote object exists but no lock is present, or the lock's
`versionId` doesn't match the remote's *current* `versionId`, `push` refuses
to run rather than silently clobbering someone else's newer write. It's
safe to inspect, and safe to delete — a deleted lock just means the next
`push` will require a fresh `pull` first.

## Day-to-day: `make` targets

If you're using the [submodule parent-repo pattern](/guides/submodule), the
generated wrapper `Makefile` drives the same CLI for you, plus wires it into
`plan`/`apply` automatically:

| Target | What it does |
|---|---|
| `make tfvars-pull` | Pulls `terraform.tfvars` from the configured S3 backend. Refuses to run if the local file has uncommitted git changes, so a pull can never silently discard edits you haven't committed. Fails fast with a pointer to `GSD_TFVARS_BACKEND`/`setup.sh` if no backend is detected. |
| `make tfvars-push` | Pushes the local `terraform.tfvars` to the configured S3 backend. Same fail-fast behavior when no backend is detected. |
| `make tfvars-diff` | Prints a unified diff between local and remote. Same fail-fast behavior when no backend is detected. |
| `make plan` | Auto-pulls the latest tfvars from S3 first (when a backend is detected), so a stale local copy can't silently drive the plan. Set `NO_PULL=1` to skip the pull for one invocation. |
| `make apply` | Asserts the local tfvars are still in sync with S3 first (`tfvars-sync check`), refusing to apply against drifted vars. Set `FORCE_APPLY=1` to skip the check for one invocation. |
| `make setup` | If `setup.sh` bootstrapped an S3 backend, also pulls `terraform.tfvars` afterwards. On a first bootstrap against an empty bucket the pull can't find anything yet — it prints a warning suggesting `make tfvars-push` to seed the bucket instead of failing `make setup`. |

Whether these targets treat you as being in S3 mode or local mode is decided
by `TFVARS_BACKEND`, resolved in this order:

1. `GSD_TFVARS_BACKEND=s3` or `GSD_TFVARS_BACKEND=local` — explicit override,
   wins regardless of any marker file.
2. The **parent-root** `.gsd/tfvars-bucket` marker (written by
   `init-parent bootstrap --s3-tfvars` or `migrate --to-s3`, before
   `setup.sh` ever runs) — takes priority if present.
3. The **submodule-local** `.gsd/tfvars-bucket` marker (written by
   `setup.sh`'s own bootstrap) — checked next.
4. Otherwise: `local`.

In `local` mode the gates inside `setup`/`plan`/`apply` are silent no-ops —
nothing changes for a deployment that has never touched the S3 backend.
`make tfvars-pull`/`push`/`diff` behave differently: they're
operator-invoked, so they always fail fast (rather than silently no-opping)
when no backend is detected.

## Migrating an existing parent repo's backend

Started on `local` and want to move to S3 later (or vice versa), without
re-running the whole interactive scaffolder? `init-parent.ts migrate`
rewires an already-scaffolded parent repo (one where `bootstrap` has already
run and a `Makefile` exists) in place:

```bash
npx --prefix Hyveon/scripts tsx Hyveon/scripts/init-parent.ts migrate --to-s3
# or
npx --prefix Hyveon/scripts tsx Hyveon/scripts/init-parent.ts migrate --to-local
```

Exactly one of `--to-s3` / `--to-local` is required — passing both, or
neither, is a usage error. Both directions prompt for confirmation before
touching anything; pass `--yes` to skip the prompt (e.g. for scripting/CI).

### `migrate --to-s3`

1. Reads `project_name` out of the parent repo's existing
   `terraform.tfvars` and derives the bucket name `${project_name}-tfvars` —
   the same convention `bootstrap --s3-tfvars` uses.
2. Writes the `.gsd/tfvars-bucket` marker at the parent repo root.
3. Rewrites the `Makefile` with the S3-aware targets (the same output a
   fresh `bootstrap` renders — the Makefile is always S3-aware; only the
   marker's presence flips `TFVARS_BACKEND` to `s3`).
4. Runs `make setup` with `GSD_TFVARS_BACKEND=s3` so `terraform/bootstrap/`
   provisions the bucket.

`terraform.tfvars` itself is left untouched — pull the now-remote copy down
explicitly with `make tfvars-pull` afterwards for confirmation it
round-tripped (or push it up with `make tfvars-push` if the bucket comes
back empty).

### `migrate --to-local`

1. Resolves the target bucket the same way the generated Makefile does:
   `GSD_TFVARS_BUCKET` env var, else the parent-root marker, else the
   submodule-local one. Exits `1` with no changes if none resolve (already
   local — nothing to migrate).
2. Pulls `terraform.tfvars` down from S3 first if it's missing locally (a
   parent repo that's been in S3 mode a while may have no local copy at
   all).
3. Diffs the local file against the remote object byte-for-byte (the same
   comparison `make tfvars-diff`/`tfvars-sync.ts diff` uses) and **aborts,
   leaving every file untouched**, if they've drifted — reconcile with
   `make tfvars-pull` or `make tfvars-push` first, then re-run the
   migration. If the remote object was never seeded at all, this comparison
   is skipped and migration proceeds straight to step 4.
4. On a clean match (or an unseeded remote), deletes both the parent-root
   and submodule-local `.gsd/tfvars-bucket` markers, plus the
   `terraform.tfvars.lock` sidecar. `terraform.tfvars` itself stays in
   place — it's already the correct source of truth for local mode once the
   markers are gone.

`migrate --to-local` **never deletes the S3 bucket** — tear it down yourself
once you're done with it:

```bash
terraform -chdir=Hyveon/terraform/bootstrap destroy
```

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `push` fails with `Local lock version "..." does not match remote version "..." for s3://<bucket>/terraform.tfvars. Run "pull" to refresh before pushing.` — i.e. **the remote object changed since your last pull** | Someone else (or another machine you use) pushed a newer `terraform.tfvars` after your last `pull`. Your local lock file is now stale, so `push` refuses to silently overwrite their change. | Run `tfvars-sync.ts pull` (or `make tfvars-pull`) to fetch the latest version and refresh the lock. If your local edits still need to land, reconcile the two files by hand (or re-apply your edits on top of the freshly-pulled copy), then `push` again. Never blindly force-overwrite — you'd destroy whatever the other operator/machine just wrote. |
| `push` fails with `Remote object s3://<bucket>/terraform.tfvars changed after the version check (concurrent push detected). Run "pull" to refresh before pushing.` | A second `push` slipped in between this `push`'s own version check and its upload (a true race, not just a stale lock) — the S3 conditional write (`IfMatch`) caught it. | Same fix as above: `pull`, reconcile if needed, `push` again. This is rarer than the plain stale-lock case above but resolved identically. |
| `push` fails with `Remote object ... already exists but no local lock file was found at terraform.tfvars.lock. Run "pull" first.` | You've never pulled on this machine/checkout, so there's no lock to validate against — `push` won't guess whether it's safe to overwrite. | Run `pull` once to establish a baseline lock, then `push`. |
| `push` fails with `Bucket "<bucket>" does not appear to have S3 versioning enabled...` | The bucket was created or modified outside `terraform/bootstrap/` and has versioning off or suspended. The whole conflict-detection scheme (`versionId` comparisons) depends on a versioned bucket. | Enable versioning on the bucket (or re-provision it via `terraform/bootstrap/`, which enables it by default), then retry. |
| `check` fails (`make apply` aborts) with `no local lock file found ... — run "pull" first` | Fresh checkout, or the lock file was deleted/gitignored-and-never-restored. | `make tfvars-pull` once, then retry `make apply`. Or set `FORCE_APPLY=1` if you're intentionally applying without syncing (not recommended). |
| `check`/`make apply` fails with a version-id mismatch reason | Same root cause as the `push` conflict above, just caught earlier by the pre-apply gate instead of at push time. | `make tfvars-pull`, review the diff, `make apply` again. |
| `pull`/`push`/`diff`/`status`/`check` all fail with `--bucket is required (or set GSD_TFVARS_BUCKET, or create a .gsd/tfvars-bucket marker file)` | No backend configured, or you're running the CLI from a directory where the marker-file walk-up can't find `.gsd/tfvars-bucket`. | Pass `--bucket` explicitly, set `GSD_TFVARS_BUCKET`, or run from within the repo/parent-repo tree so the marker file is found. If you haven't bootstrapped a backend yet, see [Bootstrapping the S3 backend](#bootstrapping-the-s3-backend) above. |
| `make tfvars-pull`/`push`/`diff` fail with `No S3 tfvars backend detected (TFVARS_BACKEND=local) — set GSD_TFVARS_BACKEND=s3 ... or bootstrap one via setup.sh.` | No `.gsd/tfvars-bucket` marker exists anywhere in the resolution chain, and `GSD_TFVARS_BACKEND` isn't set to `s3`. | Bootstrap a backend (see above) or set `GSD_TFVARS_BACKEND=s3` with `GSD_TFVARS_BUCKET` pointing at an existing bucket. |
| `make tfvars-pull` (or the automatic `plan`/`setup` pull) refuses with `terraform.tfvars has uncommitted changes — commit or stash them before pulling from S3.` | A pull overwrites the local file in place; the guard won't let it discard uncommitted edits git can see. | Commit or `git stash` the local changes, then retry. Or `NO_PULL=1 make plan` to skip the auto-pull for one invocation. |
| `migrate --to-local` aborts with a drift message, no files changed | The local `terraform.tfvars` and the remote object have diverged — see the diff step in [`migrate --to-local`](#migrate---to-local) above. | Run `make tfvars-pull` or `make tfvars-push` to reconcile, then re-run the migration. |
| First-ever `push` to a brand-new bucket succeeds even though you never `pull`ed | Expected: `push` only requires a prior `pull` when the remote object already exists. A first push to an empty bucket has nothing to conflict with. | Nothing to fix — this is the intended "seed the bucket" path (`setup.sh`'s post-bootstrap pull warns and suggests exactly this when the bucket comes back empty). |

For issues with the bootstrap step itself (bucket creation, IAM
permissions), see the [setup guide's IAM section](/setup#1-create-and-authorise-an-iam-user)
and its own [Troubleshooting](/setup#troubleshooting) table.
