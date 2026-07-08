output "vpc_id" {
  description = "VPC ID"
  value       = module.cloud.vpc_id
}

output "ecs_cluster_name" {
  description = "ECS cluster name"
  value       = module.cloud.ecs_cluster_name
}

output "ecs_cluster_arn" {
  description = "ECS cluster ARN"
  value       = module.cloud.ecs_cluster_arn
}

output "subnet_ids" {
  description = "Public subnet IDs (comma-separated for Lambda env vars)"
  value       = module.cloud.subnet_ids
}

output "security_group_id" {
  description = "Security group ID for game server tasks"
  value       = module.cloud.security_group_id
}

output "efs_file_system_id" {
  description = "EFS file system ID for persistent game saves"
  value       = module.cloud.efs_file_system_id
}

output "game_names" {
  description = "List of configured game server names"
  value       = module.cloud.game_names
}

output "task_definitions" {
  description = "Map of game name → ECS task definition family name"
  value       = module.cloud.task_definitions
}

output "hosted_zone_id" {
  description = "Route 53 hosted zone ID"
  value       = module.cloud.hosted_zone_id
}

output "domain_name" {
  description = "Base domain name"
  value       = module.cloud.domain_name
}

output "aws_region" {
  description = "AWS region"
  value       = module.cloud.aws_region
}

output "file_manager_security_group_id" {
  description = "Security group ID for FileBrowser file manager tasks"
  value       = module.cloud.file_manager_security_group_id
}

output "efs_access_points" {
  description = "Map of game name → first volume's EFS access point ID (consumed by FileManagerService)"
  value       = module.cloud.efs_access_points
}

output "alb_dns_name" {
  description = "ALB DNS name (only when HTTPS games exist)"
  value       = module.cloud.alb_dns_name
}

output "acm_certificate_arn" {
  description = "ACM certificate ARN (only when HTTPS games exist)"
  value       = module.cloud.acm_certificate_arn
}

# ── Discord serverless outputs ───────────────────────────────────────────────

output "discord_table_name" {
  description = "DynamoDB table holding DiscordConfig + pending interactions"
  value       = module.cloud.discord_table_name
}

output "discord_bot_token_secret_arn" {
  description = "Secrets Manager ARN for the Discord bot token"
  value       = module.cloud.discord_bot_token_secret_arn
}

output "discord_public_key_secret_arn" {
  description = "Secrets Manager ARN for the Discord application Ed25519 public key"
  value       = module.cloud.discord_public_key_secret_arn
}

output "interactions_invoke_url" {
  description = "Paste this into the 'Interactions Endpoint URL' field in the Discord Developer Portal"
  value       = module.cloud.interactions_invoke_url
}

output "discord_interactions_url" {
  description = "Custom domain URL for the Discord interactions endpoint"
  value       = module.cloud.discord_interactions_url
}

output "dns_records" {
  description = "DNS hostnames for each game server (active when server is running)"
  value       = module.cloud.dns_records
}

output "watchdog_function_name" {
  description = "Watchdog Lambda function name"
  value       = module.cloud.watchdog_function_name
}
