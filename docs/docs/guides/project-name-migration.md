---
title: project_name migration runbook
sidebar_position: 6
---

# `project_name` migration runbook

`terraform/variables.tf`'s `project_name` (mirrored in `terraform/aws/variables.tf`)
is interpolated into nearly every AWS resource name, IAM identifier, log group
name, tag value, and Discord Secrets Manager ARN in the stack. Changing it —
including the one-time rebrand from the old `game-servers` default to
`hyveon` tracked in [#213](https://github.com/CoderCoco/Hyveon/issues/213) —
is **not** a text replacement you can apply blind. This page is the
operational checklist to follow any time `project_name` changes on an
already-provisioned stack.

If you're bootstrapping a brand-new stack that has never been applied, none
of this applies — just set `project_name` in `terraform.tfvars` before the
first `terraform apply` and skip this page.

## Why this needs a dedicated pass

Renaming `project_name` forces AWS to:

- **Re-create** resources whose name isn't in-place editable — CloudWatch log
  groups, Secrets Manager secrets, and potentially ECS task definitions and
  IAM roles all embed `${var.project_name}` in their `name`/`Name` argument,
  which Terraform can only satisfy by destroy-then-create.
- **Re-tag** every resource, since the `tags` variable's `Project` value
  (`terraform/variables.tf`) flows through the AWS provider's
  `default_tags { tags = var.tags }` block in `terraform/main.tf` onto
  everything the stack manages.
- **Show a visible break in Cost Explorer for the `Project` tag** — AWS
  Billing activates cost allocation tags by *key*, not by `(key, value)`
  pair, so an already-activated `Project` key picks up the new value
  automatically (after AWS's usual ingestion lag) with no re-activation
  step required. What doesn't carry over is the cost *data*: historical
  spend recorded under the old value doesn't merge with the new value's
  data, so any Cost Explorer report grouped by `Project` shows a visible
  break on the day of the migration.

Work through the checklist below in order.

:::caution Backend bucket/lock table are also derived from `project_name`

The Terraform **backend itself** — the S3 state bucket (`{project_name}-tf-state`)
and the DynamoDB lock table (`{project_name}-tf-locks`) described in
[the setup guide](/setup) — is named off `project_name`, the same variable
you're about to change. If you already have a live, applied stack and you
change `project_name` before touching the backend, the resulting
bucket/table names computed from the new value are **different from, and
nonexistent relative to**, the ones your existing state lives in.

A bare `terraform init` against a bucket/table that doesn't exist yet will
**error out loudly** rather than silently standing up an empty backend — the
S3 backend never auto-creates its bucket or lock table. The silent-orphan
risk instead comes from **`./setup.sh`** (or just its bootstrap step): it
derives `{project_name}-tf-state`/`{project_name}-tf-locks` from whatever
`project_name` is currently set to and idempotently creates them if missing,
then runs `terraform init` against that new backend. Re-running `./setup.sh`
after changing `project_name` on an already-provisioned stack will therefore
happily create a brand-new empty bucket/table pair and point Terraform at it
— your real infrastructure's state file is left behind, untouched and
invisible to future `plan`/`apply` runs (effectively orphaned, not migrated).

Before running `./setup.sh` (or `terraform plan`/`apply` directly) with the
new `project_name`, pick one:

- **(a) Keep the existing backend.** Pin `project_name = "game-servers"`
  (the old default, prior to the `hyveon` rebrand tracked in
  [#213](https://github.com/CoderCoco/Hyveon/issues/213)) — or whatever value
  your stack was actually applied with — *only* for the backend, e.g. keep
  passing `-backend-config="bucket=game-servers-tf-state"
  -backend-config="dynamodb_table=game-servers-tf-locks"` (or whatever
  your current bucket/table names are) to `terraform init` while still
  letting the new `project_name` value flow through everything else via
  `terraform.tfvars`. This is the lower-risk default: the state file doesn't
  move, only the resources it manages get renamed/retagged per the checklist
  below.
- **(b) Deliberately migrate the backend.** If you want the bucket/table
  names themselves to match the new `project_name`, create the new S3
  bucket + DynamoDB table first (don't let a re-run of `./setup.sh`'s
  bootstrap step silently create them against empty state), then run
  `terraform init -migrate-state` pointing at the new backend config, or
  manually copy the state object in S3 and the lock table row in DynamoDB
  before switching the backend block over. Verify `terraform plan` shows
  **no unexpected creates** for already-existing infrastructure before
  applying — a full-stack "everything will be created" plan means you're
  looking at an empty backend, not a migration.

Do not skip this — it is the single most common way a `project_name` change
turns into an accidental duplicate/orphaned stack.

:::

:::caution The tfvars bucket is also derived from `project_name`

Separately from the backend above, `terraform/main.tf`'s
`data "aws_s3_bucket" "tfvars"` resolves an **unconditional**, required data
source:

```hcl
data "aws_s3_bucket" "tfvars" {
  bucket = coalesce(var.tfvars_bucket_name, "${var.project_name}-tfvars")
}
```

`tfvars_bucket_name` defaults to `null`, so unless you set it explicitly the
lookup falls back to `"${var.project_name}-tfvars"` — the **new** project
name's bucket, not the one `terraform/bootstrap/` actually created your
tfvars store under. Because this is a data source (not a resource), Terraform
can't paper over a missing bucket the way `apply` can for a resource: **step
1's `terraform plan` fails outright** with a "couldn't find resource"/no
such bucket error the moment `project_name` changes and no matching bucket
exists yet.

Worse, if you run `./setup.sh` again after changing `project_name` (e.g. with
`GSD_TFVARS_BACKEND=s3`), its `bootstrap_tfvars_backend` step derives the
bucket name the same way (off the *new* `project_name`) and will happily
`terraform apply` the `terraform/bootstrap/` module to create a brand-new,
**empty** `{new_project_name}-tfvars` bucket — silently, with no error — and
overwrite `.gsd/tfvars-bucket` to point at it. Your real `terraform.tfvars`
stays in the old bucket, invisible to anything reading the new marker.

Before running `./setup.sh` (or `terraform plan`/`apply` directly) with the
new `project_name`, pick one here too:

- **(a) Keep the existing tfvars bucket.** Set
  `tfvars_bucket_name = "<old-project-name>-tfvars"` in `terraform.tfvars`
  (see the commented-out example in `terraform.tfvars.example`) so the data
  source keeps resolving to the bucket `terraform/bootstrap/` already
  created, regardless of what `project_name` becomes. Leave
  `.gsd/tfvars-bucket` (if present) pointing at that same bucket name — don't
  let a `./setup.sh` re-run rewrite it.
- **(b) Migrate the tfvars bucket too.** Create the new
  `{new_project_name}-tfvars` bucket (via `terraform/bootstrap/`, or let
  `./setup.sh`'s bootstrap step do it), then copy the existing
  `terraform.tfvars` object across — `aws s3 cp
  s3://<old-project-name>-tfvars/terraform.tfvars
  s3://<new-project-name>-tfvars/terraform.tfvars` — and update
  `.gsd/tfvars-bucket` to the new bucket name before running `terraform plan`.
  Confirm the copied object round-trips (`scripts/tfvars-sync.ts diff`, or a
  manual `aws s3 cp ... -` and eyeball it) before treating the migration as
  done.

:::

## Checklist

### 1. Review the `terraform plan` output line by line

Run `terraform plan` (or `make plan` if you're on the
[submodule/S3 tfvars workflow](/guides/s3-tfvars)) after changing
`project_name` in `terraform.tfvars`, and read the full plan before applying
anything:

```bash
cd terraform
terraform plan
```

Enumerate every resource in the plan into one of two buckets:

- **Replace (destroy + create)** — anything whose `name` embeds
  `project_name`: the Lambda CloudWatch log groups
  (`/aws/lambda/${project_name}-watchdog`, etc.), the two Discord Secrets
  Manager secrets (`${project_name}/discord/bot-token`,
  `${project_name}/discord/public-key`), the DynamoDB table
  (`${project_name}-discord`), IAM roles/policies named after
  `project_name`, the ECS cluster (`${project_name}-cluster`), the
  Lambda functions themselves, and **`aws_efs_file_system.saves`**
  (`terraform/aws/main.tf`) — its `creation_token` is
  `"${var.project_name}-saves"`, which is a `ForceNew` argument on the EFS
  filesystem, so it drags the mount targets (`aws_efs_mount_target.saves`)
  and every per-game access point (`aws_efs_access_point.game`) along with
  it as dependent replacements. See the danger box right after this list —
  this is the most destructive replacement in the plan, not the DynamoDB
  table.
- **Update in place (tags only)** — resources whose name doesn't reference
  `project_name` but that pick up the new `Project` tag value via
  `default_tags`. This includes the game-server CloudWatch log groups
  (`/ecs/${each.key}-server`) — their name is keyed off the game, not
  `project_name`, so they're only retagged, not replaced — and the VPC
  (`aws_vpc.main`), whose only `project_name` reference is its `Name` tag.

Do not apply until you've confirmed the replace-set matches what you expect —
an unexpected replacement (e.g. the VPC) is a sign `project_name` is
referenced somewhere you didn't account for.

:::danger The EFS filesystem (`aws_efs_file_system.saves`) is destroyed and recreated empty — this permanently deletes all game save data

Unlike the DynamoDB table (step 4, below), which is at least *repopulatable*
from tfvars or a config you wrote down first, `aws_efs_file_system.saves` has
**no equivalent recovery path**. Its `creation_token` is
`"${var.project_name}-saves"` — a `ForceNew` argument — so any `project_name`
change forces Terraform to destroy the filesystem and create a brand-new,
empty one under the new creation token. Every per-game save directory
(`aws_efs_access_point.game`) and the mount target(s) (`aws_efs_mount_target.saves`)
are destroyed along with it. **There is no backup, no snapshot, and no
migration path built into this stack** — once `terraform apply` completes,
every game's save data on the old filesystem is gone.

Before applying a `project_name` change on a stack with real save data on it,
do one of:

- **Back up the EFS data first.** Use [AWS Backup](https://docs.aws.amazon.com/efs/latest/ug/awsbackup.html)
  to take an on-demand backup of the filesystem, or run an
  [AWS DataSync](https://docs.aws.amazon.com/datasync/latest/userguide/efs-location.html)
  task (or a plain `rsync`/`tar` from an EC2 instance or Fargate task with the
  EFS mounted) to copy the save directories out to S3 or another filesystem
  you control, before running `terraform apply`. Restore into the new
  filesystem's access points afterwards.
- **Avoid the replacement entirely.** Either keep `project_name` pinned for
  this resource (e.g. temporarily hardcode the old creation token instead of
  interpolating `var.project_name`, apply, then plan the rename separately
  with a deliberate `terraform state mv` / import once you've verified the
  token can be changed in place — it can't, today, so this is a bigger
  change than this runbook covers), or accept the destroy and treat it as a
  fresh, empty save volume post-migration.
- At minimum, confirm with whoever operates the stack that save-data loss is
  acceptable before applying — don't assume it is because the DynamoDB danger
  box (step 4) was handled.

:::

### 2. Coordinate downtime for in-flight task definitions

If any game-server ECS tasks are currently `RUNNING`, the ECS cluster
(`${project_name}-cluster`) and the `project_name`-named task execution IAM
role (`${project_name}-task-execution`) that those tasks depend on will be
replaced by the apply. Stop running tasks (or schedule the apply for a
window when no one is playing) before applying — a running task can lose its
CloudWatch logs and cluster connection because the ECS cluster and task
execution role are destroyed and recreated under the new name, and the
watchdog Lambda's idle-tag bookkeeping (see step 5) resets when the task
itself is replaced.

### 3. Apply, then confirm the new `Project` value shows up in Cost Explorer

After `terraform apply` completes successfully:

```bash
terraform apply
```

Cost allocation tag activation is per tag *key*, not per value — if
`Project` is already an activated cost allocation tag (check **AWS Billing →
Cost allocation tags**), the new value (e.g. `Project = hyveon`) appears
there automatically once AWS ingests the retagged resources; there's no
re-activation step to perform. Only activate `Project` from that page if
it isn't already listed as active. Either way, allow for AWS's usual
ingestion lag before the new value shows up, and don't expect historical
cost data to merge across values — spend recorded under the old value
(e.g. `Project = game-servers-poc`) stays separate from the new value's
data, so any Cost Explorer report grouped by the `Project` tag shows a
visible break on the day of the migration.

### 4. Verify the Discord Secrets Manager ARNs came back online

The two Discord secrets are recreated under new ARNs (the name segment
changes from `{old_project_name}/discord/...` to
`{new_project_name}/discord/...`). The interactions Lambda reads
`DISCORD_PUBLIC_KEY_SECRET_ARN` from its environment at cold start (see
`terraform/aws/interactions.tf`) to verify Discord's Ed25519 signatures. The
followup Lambda doesn't read either secret ARN from its environment — it has
no need to, since it never touches the bot token or public key directly.
The bot token is instead resolved by the desktop app: `ConfigService` reads
`discord_bot_token_secret_arn` / `discord_public_key_secret_arn` out of
`terraform.tfstate`, and `DiscordConfigService` uses those ARNs to read/write
the secrets via Secrets Manager on demand. Confirm both paths picked up the
new ARNs:

```bash
aws secretsmanager describe-secret --secret-id "<new-project-name>/discord/bot-token"
aws secretsmanager describe-secret --secret-id "<new-project-name>/discord/public-key"
```

- Re-enter the bot token and public key through the desktop app's
  Credentials tab (or reseed via `discord_bot_token`/`discord_public_key` in
  `terraform.tfvars` before applying) — the new secrets are created with a
  `"placeholder"` value on first apply and won't have real credentials until
  you set them.
- Invoke `/server-status` in Discord once credentials are re-entered to
  confirm the interactions Lambda can verify signatures against the new
  public-key secret. To confirm the desktop app itself picked up the new
  secrets, hit `GET /api/discord/config` and check `botTokenSet` /
  `publicKeySet` are both `true`.

:::danger The DynamoDB table (`${project_name}-discord`) is wiped, not migrated

Step 1's replace-bucket also includes the DynamoDB table
`${project_name}-discord`. Unlike the two secrets — which are recreated with
a placeholder value you then refill — the table is destroyed and recreated
**empty** under its new name. That table is the *only* copy of:

- The `DiscordConfig` row: the guild allowlist, admin users/roles, and every
  per-game user/role permission entry read by `canRun()`
  (`@hyveon/shared/canRun`).
- Any pending-interaction rows written by `@hyveon/lambda-followup` for
  in-flight `/server-start` commands (15-minute TTL — likely already expired
  by the time you're mid-migration, but don't count on it).

Until this row is repopulated, the interactions Lambda's guild-allowlist
check has nothing to allow — **every** guild is rejected, including the ones
that worked before the migration. There is no automatic carry-over from the
old table to the new one.

Before applying, do one of:

- **Record the config first.** Hit `GET /api/discord/config` (or read the
  guild allowlist / admin / per-game permission fields off the desktop app's
  Discord page) and write down every value before running `terraform apply`.
  After the apply, re-enter the same values through the desktop app's
  Discord page — this repopulates the row via the normal `PUT` path.
- **Reseed via tfvars.** If the allowlist/admin config is already captured in
  `terraform.tfvars` (`discord_application_id` plus the relevant base-list
  variables), `aws_dynamodb_table_item.discord_config_seed` repopulates the
  row automatically on `apply` — confirm the tfvars values are current
  *before* applying so the seed matches what was there previously.

Either way, verify the allowlist is live again (`GET /api/discord/config`,
or `/server-status` from an allowed guild) before considering step 4 done.

:::

### 5. Confirm the watchdog Lambda still finds tasks by tag

`@hyveon/lambda-watchdog` locates and tags running ECS tasks directly — it
doesn't look them up by `project_name`, but its idle-check counter is stored
as a tag on each task, and its IAM role/log group names embed
`project_name`. After the apply:

- Check `/aws/lambda/${project_name}-watchdog` (the *new*
  `project_name`-qualified log group) for a successful invocation on its
  next scheduled run (`watchdog_interval_minutes`).
- Start a game server and confirm the watchdog's idle-check tag appears on
  the running task (`aws ecs describe-tasks --tasks <task-arn> --cluster
  <cluster> --query 'tasks[].tags'`) after one interval, and that the
  counter increments/resets as expected rather than erroring on a missing
  role/permission.

### 6. Sanity-check Cost Explorer the next day

Cost Explorer data has ingestion lag — the newly-activated `Project =
<new-value>` tag won't show usage from before the activation, and same-day
data is frequently incomplete. Come back the day after the apply and confirm:

- The new `Project` tag value appears as a filter/group-by option in Cost
  Explorer.
- Costs for the migrated resources are attributing to the new tag value
  going forward.
- The old tag value's historical data is still intact (it should be —
  migrating the tag value doesn't delete the old activation or its data).

## Related documentation updates

A `project_name` migration usually also requires touching these files in the
same change — see the "Checklist for Terraform variable changes" section in
the repo's `CLAUDE.md` for the general case:

- `CLAUDE.md`'s `Project=<value>` reference in the cost-allocation comment.
- `terraform/terraform.tfvars.example`'s `project_name` example value.
- `docs/docs/components/terraform.md`'s variables table, if the default
  changed.
- `docs/docs/setup.md`, anywhere it references the IAM ARN prefixes or
  default `project_name` value (e.g. the `hyveon-*` IAM resource patterns,
  the `{project_name}-tfvars`/`{project_name}-tf-state` bucket names).
