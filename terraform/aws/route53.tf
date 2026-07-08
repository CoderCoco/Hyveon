# ──────────────────────────────────────────────────────────────────────────────
# Route 53 — auto-updates {game}.codercoco.com when Fargate tasks start/stop
#
# Architecture:
#   ECS Task State Change (RUNNING/STOPPED)
#     → EventBridge rule
#       → DNS Updater Lambda (Node.js, packaged from ../app/packages/lambda/update-dns)
#         → Route 53 UPSERT (on RUNNING) or DELETE (on STOPPED)
#         → Discord webhook PATCH (when a pending interaction is in DynamoDB)
#
# One DNS record per game, managed entirely by the Lambda.
# Records are NOT managed by Terraform (lifecycle ignore_changes would fight
# the Lambda).
# ──────────────────────────────────────────────────────────────────────────────

# Look up the existing hosted zone
data "aws_route53_zone" "main" {
  name         = var.hosted_zone_name
  private_zone = false
}

# ── DNS Updater Lambda (Node.js) ──────────────────────────────────────────────

data "archive_file" "dns_updater" {
  type        = "zip"
  source_file = "${path.module}/../../app/packages/lambda/update-dns/dist/handler.cjs"
  output_path = "${path.module}/../../app/packages/lambda/update-dns/dist/bundle.zip"
}

resource "aws_iam_role" "dns_updater_lambda" {
  name = "${var.project_name}-dns-updater-lambda"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Action    = "sts:AssumeRole"
      Effect    = "Allow"
      Principal = { Service = "lambda.amazonaws.com" }
    }]
  })
}

resource "aws_iam_role_policy" "dns_updater_lambda" {
  name = "${var.project_name}-dns-updater-lambda-policy"
  role = aws_iam_role.dns_updater_lambda.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect   = "Allow"
        Action   = ["logs:CreateLogGroup", "logs:CreateLogStream", "logs:PutLogEvents"]
        Resource = "arn:aws:logs:*:*:*"
      },
      {
        Effect   = "Allow"
        Action   = ["ecs:DescribeTasks"]
        Resource = "*"
      },
      {
        Effect   = "Allow"
        Action   = ["ec2:DescribeNetworkInterfaces"]
        Resource = "*"
      },
      {
        Effect = "Allow"
        Action = [
          "route53:ChangeResourceRecordSets",
          "route53:ListResourceRecordSets",
          "route53:GetChange",
        ]
        Resource = [
          "arn:aws:route53:::hostedzone/${data.aws_route53_zone.main.zone_id}",
          "arn:aws:route53:::change/*",
        ]
      },
      {
        Effect = "Allow"
        Action = [
          "elasticloadbalancing:RegisterTargets",
          "elasticloadbalancing:DeregisterTargets",
          "elasticloadbalancing:DescribeTargetHealth",
        ]
        Resource = "*"
      },
      {
        # Pending-interaction lookup/delete for Discord followups
        Effect   = "Allow"
        Action   = ["dynamodb:GetItem", "dynamodb:DeleteItem"]
        Resource = aws_dynamodb_table.discord.arn
      },
    ]
  })
}

resource "aws_lambda_function" "dns_updater" {
  function_name    = "${var.project_name}-dns-updater"
  role             = aws_iam_role.dns_updater_lambda.arn
  handler          = "handler.handler"
  runtime          = "nodejs20.x"
  filename         = data.archive_file.dns_updater.output_path
  source_code_hash = data.archive_file.dns_updater.output_base64sha256
  timeout          = 60

  environment {
    variables = {
      HOSTED_ZONE_ID    = data.aws_route53_zone.main.zone_id
      DOMAIN_NAME       = var.hosted_zone_name
      GAME_NAMES        = join(",", keys(var.game_servers))
      DNS_TTL           = tostring(var.dns_ttl)
      AWS_REGION_       = var.aws_region
      HTTPS_GAMES       = join(",", keys(local.https_games))
      ALB_TARGET_GROUPS = jsonencode({ for name, _ in local.https_games : name => aws_lb_target_group.game[name].arn })
      TABLE_NAME        = aws_dynamodb_table.discord.name
      CONNECT_MESSAGES  = jsonencode({ for g, cfg in var.game_servers : g => cfg.connect_message if cfg.connect_message != null })
      GAME_PORTS        = jsonencode({ for g, cfg in var.game_servers : g => cfg.ports[0].container if length(cfg.ports) > 0 })
    }
  }

  tags = { Name = "${var.project_name}-dns-updater" }

  depends_on = [aws_iam_role_policy.dns_updater_lambda]
}

resource "aws_cloudwatch_log_group" "dns_updater" {
  name              = "/aws/lambda/${var.project_name}-dns-updater"
  retention_in_days = 7
  tags              = { Name = "${var.project_name}-dns-updater-logs" }
}

# ── EventBridge rule — ECS task state changes ─────────────────────────────────

resource "aws_cloudwatch_event_rule" "ecs_task_change" {
  name        = "${var.project_name}-task-state-change"
  description = "Triggers DNS update when any game server task starts or stops"

  event_pattern = jsonencode({
    source        = ["aws.ecs"]
    "detail-type" = ["ECS Task State Change"]
    detail = {
      clusterArn = [aws_ecs_cluster.main.arn]
      lastStatus = ["RUNNING", "STOPPED"]
    }
  })
}

resource "aws_cloudwatch_event_target" "dns_updater" {
  rule      = aws_cloudwatch_event_rule.ecs_task_change.name
  target_id = "GameServerDnsUpdater"
  arn       = aws_lambda_function.dns_updater.arn
}

resource "aws_lambda_permission" "dns_updater_eventbridge" {
  statement_id  = "AllowDnsUpdaterEventBridge"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.dns_updater.function_name
  principal     = "events.amazonaws.com"
  source_arn    = aws_cloudwatch_event_rule.ecs_task_change.arn
}
