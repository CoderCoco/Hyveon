locals {
  tfvars_bucket_name = coalesce(var.tfvars_bucket_name, "${var.project_name}-tfvars")
}

# Versioned S3 bucket that holds terraform.tfvars outside the operator's
# parent repo. Versioning plus the lifecycle rule below double as the
# history/locking mechanism for this bucket.
resource "aws_s3_bucket" "tfvars" {
  bucket = local.tfvars_bucket_name
}

resource "aws_s3_bucket_versioning" "tfvars" {
  bucket = aws_s3_bucket.tfvars.id

  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "tfvars" {
  bucket = aws_s3_bucket.tfvars.id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

resource "aws_s3_bucket_public_access_block" "tfvars" {
  bucket = aws_s3_bucket.tfvars.id

  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_lifecycle_configuration" "tfvars" {
  bucket = aws_s3_bucket.tfvars.id

  rule {
    id     = "expire-noncurrent-versions"
    status = "Enabled"

    filter {}

    noncurrent_version_expiration {
      noncurrent_days = 90
    }
  }

  depends_on = [aws_s3_bucket_versioning.tfvars]
}
