/**
 * Dedicated environment accessor for the AWS region fallback chain.
 *
 * Business-logic classes (e.g. {@link AwsAuditLogStore}) must not read
 * `process.env` directly — CLAUDE.md's "no raw `process.env` in business
 * logic" guideline requires environment access to be wrapped behind a
 * service method so tests can stub it via `vi.spyOn` instead of mutating
 * `process.env`. This module is that wrapper for the region-resolution
 * fallback shared by the `cloud-aws` client constructors.
 *
 * Resolution order: `AWS_REGION_` (Lambda's reserved-name workaround, see
 * CLAUDE.md), then `AWS_REGION`, then `AWS_DEFAULT_REGION`, then
 * `us-east-1` when none are set.
 */
export function resolveDefaultAwsRegion(): string {
  return (
    process.env['AWS_REGION_']?.trim() ||
    process.env['AWS_REGION']?.trim() ||
    process.env['AWS_DEFAULT_REGION']?.trim() ||
    'us-east-1'
  );
}
