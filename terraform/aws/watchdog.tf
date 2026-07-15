# ──────────────────────────────────────────────────────────────────────────────
# Watchdog Lambda — auto-shuts down idle game servers (Node.js, packaged from
# ../app/packages/lambda/watchdog).
#
# Runs on a configurable schedule (default every 15 minutes). For each running
# task it:
#   1. Reads CloudWatch NetworkPacketsIn on the task's ENI.
#   2. If packets < watchdog_min_packets → increments idle_checks ECS task tag.
#   3. After watchdog_idle_checks consecutive idle checks → stops the task and
#      removes the Route 53 record (or deregisters from the ALB for HTTPS games).
#
# Total idle grace period = watchdog_interval_minutes × watchdog_idle_checks.
# ──────────────────────────────────────────────────────────────────────────────

data "archive_file" "watchdog" {
  type        = "zip"
  source_file = "${path.module}/../../app/packages/lambda/watchdog/dist/handler.cjs"
  output_path = "${path.module}/../../app/packages/lambda/watchdog/dist/bundle.zip"
}

resource "aws_iam_role" "watchdog_lambda" {
  name = "${var.project_name}-watchdog-lambda"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Action    = "sts:AssumeRole"
      Effect    = "Allow"
      Principal = { Service = "lambda.amazonaws.com" }
    }]
  })
}

resource "aws_iam_role_policy" "watchdog_lambda" {
  name = "${var.project_name}-watchdog-lambda-policy"
  role = aws_iam_role.watchdog_lambda.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect   = "Allow"
        Action   = ["logs:CreateLogGroup", "logs:CreateLogStream", "logs:PutLogEvents"]
        Resource = "arn:aws:logs:*:*:*"
      },
      {
        Effect = "Allow"
        Action = [
          "ecs:ListTasks",
          "ecs:DescribeTasks",
          "ecs:StopTask",
          "ecs:TagResource",
          "ecs:ListTagsForResource",
        ]
        Resource = "*"
      },
      {
        Effect   = "Allow"
        Action   = ["ec2:DescribeNetworkInterfaces"]
        Resource = "*"
      },
      {
        Effect   = "Allow"
        Action   = ["cloudwatch:GetMetricStatistics"]
        Resource = "*"
      },
      {
        Effect = "Allow"
        Action = [
          "route53:ChangeResourceRecordSets",
          "route53:ListResourceRecordSets",
        ]
        Resource = [
          "arn:aws:route53:::hostedzone/${data.aws_route53_zone.main.zone_id}",
          "arn:aws:route53:::change/*",
        ]
      },
      {
        Effect = "Allow"
        Action = [
          "elasticloadbalancing:DeregisterTargets",
          "elasticloadbalancing:DescribeTargetHealth",
        ]
        Resource = "*"
      },
    ]
  })
}

resource "aws_lambda_function" "watchdog" {
  function_name    = "${var.project_name}-watchdog"
  role             = aws_iam_role.watchdog_lambda.arn
  handler          = "handler.handler"
  runtime          = "nodejs20.x"
  filename         = data.archive_file.watchdog.output_path
  source_code_hash = data.archive_file.watchdog.output_base64sha256
  timeout          = 60

  environment {
    variables = {
      ECS_CLUSTER          = aws_ecs_cluster.main.name
      HOSTED_ZONE_ID       = data.aws_route53_zone.main.zone_id
      DOMAIN_NAME          = var.hosted_zone_name
      GAME_NAMES           = join(",", keys(var.game_servers))
      IDLE_CHECKS          = tostring(var.watchdog_idle_checks)
      MIN_PACKETS          = tostring(var.watchdog_min_packets)
      CHECK_WINDOW_MINUTES = tostring(var.watchdog_interval_minutes)
      AWS_REGION_          = var.aws_region
      HTTPS_GAMES          = join(",", keys(local.https_games))
      ALB_TARGET_GROUPS    = jsonencode({ for name, _ in local.https_games : name => aws_lb_target_group.game[name].arn })
    }
  }

  tags = { Name = "${var.project_name}-watchdog" }

  depends_on = [aws_iam_role_policy.watchdog_lambda]
}

resource "aws_cloudwatch_log_group" "watchdog" {
  name              = "/aws/lambda/${var.project_name}-watchdog"
  retention_in_days = 7
  tags              = { Name = "${var.project_name}-watchdog-logs" }
}

# EventBridge schedule — triggers watchdog on the configured interval
resource "aws_cloudwatch_event_rule" "watchdog_schedule" {
  name        = "${var.project_name}-watchdog-schedule"
  description = "Check for idle game servers every ${var.watchdog_interval_minutes} minute(s)"
  # rate(1 minute) or rate(N minutes) — singular vs plural matters
  schedule_expression = "rate(${var.watchdog_interval_minutes} ${var.watchdog_interval_minutes == 1 ? "minute" : "minutes"})"
}

resource "aws_cloudwatch_event_target" "watchdog" {
  rule      = aws_cloudwatch_event_rule.watchdog_schedule.name
  target_id = "GameServerWatchdog"
  arn       = aws_lambda_function.watchdog.arn
}

resource "aws_lambda_permission" "watchdog_eventbridge" {
  statement_id  = "AllowWatchdogEventBridge"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.watchdog.function_name
  principal     = "events.amazonaws.com"
  source_arn    = aws_cloudwatch_event_rule.watchdog_schedule.arn
}
