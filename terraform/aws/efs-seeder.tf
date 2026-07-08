# ──────────────────────────────────────────────────────────────────────────────
# EFS file seeder — writes declarative file_seeds to each game's EFS volume
# before the server starts.  Only created for games that declare file_seeds.
#
# One Lambda function per game.  It mounts the game's first volume EFS access
# point at /mnt/efs, receives {game, seeds, container_path} as its payload,
# strips the container_path prefix from each seed path, and writes the file.
#
# The invocation resource re-triggers only when the sha256 of file_seeds
# changes, so re-applying with no seed changes is a no-op.
#
# Paths: in-container paths (e.g. /palworld/Pal/Saved/Config/.../foo.ini).
# Binary files: use content_base64 (base64-encoded bytes) instead of content.
#   Do NOT store secrets in file_seeds — they live in Terraform state.
# ──────────────────────────────────────────────────────────────────────────────

locals {
  # Games that declare at least one file seed entry.
  games_with_seeds = {
    for game, cfg in var.game_servers : game => cfg
    if length(cfg.file_seeds) > 0
  }
}

# ── Archive ───────────────────────────────────────────────────────────────────

data "archive_file" "efs_seeder" {
  for_each    = local.games_with_seeds
  type        = "zip"
  source_file = "${path.module}/../../app/packages/lambda/efs-seeder/dist/handler.cjs"
  output_path = "${path.module}/../../app/packages/lambda/efs-seeder/dist/${each.key}-bundle.zip"
}

# ── Shared security group (one, shared across all seeder Lambdas) ─────────────

resource "aws_security_group" "efs_seeder" {
  count       = length(local.games_with_seeds) > 0 ? 1 : 0
  name_prefix = "${var.project_name}-efs-seeder-sg-"
  description = "EFS seeder Lambdas — outbound NFS to EFS only"
  vpc_id      = aws_vpc.main.id

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = { Name = "${var.project_name}-efs-seeder-sg" }

  lifecycle {
    create_before_destroy = true
  }
}

# ── Per-game IAM ──────────────────────────────────────────────────────────────

resource "aws_iam_role" "efs_seeder" {
  for_each = local.games_with_seeds
  name     = "${var.project_name}-efs-seeder-${each.key}"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Action    = "sts:AssumeRole"
      Effect    = "Allow"
      Principal = { Service = "lambda.amazonaws.com" }
    }]
  })
}

resource "aws_iam_role_policy" "efs_seeder" {
  for_each = local.games_with_seeds
  name     = "${var.project_name}-efs-seeder-${each.key}-policy"
  role     = aws_iam_role.efs_seeder[each.key].id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect   = "Allow"
        Action   = ["logs:CreateLogGroup", "logs:CreateLogStream", "logs:PutLogEvents"]
        Resource = "arn:aws:logs:*:*:*"
      },
      {
        # Required for Lambda VPC networking
        Effect = "Allow"
        Action = [
          "ec2:CreateNetworkInterface",
          "ec2:DescribeNetworkInterfaces",
          "ec2:DeleteNetworkInterface",
        ]
        Resource = "*"
      },
      {
        Effect = "Allow"
        Action = [
          "elasticfilesystem:ClientMount",
          "elasticfilesystem:ClientWrite",
        ]
        Resource = aws_efs_file_system.saves.arn
      },
    ]
  })
}

# ── Per-game CloudWatch log groups ────────────────────────────────────────────

resource "aws_cloudwatch_log_group" "efs_seeder" {
  for_each          = local.games_with_seeds
  name              = "/aws/lambda/${var.project_name}-efs-seeder-${each.key}"
  retention_in_days = 7
  tags              = { Name = "${var.project_name}-efs-seeder-${each.key}-logs" }
}

# ── Per-game Lambda functions ─────────────────────────────────────────────────

resource "aws_lambda_function" "efs_seeder" {
  for_each = local.games_with_seeds

  function_name    = "${var.project_name}-efs-seeder-${each.key}"
  role             = aws_iam_role.efs_seeder[each.key].arn
  handler          = "handler.handler"
  runtime          = "nodejs20.x"
  filename         = data.archive_file.efs_seeder[each.key].output_path
  source_code_hash = data.archive_file.efs_seeder[each.key].output_base64sha256
  timeout          = 60

  vpc_config {
    subnet_ids         = aws_subnet.public[*].id
    security_group_ids = [aws_security_group.efs_seeder[0].id]
  }

  # Mount the game's first volume EFS access point at /mnt/efs.
  # Seed paths must use that volume's container_path as a prefix.
  file_system_config {
    arn              = aws_efs_access_point.game["${each.key}-${each.value.volumes[0].name}"].arn
    local_mount_path = "/mnt/efs"
  }

  environment {
    variables = {
      AWS_REGION_ = var.aws_region
    }
  }

  tags = { Name = "${var.project_name}-efs-seeder-${each.key}" }

  depends_on = [
    aws_iam_role_policy.efs_seeder,
    aws_efs_mount_target.saves,
    aws_cloudwatch_log_group.efs_seeder,
  ]
}

# ── Per-game invocations ──────────────────────────────────────────────────────
# Re-triggers only when the sha256 of file_seeds changes (content-addressed).

resource "aws_lambda_invocation" "efs_seeder" {
  for_each = local.games_with_seeds

  function_name = aws_lambda_function.efs_seeder[each.key].function_name

  triggers = {
    seeds_hash = sha256(jsonencode(each.value.file_seeds))
  }

  input = jsonencode({
    game           = each.key
    seeds          = each.value.file_seeds
    container_path = each.value.volumes[0].container_path
  })
}
