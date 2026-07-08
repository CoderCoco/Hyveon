---
title: Lambdas
sidebar_position: 4
---

# Lambdas

Four TypeScript Lambda packages live under `app/packages/lambda/`. Each
builds via esbuild to a single CJS file at `dist/handler.cjs`; Terraform's
`archive_file` data source zips that at apply time.

```bash
cd app && npm run build:lambdas        # produces every dist/handler.cjs
```

All four Lambdas read AWS region from `process.env.AWS_REGION_`
(trailing underscore — `AWS_REGION` is reserved by the Lambda runtime).
Terraform sets the variable with that name in every function definition.

## interactions

| | |
|---|---|
| **Package** | `@hyveon/lambda-interactions` |
| **Trigger** | Lambda Function URL (public HTTPS, `auth_type = NONE`, CORS for `https://discord.com`) — Discord POSTs every interaction here. |
| **Terraform** | `terraform/aws/interactions.tf`. Output: `interactions_invoke_url`. |
| **IAM** | `dynamodb:GetItem` on the Discord table, `secretsmanager:GetSecretValue` on the public-key secret, `lambda:InvokeFunction` on the followup Lambda. |
| **Env vars** | `AWS_REGION_`, `TABLE_NAME`, `DISCORD_PUBLIC_KEY_SECRET_ARN`, `FOLLOWUP_LAMBDA_NAME`, `GAME_NAMES`, `HOSTED_ZONE_NAME`. |

### Behaviour

1. **Signature verify** — reads `x-signature-ed25519` + `x-signature-timestamp`
   headers, fetches the public key from Secrets Manager (5-minute cache via
   `@hyveon/shared/secrets`), and verifies with `@noble/ed25519` over
   `timestamp + rawBody`. Rejects 401 on mismatch; without a valid signature
   Discord stops routing to the URL.
2. **PING** (`type === 1`) → respond `{ type: 1 }` (PONG).
3. **Autocomplete** (`type === 4`) → filter `GAME_NAMES` by the user's
   partial input, then filter by `canRun()` against the DynamoDB config,
   return choices synchronously. No ECS calls — has to fit in Discord's
   3-second budget.
4. **Application command** (`type === 2`):
   - Confirm the guild is in `allowedGuilds`.
   - Confirm `canRun(cfg, { userId, roleIds, game, action })`.
   - Return a **deferred ack** (`type: 5`, ephemeral flag `64`) immediately.
   - Async-invoke the followup Lambda (`InvokeCommand` with `InvocationType:
     'Event'`) with a `FollowupPayload` (`kind`, applicationId,
     interactionToken, userId, guildId, roleIds, optional game).

