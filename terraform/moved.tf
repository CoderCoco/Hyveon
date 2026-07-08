# Resource addresses moved from the root module into ./aws when the AWS-specific
# HCL was split out (issue #185). Keeps existing deployed state mapped to its new
# address instead of terraform proposing destroy/recreate of the whole stack.

# ── alb.tf ──
moved {
  from = aws_acm_certificate.game_servers
  to   = module.cloud.aws_acm_certificate.game_servers
}

moved {
  from = aws_route53_record.acm_validation
  to   = module.cloud.aws_route53_record.acm_validation
}

moved {
  from = aws_acm_certificate_validation.game_servers
  to   = module.cloud.aws_acm_certificate_validation.game_servers
}

moved {
  from = aws_security_group.alb
  to   = module.cloud.aws_security_group.alb
}

moved {
  from = aws_lb.game_servers
  to   = module.cloud.aws_lb.game_servers
}

moved {
  from = aws_lb_listener.https
  to   = module.cloud.aws_lb_listener.https
}

moved {
  from = aws_lb_listener.http_redirect
  to   = module.cloud.aws_lb_listener.http_redirect
}

moved {
  from = aws_lb_target_group.game
  to   = module.cloud.aws_lb_target_group.game
}

moved {
  from = aws_lb_listener_rule.game
  to   = module.cloud.aws_lb_listener_rule.game
}

moved {
  from = aws_route53_record.https_game
  to   = module.cloud.aws_route53_record.https_game
}

# ── discord-domain.tf ──
moved {
  from = aws_acm_certificate.discord
  to   = module.cloud.aws_acm_certificate.discord
}

moved {
  from = aws_route53_record.discord_acm_validation
  to   = module.cloud.aws_route53_record.discord_acm_validation
}

moved {
  from = aws_acm_certificate_validation.discord
  to   = module.cloud.aws_acm_certificate_validation.discord
}

moved {
  from = aws_cloudfront_distribution.discord
  to   = module.cloud.aws_cloudfront_distribution.discord
}

moved {
  from = aws_route53_record.discord
  to   = module.cloud.aws_route53_record.discord
}

moved {
  from = aws_route53_record.discord_aaaa
  to   = module.cloud.aws_route53_record.discord_aaaa
}

# ── discord_store.tf ──
moved {
  from = aws_dynamodb_table.discord
  to   = module.cloud.aws_dynamodb_table.discord
}

moved {
  from = aws_secretsmanager_secret.discord_bot_token
  to   = module.cloud.aws_secretsmanager_secret.discord_bot_token
}

moved {
  from = aws_secretsmanager_secret_version.discord_bot_token
  to   = module.cloud.aws_secretsmanager_secret_version.discord_bot_token
}

moved {
  from = aws_secretsmanager_secret.discord_public_key
  to   = module.cloud.aws_secretsmanager_secret.discord_public_key
}

moved {
  from = aws_secretsmanager_secret_version.discord_public_key
  to   = module.cloud.aws_secretsmanager_secret_version.discord_public_key
}

moved {
  from = terraform_data.discord_register_commands
  to   = module.cloud.terraform_data.discord_register_commands
}

moved {
  from = aws_dynamodb_table_item.discord_base_config
  to   = module.cloud.aws_dynamodb_table_item.discord_base_config
}

moved {
  from = aws_dynamodb_table_item.discord_config_seed
  to   = module.cloud.aws_dynamodb_table_item.discord_config_seed
}

# ── efs-seeder.tf ──
moved {
  from = aws_security_group.efs_seeder
  to   = module.cloud.aws_security_group.efs_seeder
}

moved {
  from = aws_iam_role.efs_seeder
  to   = module.cloud.aws_iam_role.efs_seeder
}

moved {
  from = aws_iam_role_policy.efs_seeder
  to   = module.cloud.aws_iam_role_policy.efs_seeder
}

moved {
  from = aws_cloudwatch_log_group.efs_seeder
  to   = module.cloud.aws_cloudwatch_log_group.efs_seeder
}

moved {
  from = aws_lambda_function.efs_seeder
  to   = module.cloud.aws_lambda_function.efs_seeder
}

moved {
  from = aws_lambda_invocation.efs_seeder
  to   = module.cloud.aws_lambda_invocation.efs_seeder
}

# ── followup.tf ──
moved {
  from = aws_iam_role.followup_lambda
  to   = module.cloud.aws_iam_role.followup_lambda
}

moved {
  from = aws_iam_role_policy.followup_lambda
  to   = module.cloud.aws_iam_role_policy.followup_lambda
}

moved {
  from = aws_lambda_function.followup
  to   = module.cloud.aws_lambda_function.followup
}

moved {
  from = aws_cloudwatch_log_group.followup
  to   = module.cloud.aws_cloudwatch_log_group.followup
}

