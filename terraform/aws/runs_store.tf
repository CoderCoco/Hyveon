# ──────────────────────────────────────────────────────────────────────────────
# Server-run history DynamoDB table
#
# Pay-per-request table recording each server run (start → stop) driven
# through the management app. Items are keyed by `pk = "RUN#{game}"`, sort
# key `sk = "<ISO start timestamp>#<ULID>"`, so a query against a game's
# partition with `ScanIndexForward: false` returns runs newest-first.
#
# The `status-index` GSI projects `status` (e.g. "RUNNING" / "STOPPED") as
# its hash key and `startedAt` as its range key, so callers can query all
# runs in a given status ordered by start time without scanning the table.
# ──────────────────────────────────────────────────────────────────────────────

resource "aws_dynamodb_table" "runs" {
  name         = var.runs_table_name != "" ? var.runs_table_name : "${var.project_name}-runs"
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
  attribute {
    name = "status"
    type = "S"
  }
  attribute {
    name = "startedAt"
    type = "S"
  }

  global_secondary_index {
    name            = "status-index"
    hash_key        = "status"
    range_key       = "startedAt"
    projection_type = "ALL"
  }

  point_in_time_recovery {
    enabled = true
  }

  tags = { Name = var.runs_table_name != "" ? var.runs_table_name : "${var.project_name}-runs" }
}