If anything above throws, Discord sees either a non-200 response or a
silent timeout — the user gets no reply, which is the correct failure
mode (replying with an error would require another signed response, which
we can't forge).

## followup

| | |
|---|---|
| **Package** | `@hyveon/lambda-followup` |
| **Trigger** | Async invoke from the interactions Lambda (`InvocationType: 'Event'`). Not exposed externally. |
| **Terraform** | `terraform/aws/followup.tf`. |
| **IAM** | `ecs:RunTask` / `StopTask` / `ListTasks` / `DescribeTasks` / `TagResource`, `iam:PassRole` (task execution role — required for RunTask with Fargate), `ec2:DescribeNetworkInterfaces`, `dynamodb:GetItem` / `PutItem`, `secretsmanager:GetSecretValue` on the public key (only read for downstream calls in some paths). |
| **Env vars** | `AWS_REGION_`, `TABLE_NAME`, `ECS_CLUSTER`, `SUBNET_IDS` (comma-separated), `SECURITY_GROUP_ID`, `DOMAIN_NAME`, `GAME_NAMES`. |

### Behaviour

Event is a `FollowupPayload`:

```ts
type FollowupPayload = {
  kind: 'start' | 'stop' | 'status' | 'list'
  applicationId: string
  interactionToken: string
  userId: string
  guildId: string
  roleIds: string[]
  game?: string
}
```

1. Re-fetch the Discord config (defensive re-check — the interactions
   Lambda already ran `canRun`, but config could change between the two
   invocations).
2. Dispatch by `kind`:
   - **`start`** — `runStart()`: `ecs.runTask` with the game's task
     definition family (`{game}-server`), public-IP-enabled network
     config, the Fargate launch type. If successful, call `putPending()`
     (`PENDING#{taskArn}` with 15-min TTL); then PATCH the original
     interaction with "starting …".
   - **`stop`** — find the running task via `findRunningTask()`, call
     `ecs.stopTask`, PATCH "stopping …".
   - **`status`** — single-game `getStatus()` (ListTasks → DescribeTasks →
     `ec2.describeNetworkInterfaces` for the public IP), PATCH with the
     resolved state + hostname/IP.
   - **`list`** — status for every game the user has at least `status`
     permission for, joined into one ephemeral message.
3. PATCH the Discord webhook at
   `https://discord.com/api/v10/webhooks/{applicationId}/{interactionToken}/messages/@original`.
   Valid for 15 minutes after the original interaction.

Failure modes:

- ECS call fails → error message in the PATCH body.
- CloudWatch ENI lag (task RUNNING but no ENI yet) → `getStatus()` returns
  `{ state: 'error', message: ... }`; caller sees it in Discord.
- DynamoDB write fails (for `start`) → logged, PATCH still happens so user
  sees "starting"; but update-dns won't later PATCH with the final IP
  because the pending row doesn't exist.
- Discord PATCH fails (stale token, network) → logged; user's deferred
  message is not edited.

## update-dns

| | |
|---|---|
| **Package** | `@hyveon/lambda-update-dns` |
| **Trigger** | EventBridge rule on `source: aws.ecs`, `detail-type: 'ECS Task State Change'`, `lastStatus` in `['RUNNING', 'STOPPED']`. |
| **Terraform** | `terraform/aws/route53.tf`. |
| **IAM** | `route53:ChangeResourceRecordSets`, `route53:ListResourceRecordSets`, `ecs:DescribeTasks`, `ec2:DescribeNetworkInterfaces`, `elasticloadbalancing:RegisterTargets` / `DeregisterTargets`, `dynamodb:GetItem` / `DeleteItem`. |
| **Env vars** | `HOSTED_ZONE_ID`, `DOMAIN_NAME`, `GAME_NAMES`, `DNS_TTL`, `AWS_REGION_`, `HTTPS_GAMES`, `ALB_TARGET_GROUPS` (JSON map game → target group ARN), `TABLE_NAME`. |

### Behaviour

Event shape (simplified):

```json
{
  "detail": {
    "lastStatus": "RUNNING | STOPPED",
    "taskArn": "...",
    "clusterArn": "...",
    "group": "family:palworld-server"
  }
}
```

1. Parse the task family from `detail.group`, map to a game via
   `FAMILY_TO_GAME`. Skip unknown families.
2. Determine whether the game is **HTTPS** (present in `HTTPS_GAMES`) or
   **direct**.
3. **Direct games**:
   - On `RUNNING`: `resolveIp('public')` — retries up to 5 times with
     3-second sleeps to survive ENI attach lag; then `upsertDns()` writes
     an A record `{game}.{domain}` → IP with `DNS_TTL`.
   - On `STOPPED`: read the current record, verify its IP, `deleteDns()`.
4. **HTTPS games**:
   - On `RUNNING`: resolve the **private** IP, `registerAlb()` (adds it to
     the target group).
   - On `STOPPED`: `deregisterAlb()`.
5. On `RUNNING`, regardless of game type: call `notifyDiscordIfPending()`
   — look up `PENDING#{taskArn}` in DynamoDB, format a final status
   message, PATCH the original Discord interaction, delete the pending
   row.

Failure modes:

- IP not available after 5 retries → log warning, skip. Next state change
  will retry; meanwhile the task is up but unreachable by DNS.
- Route 53 / ALB call fails → log, continue. The STOPPED path is
  eventually consistent because the watchdog cleans up too.
- Pending row missing (expired / never written / `stop` flow) → skip the
  Discord PATCH; no user-visible issue.
- Discord PATCH fails (stale token) → log, continue.

## watchdog

| | |
|---|---|
| **Package** | `@hyveon/lambda-watchdog` |
| **Trigger** | EventBridge schedule at `rate(${watchdog_interval_minutes} minute(s))`. No event payload. |
| **Terraform** | `terraform/aws/watchdog.tf`. |
| **IAM** | `ecs:ListTasks` / `DescribeTasks` / `StopTask` / `TagResource` / `ListTagsForResource`, `cloudwatch:GetMetricStatistics`, `route53:ChangeResourceRecordSets` / `ListResourceRecordSets`, `elasticloadbalancing:DeregisterTargets`, `ec2:DescribeNetworkInterfaces`. |
| **Env vars** | `ECS_CLUSTER`, `HOSTED_ZONE_ID`, `DOMAIN_NAME`, `GAME_NAMES`, `IDLE_CHECKS`, `MIN_PACKETS`, `CHECK_WINDOW_MINUTES`, `AWS_REGION_`, `HTTPS_GAMES`, `ALB_TARGET_GROUPS`. |

### Behaviour

1. `ListTasks(desiredStatus: RUNNING)` across the cluster. Paginates.
2. `DescribeTasks` on the batch to get attachments and tags.
3. For each task:
   - Resolve the ENI ID from attachments.
   - `cloudwatch.GetMetricStatistics` → `AWS/EC2/NetworkPacketsIn` over
     the last `CHECK_WINDOW_MINUTES`. If the call fails, assume **active**
     (fails-safe for fresh tasks with no metrics yet).
   - If `packets < MIN_PACKETS`:
     - Increment the `idle_checks` tag.
     - If the counter reaches `IDLE_CHECKS`:
       - HTTPS game → `DeregisterTargets`.
       - Direct game → delete the Route 53 record.
       - `StopTask` with reason `Watchdog: idle for {N} minutes`.
     - Otherwise persist the incremented counter via `TagResource`.
   - Else (active), if the counter is non-zero, reset it to 0.

Watchdog state lives **only** in the `idle_checks` ECS task tag. It's
inherently scoped to the task — when the task goes away, so does the
state, which is exactly what we want. Do not move it to DDB/SSM.

Failure modes:

- CloudWatch query fails → treated as active (no accidental shutdowns).
- Tagging fails → logged; a task might hang around a cycle longer than
  intended.
- `StopTask` fails → logged; next schedule tick retries.

## The `/server-start` critical path, assembled

```text
User types /server-start palworld
  → Discord POSTs to interactions Function URL
    → interactions verifies + returns type:5 ack + async-invokes followup
      → followup RunTask + put PENDING#{arn} + PATCH @original "starting"
        → ECS reaches RUNNING
          → EventBridge fires update-dns
            → update-dns resolves IP + UPSERT A + get+delete PENDING#{arn}
              + PATCH @original "🟢 running — palworld.example.com"
```

Every Lambda has its own CloudWatch log group; when a step goes wrong, the
group with the latest events is the one that last ran. The interactions
Lambda logs the `async invoke of followup` line; if you see that but no
followup logs, check IAM.
