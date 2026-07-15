import { useEffect, useState } from 'react';
import { ArrowLeft } from 'lucide-react';
import { Link, useParams } from 'react-router-dom';
import { api, type GameListEntry } from '../api.service.js';
import { GameStatusBadges } from '../components/game-status-badges.component.js';
import { PollingIndicator } from '../polling/polling-indicator.component.js';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card.component';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table.component';

/** A single labeled field in the "Container" overview grid. */
function Field({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-[0.65rem] uppercase tracking-wider text-[var(--color-muted-foreground)] mb-1">
        {label}
      </div>
      <div className="text-sm text-[var(--color-foreground)]">{value}</div>
    </div>
  );
}

/**
 * Game detail route (`/games/:name`) — read-only rendering of the full
 * declared configuration for a single game, sourced from the same merged
 * `games.list` payload the `/games` list page uses (see issue #93).
 *
 * Three renderable states, keyed off the merged `GameListEntry` for
 * `:name`:
 *   - Not found — `:name` doesn't match any entry in the merged list
 *     (neither declared nor deployed). Shows a "no such game" message.
 *   - Ghost — entry exists (`deployed: true`) but has no `config`, i.e. the
 *     game is live in `terraform.tfstate` but has no entry in
 *     `terraform.tfvars` anymore. Only the header + drift chip render; there
 *     is no declared configuration to show.
 *   - Fully declared — `config` is present. Renders every tfvars field:
 *     image, CPU/memory, HTTPS flag, ports, volumes, environment variables
 *     (if any), file seeds (collapsed, if any), and the connect message (if
 *     set).
 */
export function GameDetailPage() {
  const { name } = useParams<{ name: string }>();
  const [games, setGames] = useState<GameListEntry[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    void api
      .games()
      .then((res) => {
        if (!cancelled) setGames(res.games);
      })
      .catch(() => {
        if (!cancelled) setGames([]);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const entry = games?.find((g) => g.name === name);
  const config = entry?.config;

  return (
    <div className="max-w-4xl mx-auto">
      <div className="mb-6 flex items-start justify-between gap-4">
        <div>
          <Link
            to="/games"
            className="mb-1 inline-flex items-center gap-1 text-sm text-[var(--color-muted-foreground)] hover:text-[var(--color-foreground)]"
          >
            <ArrowLeft className="size-3.5" />
            Back to games
          </Link>
          <h2 className="text-2xl font-semibold capitalize text-[var(--color-foreground)]">{name}</h2>
        </div>
        <PollingIndicator />
      </div>

      {games === null ? (
        <p className="text-sm text-[var(--color-muted-foreground)]">Loading…</p>
      ) : !entry ? (
        <Card>
          <CardContent className="py-8 text-center text-sm text-[var(--color-muted-foreground)]">
            No game named <span className="font-[var(--font-mono)]">&quot;{name}&quot;</span> was found.
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-6">
          <Card>
            <CardHeader className="flex flex-row items-center justify-between">
              <CardTitle className="capitalize">{entry.name}</CardTitle>
              <GameStatusBadges declared={entry.declared} deployed={entry.deployed} />
            </CardHeader>
            {!config && (
              <CardContent>
                <p className="text-sm text-[var(--color-muted-foreground)]">
                  This game is deployed but has no entry in{' '}
                  <code className="font-mono text-xs bg-[var(--color-surface-2)] px-1 py-0.5 rounded">
                    terraform.tfvars
                  </code>{' '}
                  — there is no declared configuration to show.
                </p>
              </CardContent>
            )}
          </Card>

          {config && (
            <>
              {/* Container overview */}
              <Card>
                <CardHeader>
                  <CardTitle>Container</CardTitle>
                </CardHeader>
                <CardContent className="grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-4">
                  <Field label="Image" value={config.image} />
                  <Field label="CPU" value={String(config.cpu)} />
                  <Field label="Memory" value={String(config.memory)} />
                  <Field label="HTTPS" value={config.https ? 'Enabled' : 'Disabled'} />
                </CardContent>
              </Card>

              {/* Ports */}
              <Card>
                <CardHeader>
                  <CardTitle>Ports</CardTitle>
                </CardHeader>
                <CardContent>
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Container port</TableHead>
                        <TableHead>Protocol</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {config.ports.map((port) => (
                        <TableRow key={`${port.container}-${port.protocol}`}>
                          <TableCell className="font-[var(--font-mono)]">{port.container}</TableCell>
                          <TableCell className="uppercase">{port.protocol}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </CardContent>
              </Card>

              {/* Volumes */}
              <Card>
                <CardHeader>
                  <CardTitle>Volumes</CardTitle>
                </CardHeader>
                <CardContent>
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Name</TableHead>
                        <TableHead>Container path</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {config.volumes.map((volume) => (
                        <TableRow key={volume.name}>
                          <TableCell>{volume.name}</TableCell>
                          <TableCell className="font-[var(--font-mono)]">{volume.container_path}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </CardContent>
              </Card>

              {/* Environment variables (optional) */}
              {config.environment && config.environment.length > 0 && (
                <Card>
                  <CardHeader>
                    <CardTitle>Environment variables</CardTitle>
                  </CardHeader>
                  <CardContent>
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead>Name</TableHead>
                          <TableHead>Value</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {config.environment.map((env) => (
                          <TableRow key={env.name}>
                            <TableCell className="font-[var(--font-mono)]">{env.name}</TableCell>
                            <TableCell className="font-[var(--font-mono)]">{env.value}</TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </CardContent>
                </Card>
              )}

              {/* File seeds (optional, collapsed) */}
              {config.file_seeds && config.file_seeds.length > 0 && (
                <Card>
                  <CardHeader>
                    <CardTitle>File seeds</CardTitle>
                  </CardHeader>
                  <CardContent>
                    <details>
                      <summary className="cursor-pointer text-sm text-[var(--color-foreground)]">
                        {config.file_seeds.length} file{config.file_seeds.length === 1 ? '' : 's'} seeded at task start
                      </summary>
                      <ul className="mt-3 space-y-1">
                        {config.file_seeds.map((seed) => (
                          <li key={seed.path} className="font-[var(--font-mono)] text-xs text-[var(--color-muted-foreground)]">
                            {seed.path}
                            {seed.mode ? ` (mode ${seed.mode})` : ''}
                          </li>
                        ))}
                      </ul>
                    </details>
                  </CardContent>
                </Card>
              )}

              {/* Connect message (optional) */}
              {config.connect_message && (
                <Card>
                  <CardHeader>
                    <CardTitle>Connect message</CardTitle>
                  </CardHeader>
                  <CardContent>
                    <p className="text-sm text-[var(--color-foreground)] whitespace-pre-wrap">
                      {config.connect_message}
                    </p>
                  </CardContent>
                </Card>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}
