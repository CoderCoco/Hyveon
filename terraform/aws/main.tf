# ── Data Sources ─────────────────────────────────────────────────────────────

data "aws_availability_zones" "available" {
  state = "available"
}

# ── VPC & Networking ─────────────────────────────────────────────────────────

resource "aws_vpc" "main" {
  cidr_block           = var.vpc_cidr
  enable_dns_hostnames = true
  enable_dns_support   = true
  tags                 = { Name = "${var.project_name}-vpc" }
}

resource "aws_internet_gateway" "main" {
  vpc_id = aws_vpc.main.id
  tags   = { Name = "${var.project_name}-igw" }
}

resource "aws_subnet" "public" {
  count                   = 2
  vpc_id                  = aws_vpc.main.id
  cidr_block              = cidrsubnet(var.vpc_cidr, 8, count.index)
  availability_zone       = data.aws_availability_zones.available.names[count.index]
  map_public_ip_on_launch = true
  tags                    = { Name = "${var.project_name}-public-${count.index}" }
}

resource "aws_route_table" "public" {
  vpc_id = aws_vpc.main.id
  route {
    cidr_block = "0.0.0.0/0"
    gateway_id = aws_internet_gateway.main.id
  }
  tags = { Name = "${var.project_name}-public-rt" }
}

resource "aws_route_table_association" "public" {
  count          = 2
  subnet_id      = aws_subnet.public[count.index].id
  route_table_id = aws_route_table.public.id
}

# ── Security Groups ───────────────────────────────────────────────────────────
# Dynamic ingress rules — one per port across all configured game servers.

locals {
  # Flattened map of all game-volume pairs, keyed by "${game}-${volume.name}".
  # Used to create one EFS access point per volume entry.
  game_volumes = {
    for pair in flatten([
      for game, cfg in var.game_servers : [
        for vol in cfg.volumes : {
          key            = "${game}-${vol.name}"
          game           = game
          name           = vol.name
          container_path = vol.container_path
        }
      ]
    ]) : pair.key => pair
  }

  # Ports for non-HTTPS games — open directly to the internet
  direct_game_ports = {
    for pair in distinct(flatten([
      for name, cfg in var.game_servers : [
        for p in cfg.ports : {
          key      = "${p.container}-${p.protocol}"
          port     = p.container
          protocol = p.protocol
        }
      ] if !cfg.https
    ])) : pair.key => pair
  }

  # Ports for HTTPS games — only allow traffic from the ALB
  https_game_ports = {
    for pair in distinct(flatten([
      for name, cfg in var.game_servers : [
        for p in cfg.ports : {
          key      = "${p.container}-${p.protocol}"
          port     = p.container
          protocol = p.protocol
        }
      ] if cfg.https
    ])) : pair.key => pair
  }
}

resource "aws_security_group" "game_servers" {
  name_prefix = "${var.project_name}-sg-"
  description = "Game server tasks - allows all configured game ports inbound"
  vpc_id      = aws_vpc.main.id

  # Non-HTTPS game ports — open to the internet
  dynamic "ingress" {
    for_each = local.direct_game_ports
    content {
      description = "Game port ${ingress.value.port}/${ingress.value.protocol}"
      from_port   = ingress.value.port
      to_port     = ingress.value.port
      protocol    = ingress.value.protocol
      cidr_blocks = ["0.0.0.0/0"]
    }
  }

  # HTTPS game ports — only allow traffic from the ALB
  dynamic "ingress" {
    for_each = local.enable_alb ? local.https_game_ports : {}
    content {
      description     = "ALB to game port ${ingress.value.port}/${ingress.value.protocol}"
      from_port       = ingress.value.port
      to_port         = ingress.value.port
      protocol        = ingress.value.protocol
      security_groups = [aws_security_group.alb[0].id]
    }
  }

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = { Name = "${var.project_name}-sg" }

  lifecycle {
    create_before_destroy = true
  }
}

