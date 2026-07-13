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
- **Break Cost Explorer's per-value tag activation** — AWS Billing activates
  cost allocation tags by `(key, value)` pair, not just by key. A new
  `Project` value needs its own fresh activation; historical cost data under
  the old value doesn't carry over automatically.

Work through the checklist below in order.

:::caution Backend bucket/lock table are also derived from `project_name`

The Terraform **backend itself** — the S3 state bucket (`{project_name}-tf-state`)
and the DynamoDB lock table (`{project_name}-tf-locks`) described in
[the setup guide](/setup) — is named off `project_name`, the same variable
you're about to change. If you already have a live, applied stack and you
change `project_name` before touching the backend, `terraform init` will
silently point at a **different, nonexistent** bucket/table instead of your
existing state — Terraform will happily initialize a brand-new empty backend,
and your real infrastructure becomes invisible to future `plan`/`apply` runs
(effectively orphaned, not migrated).

Before running `terraform plan`/`apply` with the new `project_name`, pick one:

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
  bucket + DynamoDB table first (don't let `terraform init` auto-create them
  against empty state), then run `terraform init -migrate-state` pointing at
  the new backend config, or manually copy the state object in S3 and the
  lock table row in DynamoDB before switching the backend block over. Verify
  `terraform plan` shows **no unexpected creates** for already-existing
  infrastructure before applying — a full-stack "everything will be created"
  plan means you're looking at an empty backend, not a migration.

Do not skip this — it is the single most common way a `project_name` change
turns into an accidental duplicate/orphaned stack.

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
  `project_name`, the ECS cluster (`${project_name}-cluster`), and the
  Lambda functions themselves.
- **Update in place (tags only)** — resources whose name doesn't reference
  `project_name` but that pick up the new `Project` tag value via
  `default_tags`. This includes the game-server CloudWatch log groups
  (`/ecs/${each.key}-server`) — their name is keyed off the game, not
  `project_name`, so they're only retagged, not replaced — and the VPC
  (`aws_vpc.main`), whose only `project_name` reference is its `Name` tag.

Do not apply until you've confirmed the replace-set matches what you expect —
an unexpected replacement (e.g. the VPC) is a sign `project_name` is
referenced somewhere you didn't account for.

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

### 3. Apply, then re-activate the `Project` cost allocation tag

After `terraform apply` completes successfully:

```bash
terraform apply
```

Go to **AWS Billing → Cost allocation tags** and activate the new
`Project = <new-value>` tag (e.g. `Project = hyveon`). Cost allocation tag
activation is per tag *value*, so the previous value (e.g.
`Project = game-servers-poc`) stays activated separately, and its historical
cost data does not merge with the new value's data — expect a visible break
in any Cost Explorer report grouped by the `Project` tag on the day of the
migration.

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
