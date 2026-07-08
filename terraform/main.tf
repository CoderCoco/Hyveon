terraform {
  required_version = ">= 1.5.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
    archive = {
      source  = "hashicorp/archive"
      version = "~> 2.4"
    }

  }

  # Backend config is supplied at `terraform init` time by setup.sh so the
  # bucket/table names stay in sync with the values it creates.  When running
  # init manually, pass the same -backend-config flags that setup.sh uses, or
  # run setup.sh directly.
  backend "s3" {}
}

provider "aws" {
  region = var.aws_region

  default_tags {
    tags = var.tags
  }
}

# CloudFront ACM certificates must always be in us-east-1, regardless of the
# deployment region. This alias is used only for those certificate resources.
provider "aws" {
  alias  = "us_east_1"
  region = "us-east-1"

  default_tags {
    tags = var.tags
  }
}

# All AWS infrastructure lives in the "./aws" module — this root composes the
# backend/provider config with the module and re-exports its outputs
# (outputs.tf) so ConfigService.getTfOutputs() keeps reading root-level state.
module "cloud" {
  source = "./aws"

  providers = {
    aws           = aws
    aws.us_east_1 = aws.us_east_1
    archive       = archive
  }

  aws_region   = var.aws_region
  project_name = var.project_name
  vpc_cidr     = var.vpc_cidr
  game_servers = var.game_servers

  acm_certificate_domain = var.acm_certificate_domain

  watchdog_interval_minutes = var.watchdog_interval_minutes
  watchdog_idle_checks      = var.watchdog_idle_checks
  watchdog_min_packets      = var.watchdog_min_packets

  hosted_zone_name = var.hosted_zone_name
  dns_ttl          = var.dns_ttl

  base_allowed_guilds = var.base_allowed_guilds
  base_admin_user_ids = var.base_admin_user_ids
  base_admin_role_ids = var.base_admin_role_ids

  discord_application_id = var.discord_application_id
  discord_bot_token      = var.discord_bot_token
  discord_public_key     = var.discord_public_key
}
