# ──────────────────────────────────────────────────────────────────────────────
# Audit log DynamoDB table
#
# Pay-per-request table recording who did what and when across the management
# app and the Discord bot (e.g. server start/stop, credential edits). Items are
# expected to use a partition key that groups related events (e.g. by date or
# actor) and a sort key for ordering within the partition — schema details live
# in the app layer, not here.
# ──────────────────────────────────────────────────────────────────────────────

resource "aws_dynamodb_table" "audit" {
  name         = var.audit_table_name != "" ? var.audit_table_name : "${var.project_name}-audit"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "pk"
  range_key    = "sk"

  attribute {
    name = "pk"
    type = "S"
  }
  attribute {
    name = "sk"
    type = "S"
  }

  point_in_time_recovery {
    enabled = false
  }

  tags = { Name = var.audit_table_name != "" ? var.audit_table_name : "${var.project_name}-audit" }
}
