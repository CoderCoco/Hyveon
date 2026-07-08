# ──────────────────────────────────────────────────────────────────────────────
# InteractionsLambda — Discord HTTP-interactions entry point
#
# Discord sends every slash-command invocation, autocomplete request, and PING
# to a public HTTPS URL we register in the Discord developer portal. This
# Lambda verifies the Ed25519 signature and either:
#   - Replies with PONG (PING handshake)
#   - Returns autocomplete results synchronously
#   - Returns a deferred ack and async-invokes FollowupLambda for slow ECS work
#
# Exposed via Lambda Function URL (auth_type NONE; we verify signatures
# ourselves). Cheaper than API Gateway for this single-route use case.
# ──────────────────────────────────────────────────────────────────────────────

data "archive_file" "interactions" {
  type        = "zip"
  source_file = "${path.module}/../../app/packages/lambda/interactions/dist/handler.cjs"
  output_path = "${path.module}/../../app/packages/lambda/interactions/dist/bundle.zip"
}

resource "aws_iam_role" "interactions_lambda" {
  name = "${var.project_name}-interactions-lambda"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Action    = "sts:AssumeRole"
      Effect    = "Allow"
      Principal = { Service = "lambda.amazonaws.com" }
    }]
  })
}

resource "aws_iam_role_policy" "interactions_lambda" {
  name = "${var.project_name}-interactions-lambda-policy"
  role = aws_iam_role.interactions_lambda.id

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
        Action   = ["dynamodb:GetItem"]
        Resource = aws_dynamodb_table.discord.arn
      },
      {
        Effect   = "Allow"
        Action   = ["secretsmanager:GetSecretValue"]
        Resource = aws_secretsmanager_secret.discord_public_key.arn
      },
      {
        Effect   = "Allow"
        Action   = ["lambda:InvokeFunction"]
        Resource = aws_lambda_function.followup.arn
      },
    ]
  })
}

resource "aws_lambda_function" "interactions" {
  function_name    = "${var.project_name}-interactions"
  role             = aws_iam_role.interactions_lambda.arn
  handler          = "handler.handler"
  runtime          = "nodejs20.x"
  filename         = data.archive_file.interactions.output_path
  source_code_hash = data.archive_file.interactions.output_base64sha256
  timeout          = 10
  memory_size      = 256

  environment {
    variables = {
      AWS_REGION_                   = var.aws_region
      TABLE_NAME                    = aws_dynamodb_table.discord.name
      DISCORD_PUBLIC_KEY_SECRET_ARN = aws_secretsmanager_secret.discord_public_key.arn
      FOLLOWUP_LAMBDA_NAME          = aws_lambda_function.followup.function_name
      GAME_NAMES                    = join(",", keys(var.game_servers))
      HOSTED_ZONE_NAME              = var.hosted_zone_name
    }
  }

  tags = { Name = "${var.project_name}-interactions" }

  depends_on = [aws_iam_role_policy.interactions_lambda]
}

resource "aws_cloudwatch_log_group" "interactions" {
  name              = "/aws/lambda/${var.project_name}-interactions"
  retention_in_days = 7
  tags              = { Name = "${var.project_name}-interactions-logs" }
}

resource "aws_lambda_function_url" "interactions" {
  function_name      = aws_lambda_function.interactions.function_name
  authorization_type = "NONE"

  cors {
    allow_origins = ["https://discord.com"]
    allow_methods = ["POST"]
    allow_headers = ["content-type", "x-signature-ed25519", "x-signature-timestamp"]
  }
}

# Since October 2025, Lambda Function URLs require BOTH lambda:InvokeFunctionUrl
# AND lambda:InvokeFunction in the resource policy — without the second one,
# Discord's endpoint validation gets 403 before the handler runs. AWS only
# accepts function_url_auth_type paired with lambda:InvokeFunctionUrl, so the
# two grants are split into two statements.
resource "aws_lambda_permission" "interactions_url_invoke_url" {
  statement_id           = "FunctionURLInvokeUrlAllowPublicAccess"
  action                 = "lambda:InvokeFunctionUrl"
  function_name          = aws_lambda_function.interactions.function_name
  principal              = "*"
  function_url_auth_type = "NONE"
}

resource "aws_lambda_permission" "interactions_url_invoke" {
  statement_id  = "FunctionURLInvokeAllowPublicAccess"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.interactions.function_name
  principal     = "*"
}