# File manager (FileBrowser) — launched on-demand from the management app
resource "aws_security_group" "file_manager" {
  name_prefix = "${var.project_name}-filemgr-sg-"
  description = "FileBrowser tasks - allows port 8080 inbound"
  vpc_id      = aws_vpc.main.id

  ingress {
    description = "FileBrowser web UI"
    from_port   = 8080
    to_port     = 8080
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = { Name = "${var.project_name}-filemgr-sg" }

  lifecycle {
    create_before_destroy = true
  }
}

resource "aws_security_group" "efs" {
  name_prefix = "${var.project_name}-efs-sg-"
  description = "Allow NFS from game server tasks"
  vpc_id      = aws_vpc.main.id

  ingress {
    description     = "NFS from game servers"
    from_port       = 2049
    to_port         = 2049
    protocol        = "tcp"
    security_groups = [aws_security_group.game_servers.id, aws_security_group.file_manager.id]
  }

  dynamic "ingress" {
    for_each = length(local.games_with_seeds) > 0 ? [1] : []
    content {
      description     = "NFS from EFS seeder Lambdas"
      from_port       = 2049
      to_port         = 2049
      protocol        = "tcp"
      security_groups = [aws_security_group.efs_seeder[0].id]
    }
  }

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = { Name = "${var.project_name}-efs-sg" }
}

# ── EFS (persistent game saves) ───────────────────────────────────────────────
# One shared EFS filesystem; each game gets its own access point + directory.

resource "aws_efs_file_system" "saves" {
  creation_token = "${var.project_name}-saves"
  encrypted      = true
  tags           = { Name = "${var.project_name}-saves" }
}

resource "aws_efs_mount_target" "saves" {
  count           = 2
  file_system_id  = aws_efs_file_system.saves.id
  subnet_id       = aws_subnet.public[count.index].id
  security_groups = [aws_security_group.efs.id]
}

# One access point per game volume — isolates each volume under /${game}/${volume_name}
resource "aws_efs_access_point" "game" {
  for_each       = local.game_volumes
  file_system_id = aws_efs_file_system.saves.id

  posix_user {
    uid = 1000
    gid = 1000
  }

  root_directory {
    path = "/${each.value.game}/${each.value.name}"
    creation_info {
      owner_uid   = 1000
      owner_gid   = 1000
      permissions = "0755"
    }
  }

  tags = { Name = each.key }
}

# ── CloudWatch Log Groups ─────────────────────────────────────────────────────

resource "aws_cloudwatch_log_group" "game" {
  for_each          = var.game_servers
  name              = "/ecs/${each.key}-server"
  retention_in_days = 7
  tags              = { Name = "${each.key}-logs" }
}

# ── IAM ───────────────────────────────────────────────────────────────────────

# Task execution role — used by ECS to pull images and write logs
resource "aws_iam_role" "ecs_task_execution" {
  name = "${var.project_name}-task-execution"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Action    = "sts:AssumeRole"
      Effect    = "Allow"
      Principal = { Service = "ecs-tasks.amazonaws.com" }
    }]
  })
}

resource "aws_iam_role_policy_attachment" "ecs_task_execution" {
  role       = aws_iam_role.ecs_task_execution.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}

# Per-Lambda IAM roles live in route53.tf, watchdog.tf, interactions.tf, and
# followup.tf. The original shared aws_iam_role.lambda was retired during the
# serverless-Discord migration so each function carries only the actions it
# actually needs (smaller blast radius if any one Lambda is compromised).

# ── ECS Cluster ───────────────────────────────────────────────────────────────

resource "aws_ecs_cluster" "main" {
  name = "${var.project_name}-cluster"

  setting {
    name  = "containerInsights"
    value = "disabled" # Keep costs low for POC
  }

  tags = { Name = "${var.project_name}-cluster" }
}

# ── ECS Task Definitions ──────────────────────────────────────────────────────
# One task definition per game, created via for_each.
# Tasks are launched on-demand via RunTask (no persistent ECS Service needed).

resource "aws_ecs_task_definition" "game" {
  for_each = var.game_servers

  family                   = "${each.key}-server"
  network_mode             = "awsvpc"
  requires_compatibilities = ["FARGATE"]
  cpu                      = each.value.cpu
  memory                   = each.value.memory
  execution_role_arn       = aws_iam_role.ecs_task_execution.arn

  dynamic "volume" {
    for_each = each.value.volumes
    content {
      name = "${each.key}-${volume.value.name}"
      efs_volume_configuration {
        file_system_id     = aws_efs_file_system.saves.id
        transit_encryption = "ENABLED"
        authorization_config {
          access_point_id = aws_efs_access_point.game["${each.key}-${volume.value.name}"].id
          iam             = "DISABLED"
        }
      }
    }
  }

  container_definitions = jsonencode([{
    name      = each.key
    image     = each.value.image
    essential = true

    portMappings = [for p in each.value.ports : {
      containerPort = p.container
      hostPort      = p.container
      protocol      = p.protocol
    }]

    environment = each.value.environment

    mountPoints = [for vol in each.value.volumes : {
      sourceVolume  = "${each.key}-${vol.name}"
      containerPath = vol.container_path
      readOnly      = false
    }]

    logConfiguration = {
      logDriver = "awslogs"
      options = {
        "awslogs-group"         = aws_cloudwatch_log_group.game[each.key].name
        "awslogs-region"        = var.aws_region
        "awslogs-stream-prefix" = "ecs"
      }
    }
  }])

  tags = { Name = "${each.key}-server" }
}
