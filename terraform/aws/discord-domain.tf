# ──────────────────────────────────────────────────────────────────────────────
# Discord custom domain — discord.{hosted_zone_name}
#
# Lambda Function URLs can't be Route 53 ALIAS targets, so we front the
# interactions Lambda with a CloudFront distribution and point the custom
# subdomain at it:
#
#   discord.codercoco.com
#     → Route 53 ALIAS → CloudFront distribution
#       → Lambda Function URL (HTTPS origin)
#
# CloudFront is in the global edge network but ACM certificates must always be
# in us-east-1, regardless of var.aws_region. The aws.us_east_1 provider alias
# (defined in main.tf) is used for the certificate and its validation resource.
#
# Cache is fully disabled — every Discord interaction is unique. Discord's
# signature headers (X-Signature-Ed25519, X-Signature-Timestamp) are forwarded
# to the Lambda via the AllViewerExceptHostHeader origin request policy, which
# passes all viewer headers except Host (the Lambda Function URL uses its own
# Host header for routing).
# ──────────────────────────────────────────────────────────────────────────────

locals {
  discord_domain = "discord.${var.hosted_zone_name}"

  # Strip "https://" and trailing "/" from the Lambda Function URL to get the
  # bare hostname CloudFront needs as its origin domain.
  interactions_lambda_domain = trimsuffix(
    replace(aws_lambda_function_url.interactions.function_url, "https://", ""),
    "/"
  )
}

# ── ACM Certificate ───────────────────────────────────────────────────────────

resource "aws_acm_certificate" "discord" {
  provider          = aws.us_east_1
  domain_name       = local.discord_domain
  validation_method = "DNS"

  lifecycle {
    create_before_destroy = true
  }

  tags = { Name = "${var.project_name}-discord-tls" }
}

resource "aws_route53_record" "discord_acm_validation" {
  for_each = {
    for dvo in aws_acm_certificate.discord.domain_validation_options : dvo.domain_name => {
      name   = dvo.resource_record_name
      type   = dvo.resource_record_type
      record = dvo.resource_record_value
    }
  }

  zone_id = data.aws_route53_zone.main.zone_id
  name    = each.value.name
  type    = each.value.type
  records = [each.value.record]
  ttl     = 300

  allow_overwrite = true
}

resource "aws_acm_certificate_validation" "discord" {
  provider                = aws.us_east_1
  certificate_arn         = aws_acm_certificate.discord.arn
  validation_record_fqdns = [for r in aws_route53_record.discord_acm_validation : r.fqdn]
}

# ── CloudFront Distribution ───────────────────────────────────────────────────

resource "aws_cloudfront_distribution" "discord" {
  comment             = "${var.project_name} Discord interactions proxy"
  enabled             = true
  is_ipv6_enabled     = true
  price_class         = "PriceClass_100" # US, Canada, Europe — cheapest tier
  aliases             = [local.discord_domain]
  wait_for_deployment = false

  origin {
    domain_name = local.interactions_lambda_domain
    origin_id   = "interactions-lambda"

    custom_origin_config {
      http_port              = 80
      https_port             = 443
      origin_protocol_policy = "https-only"
      origin_ssl_protocols   = ["TLSv1.2"]
    }
  }

  default_cache_behavior {
    target_origin_id       = "interactions-lambda"
    viewer_protocol_policy = "redirect-to-https"
    allowed_methods        = ["GET", "HEAD", "OPTIONS", "PUT", "POST", "PATCH", "DELETE"]
    cached_methods         = ["GET", "HEAD"]

    # Managed policy: CachingDisabled — every Discord request must reach the Lambda
    cache_policy_id = "4135ea2d-6df8-44a3-9df3-4b5a84be39ad"

    # Managed policy: AllViewerExceptHostHeader — forwards Content-Type,
    # X-Signature-Ed25519, X-Signature-Timestamp, and all other viewer headers
    # to the Lambda, while letting CloudFront set Host to the origin hostname.
    origin_request_policy_id = "b689b0a8-53d0-40ab-baf2-68738e2966ac"
  }

  restrictions {
    geo_restriction {
      restriction_type = "none"
    }
  }

  viewer_certificate {
    acm_certificate_arn      = aws_acm_certificate_validation.discord.certificate_arn
    ssl_support_method       = "sni-only"
    minimum_protocol_version = "TLSv1.2_2021"
  }

  tags = { Name = "${var.project_name}-discord-cf" }
}

# ── Route 53 ALIAS record ─────────────────────────────────────────────────────

resource "aws_route53_record" "discord" {
  zone_id = data.aws_route53_zone.main.zone_id
  name    = local.discord_domain
  type    = "A"

  alias {
    name                   = aws_cloudfront_distribution.discord.domain_name
    zone_id                = aws_cloudfront_distribution.discord.hosted_zone_id
    evaluate_target_health = false
  }
}

# IPv6
resource "aws_route53_record" "discord_aaaa" {
  zone_id = data.aws_route53_zone.main.zone_id
  name    = local.discord_domain
  type    = "AAAA"

  alias {
    name                   = aws_cloudfront_distribution.discord.domain_name
    zone_id                = aws_cloudfront_distribution.discord.hosted_zone_id
    evaluate_target_health = false
  }
}
