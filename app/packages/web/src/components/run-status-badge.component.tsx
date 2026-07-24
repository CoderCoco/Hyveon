import type { RunHistoryStatus } from '@hyveon/desktop-preload';
import { Badge } from './ui/badge.component.js';

/** Maps each {@link RunHistoryStatus} onto the `Badge` variant/label used consistently across the history table and run-detail view. */
const STATUS_BADGE: Record<RunHistoryStatus, { variant: 'success' | 'destructive' | 'secondary'; label: string }> = {
  success: { variant: 'success', label: 'Success' },
  failed: { variant: 'destructive', label: 'Failed' },
  aborted: { variant: 'secondary', label: 'Aborted' },
};

/** Small colored status badge for a persisted `terraform` run record — shared by the history table rows and the read-only run-detail view. */
export function RunStatusBadge({ status }: { status: RunHistoryStatus }) {
  const { variant, label } = STATUS_BADGE[status];
  return <Badge variant={variant}>{label}</Badge>;
}
