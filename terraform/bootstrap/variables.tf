variable "aws_region" {
  description = "AWS region to provision the tfvars bucket in"
  type        = string
  default     = "us-east-1"
}

variable "project_name" {
  description = "Project name used for resource naming"
  type        = string
  default     = "hyveon"
}

variable "tfvars_bucket_name" {
  description = "Override for the tfvars bucket name (defaults to \"<project_name>-tfvars\")"
  type        = string
  default     = null
}

variable "tags" {
  description = "Tags applied to all resources"
  type        = map(string)
  default = {
    Project     = "hyveon"
    Environment = "poc"
    ManagedBy   = "terraform"
  }
}
