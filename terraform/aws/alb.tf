# ──────────────────────────────────────────────────────────────────────────────
# ALB + ACM — HTTPS termination for game servers that need TLS
#
# Architecture:
#   Browser → HTTPS (443) → ALB → HTTP (container port) → Fargate task
#
# Only created when at least one game server has https = true.
# The ACM certificate domain is configurable via var.acm_certificate_domain
# (defaults to *.{hosted_zone_name}).
#
# For HTTPS games, DNS records are static aliases to the ALB (Terraform-managed).
# The DNS updater Lambda registers/deregisters task IPs as ALB targets instead
# of managing Route 53 records directly.
# ──────────────────────────────────────────────────────────────────────────────

locals {
  # Games that require HTTPS via ALB
  https_games = { for name, cfg in var.game_servers : name => cfg if cfg.https }

  # Whether we need any ALB infrastructure at all
  enable_alb = length(local.https_games) > 0

  # Resolve the ACM domain — use the variable if set, otherwise wildcard the hosted zone
  acm_domain = coalesce(var.acm_certificate_domain, "*.${var.hosted_zone_name}")
}

# ── ACM Certificate ──────────────────────────────────────────────────────────

resource "aws_acm_certificate" "game_servers" {
  count             = local.enable_alb ? 1 : 0
  domain_name       = local.acm_domain
  validation_method = "DNS"

  lifecycle {
    create_before_destroy = true
  }

  tags = { Name = "${var.project_name}-tls" }
}

resource "aws_route53_record" "acm_validation" {
  for_each = local.enable_alb ? {
    for dvo in aws_acm_certificate.game_servers[0].domain_validation_options : dvo.domain_name => {
      name   = dvo.resource_record_name
      type   = dvo.resource_record_type
      record = dvo.resource_record_value
    }
  } : {}

  zone_id = data.aws_route53_zone.main.zone_id
  name    = each.value.name
  type    = each.value.type
  records = [each.value.record]
  ttl     = 300

  allow_overwrite = true
}

resource "aws_acm_certificate_validation" "game_servers" {
  count                   = local.enable_alb ? 1 : 0
  certificate_arn         = aws_acm_certificate.game_servers[0].arn
  validation_record_fqdns = [for r in aws_route53_record.acm_validation : r.fqdn]
}

# ── ALB Security Group ───────────────────────────────────────────────────────

resource "aws_security_group" "alb" {
  count       = local.enable_alb ? 1 : 0
  name_prefix = "${var.project_name}-alb-sg-"
  description = "ALB - allows HTTPS inbound"
  vpc_id      = aws_vpc.main.id

  ingress {
    description = "HTTPS from internet"
    from_port   = 443
    to_port     = 443
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }

  # HTTP redirect listener (optional, for convenience)
  ingress {
    description = "HTTP from internet (redirect to HTTPS)"
    from_port   = 80
    to_port     = 80
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = { Name = "${var.project_name}-alb-sg" }

  lifecycle {
    create_before_destroy = true
  }
}

# ── Application Load Balancer ────────────────────────────────────────────────

resource "aws_lb" "game_servers" {
  count              = local.enable_alb ? 1 : 0
  name               = "${var.project_name}-alb"
  internal           = false
  load_balancer_type = "application"
  security_groups    = [aws_security_group.alb[0].id]
  subnets            = aws_subnet.public[*].id

  tags = { Name = "${var.project_name}-alb" }
}

# ── HTTPS Listener ───────────────────────────────────────────────────────────

resource "aws_lb_listener" "https" {
  count             = local.enable_alb ? 1 : 0
  load_balancer_arn = aws_lb.game_servers[0].arn
  port              = 443
  protocol          = "HTTPS"
  ssl_policy        = "ELBSecurityPolicy-TLS13-1-2-2021-06"
  certificate_arn   = aws_acm_certificate_validation.game_servers[0].certificate_arn

  default_action {
    type = "fixed-response"
    fixed_response {
      content_type = "text/plain"
      message_body = "No game server matched"
      status_code  = "404"
    }
  }
}

# HTTP → HTTPS redirect
resource "aws_lb_listener" "http_redirect" {
  count             = local.enable_alb ? 1 : 0
  load_balancer_arn = aws_lb.game_servers[0].arn
  port              = 80
  protocol          = "HTTP"

  default_action {
    type = "redirect"
    redirect {
      port        = "443"
      protocol    = "HTTPS"
      status_code = "HTTP_301"
    }
  }
}

# ── Target Groups (one per HTTPS game) ───────────────────────────────────────

resource "aws_lb_target_group" "game" {
  for_each    = local.https_games
  name        = "${each.key}-tg"
  port        = each.value.ports[0].container
  protocol    = "HTTP"
  vpc_id      = aws_vpc.main.id
  target_type = "ip"

  health_check {
    enabled             = true
    path                = "/"
    port                = "traffic-port"
    protocol            = "HTTP"
    healthy_threshold   = 2
    unhealthy_threshold = 5
    timeout             = 10
    interval            = 30
    matcher             = "200-399"
  }

  # Fargate tasks take time to start — allow longer deregistration drain
  deregistration_delay = 30

  tags = { Name = "${each.key}-tg" }
}

# ── Listener Rules (route by Host header) ────────────────────────────────────

resource "aws_lb_listener_rule" "game" {
  for_each     = local.https_games
  listener_arn = aws_lb_listener.https[0].arn

  action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.game[each.key].arn
  }

  condition {
    host_header {
      values = ["${each.key}.${var.hosted_zone_name}"]
    }
  }
}

# ── DNS Alias Records for HTTPS games (static, pointing to ALB) ─────────────

resource "aws_route53_record" "https_game" {
  for_each = local.https_games
  zone_id  = data.aws_route53_zone.main.zone_id
  name     = "${each.key}.${var.hosted_zone_name}"
  type     = "A"

  alias {
    name                   = aws_lb.game_servers[0].dns_name
    zone_id                = aws_lb.game_servers[0].zone_id
    evaluate_target_health = true
  }
}
