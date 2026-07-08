# ──────────────────────────────────────────────────────────────────────────────
# Discord serverless backing stores
#
# - DynamoDB: pay-per-request table holding two item types:
#     pk = "CONFIG#discord", sk = "CONFIG"        → DiscordConfig JSON
#     pk = "PENDING#{taskArn}", sk = "PENDING"    → pending interaction (TTL)
# - Secrets Manager: bot token (used by the Nest app to register guild
#   commands) and the Ed25519 application public key (used by the
#   InteractionsLambda for request signature verification).
#
# Secret values default to a "placeholder" string so the secret has a version
# on first apply; operators can either (a) set `discord_bot_token` and
# `discord_public_key` in tfvars to seed with real values up-front, or (b)
# leave them empty and enter credentials through the Credentials tab in the
# web UI. The shared secretsStore treats "placeholder" and empty strings as
# "not configured", so either path is safe.
#
# `ignore_changes = [secret_string]` below means Terraform only writes the
# secret on initial creation. Subsequent UI edits (or rotations done via
# `aws secretsmanager put-secret-value`) aren't reverted on re-apply.
#
# `recovery_window_in_days = 0` forces immediate deletion on `terraform
# destroy`. Without this, AWS schedules secrets for deletion with a 30-day
# recovery window, which blocks a subsequent `terraform apply` from recreating
# a secret with the same name (InvalidRequestException: "already scheduled for
# deletion"). These secrets only ever hold Discord credentials the operator
# can re-enter via the UI, so the recovery window has no real value here.
# ──────────────────────────────────────────────────────────────────────────────

resource "aws_dynamodb_table" "discord" {
  name         = "${var.project_name}-discord"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "pk"
  range_key    = "sk"

  attribute {
    name = "pk"
    type = "S"
  }
  attribute {
    name = "sk"
    type = "S"
  }

  ttl {
    attribute_name = "expiresAt"
    enabled        = true
  }

  point_in_time_recovery {
    enabled = false
  }

  tags = { Name = "${var.project_name}-discord" }
}

resource "aws_secretsmanager_secret" "discord_bot_token" {
  name                    = "${var.project_name}/discord/bot-token"
  description             = "Discord bot token — used by the management app to register guild slash commands"
  recovery_window_in_days = 0
}

resource "aws_secretsmanager_secret_version" "discord_bot_token" {
  secret_id     = aws_secretsmanager_secret.discord_bot_token.id
  secret_string = var.discord_bot_token != "" ? var.discord_bot_token : "placeholder"

  lifecycle {
    ignore_changes = [secret_string]
  }
}

resource "aws_secretsmanager_secret" "discord_public_key" {
  name                    = "${var.project_name}/discord/public-key"
  description             = "Discord application Ed25519 public key — used by InteractionsLambda for signature verification"
  recovery_window_in_days = 0
}

resource "aws_secretsmanager_secret_version" "discord_public_key" {
  secret_id     = aws_secretsmanager_secret.discord_public_key.id
  secret_string = var.discord_public_key != "" ? var.discord_public_key : "placeholder"

  lifecycle {
    ignore_changes = [secret_string]
  }
}

# ─ Discord config row (optional) ─────────────────────────────────────────────
# Seeds the CONFIG#discord row in DynamoDB with the application ID if
# `discord_application_id` is set in tfvars. The app ID isn't a secret so it
# doesn't belong in Secrets Manager; it lives in the same row the UI edits to
# store allowedGuilds / admins / gamePermissions.
#
# `ignore_changes = [item]` means Terraform only writes this row on the first
# apply — subsequent UI edits (which overwrite the whole row via PutItem) are
# invisible to Terraform and won't be reverted. To rotate via tfvars after
# the initial provision, run `terraform taint aws_dynamodb_table_item.discord_config_seed`
# first.
#
# When `discord_application_id` is empty the resource is skipped entirely so
# the UI creates the row on first save — avoids a stray empty row on UI-only
# deployments.

# ─ Discord base config row ────────────────────────────────────────────────────
# Written on every `terraform apply` when any base list is non-empty. Unlike the
# config seed below, there is NO `ignore_changes` — re-applying after editing
# the variables always updates this row. The management app merges this row with
# the dynamic CONFIG#discord row; entries here can never be removed via the UI.
#
# The resource is skipped entirely when all three lists are empty so a
# UI-only deployment doesn't end up with a stray empty row.

