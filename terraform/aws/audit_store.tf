# ──────────────────────────────────────────────────────────────────────────────
# Audit log DynamoDB table
#
# Pay-per-request table recording game-server config mutations (add/edit/
# remove) made through the management app. All items live under a single
# fixed partition (`pk = "AUDIT"`); the sort key is `<ISO timestamp>#<ULID>`
# (see `buildAuditSk` in `@hyveon/shared/audit.ts`), so a query against that
# partition with `ScanIndexForward: false` returns entries newest-first. See
# `AwsAuditLogStore` in `app/packages/cloud-aws/src/AwsAuditLogStore.ts` for
# the read/write implementation.
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
    enabled = true
  }

  tags = { Name = var.audit_table_name != "" ? var.audit_table_name : "${var.project_name}-audit" }
}
