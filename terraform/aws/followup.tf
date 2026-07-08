# ──────────────────────────────────────────────────────────────────────────────
# FollowupLambda — async-invoked by InteractionsLambda to do the slow ECS
# RunTask/StopTask work, then PATCH the original Discord interaction message
# (no bot token needed; Discord webhooks authenticate via the interaction
# token in the URL).
#
# For start commands, also writes a PendingInteraction row keyed by task ARN
# so the update-dns Lambda can later PATCH the same interaction with the
# resolved public IP/hostname when the task reaches RUNNING.
# ──────────────────────────────────────────────────────────────────────────────

data "archive_file" "followup" {
  type        = "zip"
  source_file = "${path.module}/../../app/packages/lambda/followup/dist/handler.cjs"
  output_path = "${path.module}/../../app/packages/lambda/followup/dist/bundle.zip"
}

resource "aws_iam_role" "followup_lambda" {
  name = "${var.project_name}-followup-lambda"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Action    = "sts:AssumeRole"
      Effect    = "Allow"
      Principal = { Service = "lambda.amazonaws.com" }
    }]
  })
}

resource "aws_iam_role_policy" "followup_lambda" {
  name = "${var.project_name}-followup-lambda-policy"
  role = aws_iam_role.followup_lambda.id

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
          "ecs:RunTask",
          "ecs:StopTask",
          "ecs:ListTasks",
          "ecs:DescribeTasks",
        ]
        Resource = "*"
      },
      {
        Effect   = "Allow"
        Action   = ["iam:PassRole"]
        Resource = aws_iam_role.ecs_task_execution.arn
      },
      {
        Effect   = "Allow"
        Action   = ["ec2:DescribeNetworkInterfaces"]
        Resource = "*"
      },
      {
        Effect = "Allow"
        Action = ["dynamodb:GetItem", "dynamodb:PutItem"]
        Resource = aws_dynamodb_table.discord.arn
      },
    ]
  })
}

resource "aws_lambda_function" "followup" {
  function_name    = "${var.project_name}-followup"
  role             = aws_iam_role.followup_lambda.arn
  handler          = "handler.handler"
  runtime          = "nodejs20.x"
  filename         = data.archive_file.followup.output_path
  source_code_hash = data.archive_file.followup.output_base64sha256
  timeout          = 60
  memory_size      = 256

  environment {
    variables = {
      AWS_REGION_       = var.aws_region
      TABLE_NAME        = aws_dynamodb_table.discord.name
      ECS_CLUSTER       = aws_ecs_cluster.main.name
      SUBNET_IDS        = join(",", aws_subnet.public[*].id)
      SECURITY_GROUP_ID = aws_security_group.game_servers.id
      DOMAIN_NAME       = var.hosted_zone_name
      GAME_NAMES        = join(",", keys(var.game_servers))
      CONNECT_MESSAGES  = jsonencode({ for g, cfg in var.game_servers : g => cfg.connect_message if cfg.connect_message != null })
      GAME_PORTS        = jsonencode({ for g, cfg in var.game_servers : g => cfg.ports[0].container if length(cfg.ports) > 0 })
    }
  }

  tags = { Name = "${var.project_name}-followup" }

  depends_on = [aws_iam_role_policy.followup_lambda]
}

resource "aws_cloudwatch_log_group" "followup" {
  name              = "/aws/lambda/${var.project_name}-followup"
  retention_in_days = 7
  tags              = { Name = "${var.project_name}-followup-logs" }
}