# ── interactions.tf ──
moved {
  from = aws_iam_role.interactions_lambda
  to   = module.cloud.aws_iam_role.interactions_lambda
}

moved {
  from = aws_iam_role_policy.interactions_lambda
  to   = module.cloud.aws_iam_role_policy.interactions_lambda
}

moved {
  from = aws_lambda_function.interactions
  to   = module.cloud.aws_lambda_function.interactions
}

moved {
  from = aws_cloudwatch_log_group.interactions
  to   = module.cloud.aws_cloudwatch_log_group.interactions
}

moved {
  from = aws_lambda_function_url.interactions
  to   = module.cloud.aws_lambda_function_url.interactions
}

moved {
  from = aws_lambda_permission.interactions_url_invoke_url
  to   = module.cloud.aws_lambda_permission.interactions_url_invoke_url
}

moved {
  from = aws_lambda_permission.interactions_url_invoke
  to   = module.cloud.aws_lambda_permission.interactions_url_invoke
}

# ── main.tf ──
moved {
  from = aws_vpc.main
  to   = module.cloud.aws_vpc.main
}

moved {
  from = aws_internet_gateway.main
  to   = module.cloud.aws_internet_gateway.main
}

moved {
  from = aws_subnet.public
  to   = module.cloud.aws_subnet.public
}

moved {
  from = aws_route_table.public
  to   = module.cloud.aws_route_table.public
}

moved {
  from = aws_route_table_association.public
  to   = module.cloud.aws_route_table_association.public
}

moved {
  from = aws_security_group.game_servers
  to   = module.cloud.aws_security_group.game_servers
}

moved {
  from = aws_security_group.file_manager
  to   = module.cloud.aws_security_group.file_manager
}

moved {
  from = aws_security_group.efs
  to   = module.cloud.aws_security_group.efs
}

moved {
  from = aws_efs_file_system.saves
  to   = module.cloud.aws_efs_file_system.saves
}

moved {
  from = aws_efs_mount_target.saves
  to   = module.cloud.aws_efs_mount_target.saves
}

moved {
  from = aws_efs_access_point.game
  to   = module.cloud.aws_efs_access_point.game
}

moved {
  from = aws_cloudwatch_log_group.game
  to   = module.cloud.aws_cloudwatch_log_group.game
}

moved {
  from = aws_iam_role.ecs_task_execution
  to   = module.cloud.aws_iam_role.ecs_task_execution
}

moved {
  from = aws_iam_role_policy_attachment.ecs_task_execution
  to   = module.cloud.aws_iam_role_policy_attachment.ecs_task_execution
}

moved {
  from = aws_ecs_cluster.main
  to   = module.cloud.aws_ecs_cluster.main
}

moved {
  from = aws_ecs_task_definition.game
  to   = module.cloud.aws_ecs_task_definition.game
}

# ── route53.tf ──
moved {
  from = aws_iam_role.dns_updater_lambda
  to   = module.cloud.aws_iam_role.dns_updater_lambda
}

moved {
  from = aws_iam_role_policy.dns_updater_lambda
  to   = module.cloud.aws_iam_role_policy.dns_updater_lambda
}

moved {
  from = aws_lambda_function.dns_updater
  to   = module.cloud.aws_lambda_function.dns_updater
}

moved {
  from = aws_cloudwatch_log_group.dns_updater
  to   = module.cloud.aws_cloudwatch_log_group.dns_updater
}

moved {
  from = aws_cloudwatch_event_rule.ecs_task_change
  to   = module.cloud.aws_cloudwatch_event_rule.ecs_task_change
}

moved {
  from = aws_cloudwatch_event_target.dns_updater
  to   = module.cloud.aws_cloudwatch_event_target.dns_updater
}

moved {
  from = aws_lambda_permission.dns_updater_eventbridge
  to   = module.cloud.aws_lambda_permission.dns_updater_eventbridge
}

# ── watchdog.tf ──
moved {
  from = aws_iam_role.watchdog_lambda
  to   = module.cloud.aws_iam_role.watchdog_lambda
}

moved {
  from = aws_iam_role_policy.watchdog_lambda
  to   = module.cloud.aws_iam_role_policy.watchdog_lambda
}

moved {
  from = aws_lambda_function.watchdog
  to   = module.cloud.aws_lambda_function.watchdog
}

moved {
  from = aws_cloudwatch_log_group.watchdog
  to   = module.cloud.aws_cloudwatch_log_group.watchdog
}

moved {
  from = aws_cloudwatch_event_rule.watchdog_schedule
  to   = module.cloud.aws_cloudwatch_event_rule.watchdog_schedule
}

moved {
  from = aws_cloudwatch_event_target.watchdog
  to   = module.cloud.aws_cloudwatch_event_target.watchdog
}

moved {
  from = aws_lambda_permission.watchdog_eventbridge
  to   = module.cloud.aws_lambda_permission.watchdog_eventbridge
}

