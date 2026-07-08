output "vpc_id" {
  description = "VPC ID"
  value       = aws_vpc.main.id
}

output "ecs_cluster_name" {
  description = "ECS cluster name"
  value       = aws_ecs_cluster.main.name
}

output "ecs_cluster_arn" {
  description = "ECS cluster ARN"
  value       = aws_ecs_cluster.main.arn
}

output "subnet_ids" {
  description = "Public subnet IDs (comma-separated for Lambda env vars)"
  value       = join(",", aws_subnet.public[*].id)
}

output "security_group_id" {
  description = "Security group ID for game server tasks"
  value       = aws_security_group.game_servers.id
}

output "efs_file_system_id" {
  description = "EFS file system ID for persistent game saves"
  value       = aws_efs_file_system.saves.id
}

output "game_names" {
  description = "List of configured game server names"
  value       = keys(var.game_servers)
}

output "task_definitions" {
  description = "Map of game name → ECS task definition family name"
  value       = { for game, _ in var.game_servers : game => "${game}-server" }
}

output "hosted_zone_id" {
  description = "Route 53 hosted zone ID"
  value       = data.aws_route53_zone.main.zone_id
}

output "domain_name" {
  description = "Base domain name"
  value       = var.hosted_zone_name
}

output "aws_region" {
  description = "AWS region"
  value       = var.aws_region
}

output "file_manager_security_group_id" {
  description = "Security group ID for FileBrowser file manager tasks"
  value       = aws_security_group.file_manager.id
}

output "efs_access_points" {
  description = "Map of game name → first volume's EFS access point ID (consumed by FileManagerService)"
  value = {
    for game, cfg in var.game_servers :
    game => aws_efs_access_point.game["${game}-${cfg.volumes[0].name}"].id
  }
}

output "alb_dns_name" {
  description = "ALB DNS name (only when HTTPS games exist)"
  value       = local.enable_alb ? aws_lb.game_servers[0].dns_name : null
}

output "acm_certificate_arn" {
  description = "ACM certificate ARN (only when HTTPS games exist)"
  value       = local.enable_alb ? aws_acm_certificate.game_servers[0].arn : null
}

# ── Discord serverless outputs ───────────────────────────────────────────────

output "discord_table_name" {
  description = "DynamoDB table holding DiscordConfig + pending interactions"
  value       = aws_dynamodb_table.discord.name
}

output "discord_bot_token_secret_arn" {
  description = "Secrets Manager ARN for the Discord bot token"
  value       = aws_secretsmanager_secret.discord_bot_token.arn
}

output "discord_public_key_secret_arn" {
  description = "Secrets Manager ARN for the Discord application Ed25519 public key"
  value       = aws_secretsmanager_secret.discord_public_key.arn
}
