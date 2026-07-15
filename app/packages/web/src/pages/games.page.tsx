import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, type GameListEntry } from '../api.service.js';
import { GameStatusBadges } from '../components/game-status-badges.component.js';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card.component';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table.component';
import { PollingIndicator } from '../polling/polling-indicator.component.js';

/** Renders a game's declared ports as a comma-separated `container/protocol` list, or an em dash when undeclared. */
function formatPorts(entry: GameListEntry): string {
  const ports = entry.config?.ports;
  if (!ports || ports.length === 0) return '—';
  return ports.map((p) => `${p.container}/${p.protocol}`).join(', ');
}

/**
 * Games route (`/games`) — read-only table of every game the app knows
 * about, merging the declared `terraform.tfvars` config with the deployed
 * `terraform.tfstate` view (see issue #92's `games.list` IPC channel).
 *
 * Rows fall into three shapes:
 *   - declared + deployed → full config, "In sync" chip.
 *   - declared only → full config, "Pending deploy" chip (not yet applied).
 *   - deployed only ("ghost" row) → no `config`, "Undeclared" chip; config
 *     columns render as em dashes since there's no tfvars entry to read.
 *
 * Each row links to `/games/:name` for the deeper read-only detail view
 * (issue #93's follow-up), still to be implemented.
 */
export function GamesPage() {
  const [games, setGames] = useState<GameListEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    api
      .games()
      .then(({ games: list }) => {
        if (!cancelled) setGames(list);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Failed to load games.');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div className="max-w-6xl mx-auto">
      <div className="mb-6 flex items-center justify-between">
        <h2 className="text-2xl font-semibold">Games</h2>
        <PollingIndicator />
      </div>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-xs uppercase tracking-wider text-[var(--color-muted-foreground)]">
            Declared game servers
          </CardTitle>
        </CardHeader>
        <CardContent>
          {loading ? (
            <div className="py-8 text-center text-sm text-[var(--color-muted-foreground)]">Loading games…</div>
          ) : error ? (
            <div className="rounded-[var(--radius-sm)] border border-[var(--color-red)]/40 bg-[var(--color-red)]/10 px-3 py-2 text-sm text-[var(--color-red)]">
              Failed to load games: {error}
            </div>
          ) : games.length === 0 ? (
            <div className="py-8 text-center text-sm text-[var(--color-muted-foreground)]">
              No games declared or deployed yet.
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Image</TableHead>
                  <TableHead>Ports</TableHead>
                  <TableHead className="text-right">CPU</TableHead>
                  <TableHead className="text-right">Memory</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {games.map((entry) => (
                  <TableRow key={entry.name}>
                    <TableCell className="capitalize font-medium">
                      <Link
                        to={`/games/${entry.name}`}
                        className="text-[var(--color-primary-light)] underline-offset-4 hover:underline"
                      >
                        {entry.name}
                      </Link>
                    </TableCell>
                    <TableCell>
                      <GameStatusBadges declared={entry.declared} deployed={entry.deployed} />
                    </TableCell>
                    <TableCell className="font-[var(--font-mono)] text-xs">
                      {entry.config?.image ?? '—'}
                    </TableCell>
                    <TableCell className="font-[var(--font-mono)] text-xs">{formatPorts(entry)}</TableCell>
                    <TableCell className="text-right font-[var(--font-mono)]">
                      {entry.config?.cpu ?? '—'}
                    </TableCell>
                    <TableCell className="text-right font-[var(--font-mono)]">
                      {entry.config?.memory ?? '—'}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
