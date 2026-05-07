import { useEffect, useMemo, useState } from 'react';
import { Search, Server, ExternalLink } from 'lucide-react';
import { useGameStatus } from '../polling/game-status-provider.component.js';
import { useFileManager } from '../hooks/use-file-manager.hook.js';
import { api, type ActualCosts } from '../api.service.js';
import { GameCard } from '../components/game-card.component.js';
import { KpiStrip } from '../components/kpi-strip.component.js';
import { FileManagerModal } from '../components/file-manager-modal.component.js';
import { PollingIndicator } from '../polling/polling-indicator.component.js';
import { Input } from '@/components/ui/input.component';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card.component';

/**
 * Dashboard route (`/`) — top KPI strip, then a search-filterable grid of
 * GameCards. Cost analysis lives at `/costs`, Discord settings at `/discord`,
 * the live log tail at `/logs`, and the watchdog at `/settings`. The search
 * input narrows the grid by game name or hostname client-side.
 */
export function DashboardPage() {
  const { statuses, estimates, loading, refreshGame } = useGameStatus();
  const fileMgr = useFileManager();
  const [query, setQuery] = useState('');
  // Single Cost Explorer fetch shared with `KpiStrip` — Cost Explorer bills
  // per request, so don't double-call.
  const [actualCosts, setActualCosts] = useState<ActualCosts | null>(null);

  useEffect(() => {
    void api.costsActual().then(setActualCosts).catch(() => undefined);
  }, []);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return statuses;
    return statuses.filter((s) => {
      const host = (s.hostname ?? s.publicIp ?? '').toLowerCase();
      return s.game.toLowerCase().includes(q) || host.includes(q);
    });
  }, [statuses, query]);

  return (
    <>
      <div className="max-w-7xl mx-auto">
        {/* KPI strip */}
        <KpiStrip statuses={statuses} estimates={estimates} actualCosts={actualCosts} />

        {/* Search filter + polling indicator */}
        <div className="mb-4 flex items-center justify-between gap-4">
          <div className="relative max-w-sm flex-1">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 size-4 text-[var(--color-muted-foreground)] pointer-events-none" />
            <Input
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Filter by game or hostname…"
              className="pl-9"
              aria-label="Filter games"
            />
          </div>
          <PollingIndicator />
        </div>

        {/* Game cards */}
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-5 mb-6">
          {loading ? (
            <div className="col-span-full text-sm text-[var(--color-muted-foreground)] py-8 text-center">
              Loading servers…
            </div>
          ) : statuses.length === 0 ? (
            <div className="col-span-full py-8 flex justify-center">
              <NoGamesCard />
            </div>
          ) : visible.length === 0 ? (
            <div className="col-span-full text-sm text-[var(--color-muted-foreground)] py-8 text-center">
              No games match <span className="font-[var(--font-mono)]">&quot;{query}&quot;</span>.
            </div>
          ) : (
            visible.map((s) => (
              <GameCard
                key={s.game}
                status={s}
                estimate={estimates?.games[s.game]}
                onRefresh={refreshGame}
                onOpenFiles={fileMgr.open}
              />
            ))
          )}
        </div>
      </div>

      {/* File manager modal */}
      {fileMgr.activeGame && (
        <FileManagerModal
          game={fileMgr.activeGame}
          status={fileMgr.status}
          message={fileMgr.message}
          onClose={fileMgr.close}
          onStart={fileMgr.start}
          onStop={fileMgr.stop}
        />
      )}
    </>
  );
}

/** Shown when the API returns no game statuses — guides first-time operators. */
function NoGamesCard() {
  return (
    <Card className="max-w-lg w-full border-[var(--color-border)]">
      <CardHeader className="pb-3">
        <div className="flex items-center gap-3 mb-1">
          <div className="p-2 rounded-lg bg-[var(--color-primary)]/10">
            <Server className="size-5 text-[var(--color-primary-light)]" />
          </div>
          <CardTitle>No games deployed</CardTitle>
        </div>
        <CardDescription>
          Game servers are provisioned via Terraform. Each entry in{' '}
          <code className="font-mono text-xs bg-[var(--color-surface-2)] px-1 py-0.5 rounded">
            terraform.tfvars
          </code>{' '}
          creates an ECS task definition, EFS volume, and CloudWatch log group automatically.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-wrap gap-4">
        <a
          href="https://codercoco.github.io/game-server-deploy/setup"
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center gap-1.5 text-sm text-[var(--color-primary-light)] underline-offset-4 hover:underline"
        >
          Open setup guide
          <ExternalLink className="size-3.5" />
        </a>
        <a
          href="https://github.com/CoderCoco/game-server-deploy/blob/main/terraform/terraform.tfvars.example"
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center gap-1.5 text-sm text-[var(--color-primary-light)] underline-offset-4 hover:underline"
        >
          Edit <code className="font-mono text-xs">terraform.tfvars</code>
          <ExternalLink className="size-3.5" />
        </a>
      </CardContent>
    </Card>
  );
}
