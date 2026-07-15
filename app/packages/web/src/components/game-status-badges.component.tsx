import { Badge, type BadgeProps } from '@/components/ui/badge.component';

/**
 * Props for {@link GameStatusBadges} — the `declared` / `deployed` flags off
 * a `GameListEntry` (`@hyveon/shared`, merged by `mergeGameLists` — see
 * issue #92).
 */
export interface GameStatusBadgesProps {
  /** True when this game has an entry in the tfvars `game_servers` map. */
  declared: boolean;
  /** True when this game has a deployed ECS task definition in tfstate. */
  deployed: boolean;
}

/**
 * Renders the drift indicator for a single game row on the Settings →
 * Games panel (issue #93): one chip summarizing whether the game is
 * declared in `terraform.tfvars`, deployed to `terraform.tfstate`, or
 * both — so operators can spot drift between the two sources at a glance.
 *
 * - declared && deployed → "In sync" (success)
 * - declared && !deployed → "Pending deploy" (warning)
 * - !declared && deployed → "Undeclared" (destructive)
 *
 * `!declared && !deployed` is not a state `GameListEntry` can produce (a
 * game only appears in the merged list when it's declared, deployed, or
 * both), so it's intentionally not handled here.
 */
export function GameStatusBadges({ declared, deployed }: GameStatusBadgesProps) {
  const { text, variant } = describeDriftStatus(declared, deployed);
  return <Badge variant={variant}>{text}</Badge>;
}

/** Chip copy + color variant for a declared/deployed combination. */
function describeDriftStatus(
  declared: boolean,
  deployed: boolean,
): { text: string; variant: NonNullable<BadgeProps['variant']> } {
  if (declared && deployed) {
    return { text: 'In sync', variant: 'success' };
  }
  if (declared && !deployed) {
    return { text: 'Pending deploy', variant: 'warning' };
  }
  return { text: 'Undeclared', variant: 'destructive' };
}
