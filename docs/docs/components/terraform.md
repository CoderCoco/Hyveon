---
title: Terraform
sidebar_position: 2
---

# Terraform

All AWS infrastructure lives under `terraform/`. State is stored in an S3
bucket with DynamoDB locking, bootstrapped automatically by `setup.sh` — see
step 3 of the [setup guide](/setup) for details.

The root `terraform/` directory is a thin composer: the `terraform`/`provider`
blocks, a `module "cloud"` (source `./aws`) that carries every AWS resource,
and passthrough `outputs.tf`/`variables.tf`. All AWS-specific HCL lives in the
`terraform/aws/` module — that's where you'll find the actual resources.

## Files

| File | What it provisions |
|---|---|
| `main.tf` | Root composer: `terraform`/`backend "s3"` block, both `provider "aws"` blocks (default + `us_east_1` alias for CloudFront ACM certs), and the `module "cloud"` block wiring all 16 inputs through to `./aws`. |
| `variables.tf` | Every configurable input (passed straight through to the module). See the table below. |
| `outputs.tf` | Re-exports every `module.cloud.*` output by the same name — `ConfigService.getTfOutputs()` reads these from root-level `terraform.tfstate`, where module outputs don't appear. |
| `moved.tf` | One `moved` block per resource living in `terraform/aws/`, mapping its pre-split root address to `module.cloud.<type>.<name>` so existing deployments `plan` cleanly instead of proposing a destroy/recreate. |
| `terraform.tfvars.example` | Starting point for your `terraform.tfvars`. |
| `aws/main.tf` | VPC, Internet Gateway, two public subnets across AZs, route table, IAM execution role, EFS filesystem + mount targets + **per-game access points**, ECS cluster, **one Fargate task definition per game**, CloudWatch log groups, game-server + file-manager + EFS security groups. |
| `aws/versions.tf` | Module-local `required_providers` (aws, archive), including the `aws.us_east_1` `configuration_aliases` entry the root passes in. |
| `aws/variables.tf` | Module input declarations — every root variable except `tags` (which only the root's `default_tags` needs). |
| `aws/outputs.tf` | Every value the management app (and humans) consume, including the four outputs that used to be stray blocks in `interactions.tf`, `discord-domain.tf`, `route53.tf`, and `watchdog.tf`. |
| `aws/alb.tf` | Conditional on any game having `https = true`: ACM certificate (DNS-validated), ALB + target groups per HTTPS game, HTTPS listener + HTTP→HTTPS redirect, Route 53 ALIAS records. |
| `aws/route53.tf` | Route 53 zone **data source** (zone must exist); the `update-dns` Lambda with its IAM, EventBridge rule on `ECS Task State Change`. |
| `aws/watchdog.tf` | `watchdog` Lambda with its IAM, EventBridge schedule at `rate(${watchdog_interval_minutes} minute(s))`. |
| `aws/efs-seeder.tf` | Conditional on any game having `file_seeds`: shared seeder SG, per-game IAM role + policy, CloudWatch log group, Lambda (VPC + EFS mount), and `aws_lambda_invocation` that re-triggers only when seed content changes. |
| `aws/interactions.tf` | `interactions` Lambda with IAM + Function URL (`auth_type = NONE`, CORS for `https://discord.com`). Exposes `interactions_invoke_url`. |
| `aws/followup.tf` | `followup` Lambda with IAM (`ecs:RunTask`, `StopTask`, `DescribeTasks`, `iam:PassRole`, `dynamodb:GetItem`/`PutItem`, `ec2:DescribeNetworkInterfaces`). Async-invoked by interactions. |
| `aws/discord_store.tf` | DynamoDB table (pk+sk, TTL on `expiresAt`), two Secrets Manager secrets (`${project_name}/discord/bot-token`, `/discord/public-key`) with `recovery_window_in_days = 0` and `lifecycle.ignore_changes` on seeded secret values. Optional `CONFIG#discord` DynamoDB item seeded from tfvars. Optional `BASE#discord` item holding the Terraform-managed base allowlist/admins (see `base_allowed_guilds` / `base_admin_*` variables). When `discord_bot_token`, `discord_application_id`, and at least one `base_allowed_guilds` entry are set, a `null_resource` runs `curl` to register slash commands in each base guild during apply; re-runs on token rotation or command-descriptor changes. |

## Variables

| Name | Type | Default | Purpose |
|---|---|---|---|
| `aws_region` | `string` | `us-east-1` | AWS region for all resources. |
| `project_name` | `string` | `game-servers` | Prefix for named resources and the Secrets Manager paths. |
| `vpc_cidr` | `string` | `10.0.0.0/16` | Parent CIDR; subnets are /24s within it. |
| `game_servers` | `map(object)` | — | The single source of truth. Per-game: `image`, `cpu`, `memory`, `ports[]`, `environment[]`, `volumes[]` (`name` + `container_path`), `https`, `connect_message` (optional), `file_seeds[]` (optional). Each `volumes` entry creates its own EFS access point rooted at `/${game}/${name}`. `connect_message` controls the Discord connection hint shown when a server reaches RUNNING; supports `{host}`, `{ip}`, `{port}`, and `{game}` placeholders. See `game_servers[].file_seeds` below. |
| `hosted_zone_name` | `string` | _(required)_ | Existing Route 53 zone looked up as a data source (e.g. `example.com`). |
| `acm_certificate_domain` | `string` | `null` → `*.{hosted_zone_name}` | Wildcard ACM cert for the ALB listener. |
| `dns_ttl` | `number` | `30` | TTL on Route 53 A records the update-dns Lambda writes. Keep low for fast task churn. |
| `watchdog_interval_minutes` | `number` | `15` | How often the watchdog schedule fires. |
| `watchdog_idle_checks` | `number` | `4` | Consecutive idle windows before `StopTask`. |
| `watchdog_min_packets` | `number` | `100` | Below this `NetworkPacketsIn` per window = idle. |
| `discord_application_id` | `string` | `""` | Seeds `CONFIG#discord` in DynamoDB on first apply. Skipped if empty. |
| `discord_bot_token` | `string` (sensitive) | `""` | Seeds `${project_name}/discord/bot-token`. Empty → Terraform writes `"placeholder"`. |
| `discord_public_key` | `string` (sensitive) | `""` | Seeds `${project_name}/discord/public-key`. Same placeholder behaviour. |
| `base_allowed_guilds` | `list(string)` | `[]` | Guild IDs written to the `BASE#discord` row on every apply. The management UI shows these as locked; they cannot be removed via the UI. Update in tfvars + re-apply to change. |
| `base_admin_user_ids` | `list(string)` | `[]` | Discord user IDs with permanent server-wide admin rights. Same Terraform-managed floor as above. |
| `base_admin_role_ids` | `list(string)` | `[]` | Discord role IDs with permanent server-wide admin rights. Same Terraform-managed floor as above. |
| `tags` | `map(string)` | defaults | Merged into `default_tags` for cost allocation (`Project`). |

### `game_servers[].file_seeds` (optional)

Declare files to be written to a game's EFS volume during `terraform apply`.
Each entry in the list is:

| Field | Type | Default | Description |
|---|---|---|---|
| `path` | `string` | _(required)_ | In-container path (e.g. `/palworld/Pal/Saved/Config/LinuxServer/PalWorldSettings.ini`). The first volume's `container_path` is stripped to resolve the EFS-relative destination. |
| `content` | `string` | `null` | UTF-8 text content. Mutually exclusive with `content_base64`. |
| `content_base64` | `string` | `null` | Base64-encoded binary content — use for non-UTF-8 files such as mod `.pak` files (`base64 -w0 MyMod.pak`). |
| `mode` | `string` | `"0644"` | chmod octal string applied to the written file. |

When `file_seeds` is non-empty, `efs-seeder.tf` creates a seeder Lambda for the game and invokes it immediately. The invocation re-runs only when the sha256 of `file_seeds` changes, making re-applies with unchanged seeds a no-op. Removed seed entries are **not** deleted from EFS — clean them up via FileBrowser.

> **Do not store secrets in `file_seeds`** — content is written verbatim into Terraform state.

## Outputs

| Output | Consumer |
|---|---|
| `vpc_id`, `subnet_ids`, `security_group_id`, `file_manager_security_group_id` | followup Lambda env + any manual ops. |
| `ecs_cluster_name`, `ecs_cluster_arn` | watchdog + followup Lambda env + the management app. |
| `efs_file_system_id`, `efs_access_points` | Reference; each task mounts its own AP. |
| `game_names` | interactions / followup / update-dns / watchdog Lambdas (env var `GAME_NAMES`). |
| `task_definitions` | Ops (`aws ecs run-task --task-definition palworld-server`). |
| `hosted_zone_id`, `domain_name`, `dns_records` | update-dns / watchdog Lambda env + DNS checks. |
| `alb_dns_name`, `acm_certificate_arn` | Null if no HTTPS games; public reference otherwise. |
| `discord_table_name`, `discord_bot_token_secret_arn`, `discord_public_key_secret_arn` | Management app reads via the parsed tfstate to reach DynamoDB + Secrets. |
| `interactions_invoke_url` | Pasted into Discord Developer Portal → General Information → Interactions Endpoint URL. |
| `watchdog_function_name` | Ops / debugging. |
| `aws_region` | Reference + the management app. |

## AWS services in use

- **Compute**: ECS (cluster + per-game Fargate task definitions), Lambda (4 functions).
- **Networking**: VPC, subnets, route tables, IGW, security groups, ALB + target groups + listener rules (if HTTPS games).
- **Storage**: EFS filesystem, mount targets, per-game access points.
- **DNS / TLS**: Route 53 zone (data source) + Lambda-managed A records, ACM cert (DNS-validated), ALB ALIAS records.
- **Events**: EventBridge rule (ECS task state change), EventBridge schedule (watchdog).
- **State**: DynamoDB (CONFIG + PENDING rows with TTL), Secrets Manager (bot token + public key).
- **Observability**: CloudWatch log groups (`/ecs/{game}-server` + Lambda logs), CloudWatch metrics (`NetworkPacketsIn`), Cost Explorer (read from the management app).
- **IAM**: task execution role, four per-Lambda execution roles, inline policies (least-privilege).

## Gotchas

- **Build Lambdas before `terraform apply`.** Terraform zips
  `app/packages/lambda/*/dist/handler.cjs` via `archive_file`; missing files
  are an init-time error.
- **`AWS_REGION_` (trailing underscore)** on every Lambda env var set from
  Terraform. `AWS_REGION` is reserved by the runtime.
- **DNS A records for non-HTTPS games are NOT Terraform resources.** The
  update-dns Lambda owns them on task state change. Adding
  `aws_route53_record` for them would cause a loop.
- **HTTPS games get ALB ALIAS records in Terraform**, plus the Lambda
  registers/deregisters the ENI IP as an ALB target on RUNNING/STOPPED.
- **EFS access points are UID/GID 1000 and mode 0755.** Game images that
  run as a different UID will fail to write to the volume.
- **Secrets use `recovery_window_in_days = 0`** so `terraform destroy` +
  re-`apply` is clean. The first `apply` seeds them; `lifecycle.ignore_changes`
  lets the dashboard edit them afterwards without Terraform stomping on the
  value. To rotate via tfvars after seeding, `terraform taint` the specific
  `aws_secretsmanager_secret_version.discord_*` resource.
- **`events:TagResource` / `UntagResource` / `ListTagsForResource`** aren't
  in any AWS-managed policy — you need `events:*` (or at least those three)
  on the deploy user. The setup guide's inline policy already covers this.
- **`file_seeds` targets the first volume only.** The seeder Lambda mounts the
  EFS access point for `volumes[0]`, so all seed `path` values must use that
  volume's `container_path` as a prefix. Multi-volume games with seeds across
  different volumes are not supported in this release.
- **`file_seeds` content lives in Terraform state.** Suitable for config files
  and small binary assets (mods). Do not put passwords or tokens here.
- **Removed seed entries are not deleted from EFS.** They are simply no longer
  managed. Delete stale files via the FileBrowser task.
- **Removing a game from the map deletes its task definition** but does not
  stop running tasks. Stop the game from the dashboard first, then remove
  the key.
- **S3 backend + DynamoDB lock** are bootstrapped by `setup.sh` — state is
  remote by default. If you need to run `terraform init` manually, pass the
  same `-backend-config` flags that `setup.sh` uses (bucket, key, region,
  dynamodb_table, encrypt).
