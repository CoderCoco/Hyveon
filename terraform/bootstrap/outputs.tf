output "tfvars_bucket_name" {
  description = "Name of the S3 bucket used to store terraform.tfvars"
  value       = aws_s3_bucket.tfvars.id
}

output "tfvars_bucket_arn" {
  description = "ARN of the S3 bucket used to store terraform.tfvars"
  value       = aws_s3_bucket.tfvars.arn
}