# ─ Slash-command descriptors ──────────────────────────────────────────────────
# Must be kept in sync with COMMAND_DESCRIPTORS in
# app/packages/shared/src/commands.ts. The sha256 of this value is used as a
# trigger so `null_resource.discord_register_commands` re-runs whenever the
# command set changes.
locals {
  discord_command_descriptors = jsonencode([
    {
      name        = "server-start"
      description = "Start a game server"
      options = [{
        type         = 3
        name         = "game"
        description  = "Game to start"
        required     = true
        autocomplete = true
      }]
    },
    {
      name        = "server-stop"
      description = "Stop a running game server"
      options = [{
        type         = 3
        name         = "game"
        description  = "Game to stop"
        required     = true
        autocomplete = true
      }]
    },
    {
      name        = "server-status"
      description = "Show status of a game server (or all if omitted)"
      options = [{
        type         = 3
        name         = "game"
        description  = "Game to check"
        required     = false
        autocomplete = true
      }]
    },
    {
      name        = "server-list"
      description = "List all configured game servers and their state"
    }
  ])
}

# ─ Auto-register slash commands ───────────────────────────────────────────────
# When discord_bot_token, discord_application_id, and base_allowed_guilds are
# all set, this registers the slash commands in each base guild during
# `terraform apply`. Re-runs whenever the application ID, token, or command
# descriptors change (tracked via triggers_replace). Guilds added later via the
# management UI still require the "Register commands" button in the Guilds tab.
#
# Uses terraform_data (built into Terraform ≥1.4; no extra provider needed).
# The bot token is passed via environment variable (not a shell argument) so it
# never appears in the process list. nonsensitive() is required because
# sensitive values are not permitted in for_each or trigger keys.
resource "terraform_data" "discord_register_commands" {
  for_each = (nonsensitive(var.discord_bot_token) != "" && var.discord_application_id != "") ? toset(var.base_allowed_guilds) : toset([])

  triggers_replace = {
    application_id    = var.discord_application_id
    guild_id          = each.value
    token_hash        = sha256(nonsensitive(var.discord_bot_token))
    commands_checksum = sha256(local.discord_command_descriptors)
  }

  provisioner "local-exec" {
    command = <<-EOT
      curl -sSf -X PUT \
        "https://discord.com/api/v10/applications/${var.discord_application_id}/guilds/${each.value}/commands" \
        -H "Authorization: Bot $DISCORD_BOT_TOKEN" \
        -H "Content-Type: application/json" \
        -d '${local.discord_command_descriptors}'
    EOT
    environment = {
      DISCORD_BOT_TOKEN = var.discord_bot_token
    }
  }

  depends_on = [
    aws_dynamodb_table_item.discord_base_config,
    aws_secretsmanager_secret_version.discord_bot_token,
  ]
}

resource "aws_dynamodb_table_item" "discord_base_config" {
  count = (length(var.base_allowed_guilds) + length(var.base_admin_user_ids) + length(var.base_admin_role_ids)) > 0 ? 1 : 0

  table_name = aws_dynamodb_table.discord.name
  hash_key   = aws_dynamodb_table.discord.hash_key
  range_key  = aws_dynamodb_table.discord.range_key

  item = jsonencode({
    pk = { S = "BASE#discord" }
    sk = { S = "BASE" }
    data = {
      M = {
        allowedGuilds = { L = [for g in var.base_allowed_guilds : { S = g }] }
        admins = {
          M = {
            userIds = { L = [for u in var.base_admin_user_ids : { S = u }] }
            roleIds = { L = [for r in var.base_admin_role_ids : { S = r }] }
          }
        }
      }
    }
    updatedAt = { N = "0" }
  })
}

resource "aws_dynamodb_table_item" "discord_config_seed" {
  count = var.discord_application_id != "" ? 1 : 0

  table_name = aws_dynamodb_table.discord.name
  hash_key   = aws_dynamodb_table.discord.hash_key
  range_key  = aws_dynamodb_table.discord.range_key

  item = jsonencode({
    pk = { S = "CONFIG#discord" }
    sk = { S = "CONFIG" }
    data = {
      M = {
        clientId      = { S = var.discord_application_id }
        allowedGuilds = { L = [] }
        admins = {
          M = {
            userIds = { L = [] }
            roleIds = { L = [] }
          }
        }
        gamePermissions = { M = {} }
      }
    }
    updatedAt = { N = "0" }
  })

  lifecycle {
    ignore_changes = [item]
  }
}
