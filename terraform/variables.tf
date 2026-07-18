variable "active_cloud" {
  description = "Cloud provider backing this deployment. Only \"aws\" is currently supported."
  type        = string
  default     = "aws"

  validation {
    condition     = var.active_cloud == "aws"
    error_message = "active_cloud must be \"aws\" — no other cloud providers are supported yet."
  }
}

variable "aws_region" {
  description = "AWS region to deploy into"
  type        = string
  default     = "us-east-1"
}

variable "project_name" {
  description = "Project name used for resource naming"
  type        = string
  default     = "hyveon"
}

variable "vpc_cidr" {
  description = "CIDR block for the VPC"
  type        = string
  default     = "10.0.0.0/16"
}

# ── Game server definitions ──────────────────────────────────────────────────
# Each entry creates its own ECS task definition, EFS access point, log group,
# and security group rules. Add new games here without touching anything else.

variable "game_servers" {
  description = "Map of game name → container config"
  type = map(object({
    image           = string
    cpu             = number # Fargate CPU units (1024 = 1 vCPU)
    memory          = number # MiB
    ports           = list(object({ container = number, protocol = string }))
    environment     = optional(list(object({ name = string, value = string })), [])
    volumes         = list(object({ name = string, container_path = string }))
    https           = optional(bool, false) # If true, traffic is routed through ALB with TLS termination
    connect_message = optional(string)      # Discord connect hint; supports {host}, {ip}, {port}, {game} placeholders
    file_seeds = optional(list(object({
      path           = string                   # In-container path, e.g. "/palworld/Pal/Saved/Config/LinuxServer/PalWorldSettings.ini"
      content        = optional(string)         # UTF-8 text content
      content_base64 = optional(string)         # Base64-encoded binary content (for non-UTF-8 files such as mods)
      mode           = optional(string, "0644") # chmod octal string
    })), [])
  }))

  validation {
    condition = alltrue([
      for cfg in values(var.game_servers) :
      length(cfg.volumes) > 0 && alltrue([
        for v in cfg.volumes : length(v.name) > 0 && length(v.container_path) > 0
      ])
    ])
    error_message = "Each game server must have at least one volume entry with non-empty name and container_path."
  }
}

# ── HTTPS / ALB ─────────────────────────────────────────────────────────────

variable "acm_certificate_domain" {
  description = "Domain for the ACM TLS certificate used by the ALB (e.g. *.example.com). Defaults to *.{hosted_zone_name} when null."
  type        = string
  default     = null # When null, defaults to *.{hosted_zone_name}
}

# ── Watchdog tuning ──────────────────────────────────────────────────────────

variable "watchdog_interval_minutes" {
  description = "How often the watchdog checks for idle servers (minutes)"
  type        = number
  default     = 15
}

variable "watchdog_idle_checks" {
  description = "Consecutive idle checks before auto-shutdown (total idle time = interval × checks)"
  type        = number
  default     = 4
}

variable "watchdog_min_packets" {
  description = "Minimum inbound packets per check interval to consider a server active"
  type        = number
  default     = 100
}

# ── DNS ──────────────────────────────────────────────────────────────────────

variable "hosted_zone_name" {
  description = "Route 53 hosted zone domain (must already exist, e.g. example.com)"
  type        = string
}

variable "dns_ttl" {
  description = "TTL in seconds for DNS A records — keep low so updates propagate fast"
  type        = number
  default     = 30
}

# ── Discord base allowlist / admins (optional) ───────────────────────────────
# These lists are Terraform-managed and written to a separate DynamoDB row
# (BASE#discord) on every `terraform apply`. They form an immutable floor that
# the management UI can never remove — operators can only add/remove entries
# they themselves added via the UI.
#
# Leave all three empty (the default) to manage everything through the UI.
# Edit the lists in terraform.tfvars and re-apply to change the base set.

variable "base_allowed_guilds" {
  description = "Guild IDs permanently allowlisted by Terraform. Cannot be removed via the management UI."
  type        = list(string)
  default     = []
}

variable "base_admin_user_ids" {
  description = "Discord user IDs with permanent server-wide admin privileges. Cannot be removed via the management UI."
  type        = list(string)
  default     = []
}

variable "base_admin_role_ids" {
  description = "Discord role IDs with permanent server-wide admin privileges. Cannot be removed via the management UI."
  type        = list(string)
  default     = []
}

# ── Discord bot credentials (optional) ───────────────────────────────────────
# If set, these seed the AWS Secrets Manager secrets on first `terraform apply`
# so the bot is fully configured without touching the web UI. Leave empty to
# seed the secrets with a placeholder value and enter credentials via the
# Credentials tab in the management app instead.
#
# After the first apply, Terraform no longer touches `secret_string`
# (`ignore_changes = [secret_string]` in discord_store.tf) so edits made via
# the web UI won't be overwritten on subsequent applies. To rotate a value
# via Terraform after initial provisioning, update the variable and run
# `terraform taint aws_secretsmanager_secret_version.<name>` first.
#
# terraform.tfvars is gitignored, so it's safe to put these values there.

variable "discord_application_id" {
  description = "Discord application (client) ID — public value, goes to DynamoDB. Optional; empty to configure via UI."
  type        = string
  default     = ""
}

variable "discord_bot_token" {
  description = "Discord bot token (from Developer Portal → your app → Bot). Optional; empty to configure via UI."
  type        = string
  default     = ""
  sensitive   = true
}

variable "discord_public_key" {
  description = "Discord application Ed25519 public key (from General Information). Optional; empty to configure via UI."
  type        = string
  default     = ""
  sensitive   = true
}

# ── Audit log ────────────────────────────────────────────────────────────────

variable "audit_table_name" {
  description = "Name of the DynamoDB audit log table. Defaults to \"$${project_name}-audit\" when empty."
  type        = string
  default     = ""
}

# ── Bootstrap ─────────────────────────────────────────────────────────────────

variable "tfvars_bucket_name" {
  description = "Name of the versioned S3 bucket created by the bootstrap module to hold terraform.tfvars. Defaults to \"$${project_name}-tfvars\" when null."
  type        = string
  default     = null
}

# ── Tags ─────────────────────────────────────────────────────────────────────

variable "tags" {
  description = "Common tags applied to all resources"
  type        = map(string)
  default = {
    Project     = "hyveon"
    Environment = "poc"
    ManagedBy   = "terraform"
  }
}
