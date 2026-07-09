terraform {
  required_version = ">= 1.5.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }

  # No remote backend on purpose: this module only exists to bootstrap the
  # S3 bucket that the main `terraform/` module later reads via a
  # `data "aws_s3_bucket"` source, so it can't store its own state there
  # (chicken-and-egg). State stays local and is never committed.
}

provider "aws" {
  region = var.aws_region

  default_tags {
    tags = var.tags
  }
}
