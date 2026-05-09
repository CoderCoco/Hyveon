import { useEffect, useMemo, useState } from 'react';
import { ArrowDown, ArrowUp, ArrowUpDown, Search } from 'lucide-react';
import {
  api,
  type ActualCosts,
  type CostEstimates,
  type GameEstimate,
} from '../api.service.js';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card.component';
import { Badge } from '@/components/ui/badge.component';
import { Button } from '@/components/ui/button.component';
import { Input } from '@/components/ui/input.component';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table.component';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip.component';
import { cn } from '@/lib/utils.utils';
import { PollingIndicator } from '../polling/polling-indicator.component.js';

// Sub-day granularities (1h, 24h) are intentionally absent — AWS Cost Explorer
// only exposes daily granularity. Add entries here when a finer-grain source lands.
type RangeKey = '7d' | '30d';
interface RangeOption {
  key: RangeKey;
  label: string;
  days: number;
}

const RANGES: RangeOption[] = [
  { key: '7d', label: '7d', days: 7 },
  { key: '30d', label: '30d', days: 30 },
];

/**
 * Per-game color tokens used by the stacked bar chart and table swatches.
 * Order is the spec recommendation (cyan, purple, orange, pink), with extra
 * accents appended so we don't run out as new games are added.
 */
const GAME_COLOR_VARS = [
  '--color-cyan',
  '--color-primary',
  '--color-orange',
  '--color-pink',
  '--color-primary-light',
  '--color-cyan-light',
  '--color-amber',
  '--color-green',
  '--color-red',
] as const;

/** Sortable column keys for the estimates table. */
type SortKey = 'game' | 'vcpu' | 'memoryGb' | 'costPerHour' | 'costPerDay24h' | 'costPerMonth4hpd';
type SortDir = 'asc' | 'desc';

interface EstimateRow extends GameEstimate {
  game: string;
}

/** Format a dollar amount with sensible precision for the value's magnitude. */
function formatUsd(value: number, opts: { precise?: boolean } = {}): string {
  const digits = opts.precise ? (value < 1 ? 4 : 2) : 2;
  return `$${value.toLocaleString(undefined, { minimumFractionDigits: digits, maximumFractionDigits: digits })}`;
}

/** Format a date string (YYYY-MM-DD) as a short month/day label for chart axes. */
function formatShortDate(iso: string): string {
  if (!iso) return '';
  const [y, m, d] = iso.split('-').map(Number);
  if (!y || !m || !d) return iso;
  // Format in UTC so negative-offset timezones don't display the prior calendar
  // day for the UTC-midnight Date we constructed above.
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  });
}

/** Sum the `cost` field of every entry in an `ActualCosts.daily` array. */
function sumDaily(daily: ActualCosts['daily']): number {
  return daily.reduce((acc, d) => acc + d.cost, 0);
}

/**
 * The Cost Explorer endpoint only returns daily totals (no per-service split),
 * so we approximate the per-game contribution by dividing each day's total
 * evenly across the configured games. When backend per-game data lands
 * (tracked as a follow-up), this helper can be replaced with the real split.
 */
function splitDailyByGame(
  daily: ActualCosts['daily'],
  games: string[],
): { date: string; perGame: Record<string, number>; total: number }[] {
  const share = games.length > 0 ? 1 / games.length : 0;
  return daily.map((d) => {
    const perGame: Record<string, number> = {};
    for (const g of games) perGame[g] = d.cost * share;
    return { date: d.date, perGame, total: d.cost };
  });
}

/**
 * Fetches the doubled actuals window once per range change (sliced into
 * current/prior halves) and the per-game estimates once on mount. Estimates
 * are kept across range changes — the backend hits ECS `getTaskDefinition()`
 * per game and the values don't depend on `days`, so refetching on every
 * range switch would be wasted AWS calls and cause table flicker.
 */
function useCostsData(days: number): {
  actual: ActualCosts | null;
  prior: ActualCosts | null;
  estimates: CostEstimates | null;
  loading: boolean;
} {
  const [actual, setActual] = useState<ActualCosts | null>(null);
  const [prior, setPrior] = useState<ActualCosts | null>(null);
  const [estimates, setEstimates] = useState<CostEstimates | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setActual(null);
    setPrior(null);
    api.costsActual(days * 2)
      .then((doubled) => {
        if (cancelled) return;
        const splitAt = Math.max(doubled.daily.length - days, 0);
        const priorDaily = doubled.daily.slice(0, splitAt);
        const currentDaily = doubled.daily.slice(splitAt);
        setActual({
          daily: currentDaily,
          total: Math.round(sumDaily(currentDaily) * 100) / 100,
          currency: doubled.currency,
          days,
          error: doubled.error,
        });
        setPrior({
          daily: priorDaily,
          total: Math.round(sumDaily(priorDaily) * 100) / 100,
          currency: doubled.currency,
          days,
        });
        setLoading(false);
      })
      .catch(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, [days]);

  useEffect(() => {
    let cancelled = false;
    api.costsEstimate()
      .then((est) => {
        if (!cancelled) setEstimates(est);
      })
      .catch(() => { /* leave estimates null; the table renders an empty state */ });
    return () => { cancelled = true; };
  }, []);

  return { actual, prior, estimates, loading };
}

/**
 * Cost analysis route (`/costs`). Renders the headline 7-day stacked-by-game
 * spend chart, a sortable per-game estimates table, the trailing-window total
 * with a delta-vs-prior pill, and a time-range selector.
 *
 * Per-game split for the historical chart is currently a uniform fallback
 * because `/api/costs/actual` only returns daily totals — see CoderCoco/game-server-deploy#61.
 */
export function CostsPage() {
  const [range, setRange] = useState<RangeKey>('7d');

  const activeRange = RANGES.find((r) => r.key === range) ?? RANGES[0]!;
  const days = activeRange.days;
  const { actual, prior, estimates, loading } = useCostsData(days);

  const games = useMemo(
    () => (estimates ? Object.keys(estimates.games).sort() : []),
    [estimates],
  );
  const colorByGame = useMemo<Record<string, string>>(() => {
    const map: Record<string, string> = {};
    games.forEach((g, i) => {
      map[g] = `var(${GAME_COLOR_VARS[i % GAME_COLOR_VARS.length]})`;
    });
    return map;
  }, [games]);

  const stacked = useMemo(
    () => (actual ? splitDailyByGame(actual.daily, games) : []),
    [actual, games],
  );
  const maxBarTotal = Math.max(0.0001, ...stacked.map((d) => d.total));

  const total = actual?.total ?? 0;
  const priorTotal = prior?.total ?? 0;
  const delta = total - priorTotal;
  const deltaPct = priorTotal > 0 ? (delta / priorTotal) * 100 : null;

  return (
    <TooltipProvider delayDuration={150}>
      <div className="max-w-6xl mx-auto space-y-6">
        <header className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <h2 className="text-2xl font-semibold text-[var(--color-foreground)]">Cost Analysis</h2>
            <p className="text-sm text-[var(--color-muted-foreground)] mt-1">
              ECS + Fargate spend, per-game estimates, and trailing-window deltas.
            </p>
          </div>
          <div className="flex items-center gap-3">
            <PollingIndicator />
            <RangeSelector active={range} onChange={setRange} />
          </div>
        </header>

        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-xs uppercase tracking-wider text-[var(--color-muted-foreground)]">
              Total spend · trailing {days} {days === 1 ? 'day' : 'days'}
            </CardTitle>
          </CardHeader>
          <CardContent className="flex flex-wrap items-end gap-6">
            <div className="bg-gradient-to-r from-[var(--color-primary-light)] via-[var(--color-cyan)] to-[var(--color-pink)] bg-clip-text text-transparent text-5xl font-semibold font-[var(--font-mono)] leading-none">
              {formatUsd(total)}
            </div>
            <DeltaPill delta={delta} deltaPct={deltaPct} priorTotal={priorTotal} />
            {actual?.error && (
              <span className="text-xs text-[var(--color-red)]">
                Cost Explorer: {actual.error}
              </span>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-3 flex flex-row items-center justify-between gap-4">
            <CardTitle className="text-xs uppercase tracking-wider text-[var(--color-muted-foreground)]">
              Daily spend, stacked by game
            </CardTitle>
            <Legend games={games} colorByGame={colorByGame} />
          </CardHeader>
          <CardContent>
            {loading && !actual ? (
              <div className="h-48 flex items-center justify-center text-sm text-[var(--color-muted-foreground)]">
                Loading…
              </div>
            ) : stacked.length === 0 ? (
              <div className="h-48 flex items-center justify-center text-sm text-[var(--color-muted-foreground)]">
                No cost data available.
              </div>
            ) : (
              <StackedBarChart
                data={stacked}
                games={games}
                colorByGame={colorByGame}
                maxTotal={maxBarTotal}
              />
            )}
            {games.length > 0 && (
              <p className="mt-3 text-[0.7rem] text-[var(--color-muted-foreground)]">
                Per-game split is a uniform approximation — Cost Explorer returns
                daily totals only. See CoderCoco/game-server-deploy#61.
              </p>
            )}
          </CardContent>
        </Card>

        <EstimatesTable estimates={estimates} colorByGame={colorByGame} />
      </div>
    </TooltipProvider>
  );
}

/** Segmented selector for the active time range. */
function RangeSelector({
  active,
  onChange,
}: {
  active: RangeKey;
  onChange: (key: RangeKey) => void;
}) {
  return (
    <div className="inline-flex rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface-2)] p-1">
      {RANGES.map((r) => (
        <button
          key={r.key}
          type="button"
          onClick={() => onChange(r.key)}
          className={cn(
            'px-3 py-1 text-xs font-medium rounded-[var(--radius-sm)] transition-colors',
            r.key === active
              ? 'bg-[var(--color-surface)] text-[var(--color-foreground)] shadow'
              : 'text-[var(--color-muted-foreground)] hover:text-[var(--color-foreground)]',
          )}
        >
          {r.label}
        </button>
      ))}
    </div>
  );
}

/** Pill showing absolute and percentage delta vs the prior window. Green if down, red if up, secondary if no prior data. */
function DeltaPill({
  delta,
  deltaPct,
  priorTotal,
}: {
  delta: number;
  deltaPct: number | null;
  priorTotal: number;
}) {
  if (priorTotal <= 0) {
    return (
      <Badge variant="secondary" className="font-[var(--font-mono)]">
        no prior period
      </Badge>
    );
  }
  const decreased = delta < 0;
  const ArrowIcon = decreased ? ArrowDown : ArrowUp;
  return (
    <Badge variant={decreased ? 'success' : 'destructive'} className="font-[var(--font-mono)] gap-1">
      <ArrowIcon className="size-3" aria-hidden="true" />
      {formatUsd(Math.abs(delta))}
      {deltaPct !== null && ` (${Math.abs(deltaPct).toFixed(1)}%)`}
      <span className="opacity-80 ml-1">vs prior</span>
    </Badge>
  );
}

/** Color-swatch legend mapping each game to its chart color. */
function Legend({
  games,
  colorByGame,
}: {
  games: string[];
  colorByGame: Record<string, string>;
}) {
  if (games.length === 0) return null;
  return (
    <div className="flex flex-wrap gap-x-4 gap-y-1">
      {games.map((g) => (
        <div key={g} className="flex items-center gap-1.5 text-xs text-[var(--color-muted-foreground)]">
          <span
            className="size-2.5 rounded-sm"
            style={{ background: colorByGame[g] }}
            aria-hidden
          />
          <span className="capitalize">{g}</span>
        </div>
      ))}
    </div>
  );
}

interface StackedRow {
  date: string;
  total: number;
  perGame: Record<string, number>;
}

/** Vertical stacked-bar chart. Each day is one column; each segment within is a per-game share with a hover tooltip. */
function StackedBarChart({
  data,
  games,
  colorByGame,
  maxTotal,
}: {
  data: StackedRow[];
  games: string[];
  colorByGame: Record<string, string>;
  maxTotal: number;
}) {
  return (
    <div>
      <div className="flex items-end gap-1 h-48">
        {data.map((d) => {
          const heightPct = Math.max((d.total / maxTotal) * 100, 1);
          return (
            <div key={d.date} className="flex-1 flex flex-col items-center gap-1 h-full">
              <div
                className="w-full flex flex-col-reverse rounded-[var(--radius-sm)] overflow-hidden"
                style={{ height: `${heightPct}%`, minHeight: '2px' }}
              >
                {games.map((g) => {
                  const value = d.perGame[g] ?? 0;
                  if (value <= 0 || d.total <= 0) return null;
                  const segmentPct = (value / d.total) * 100;
                  return (
                    <Tooltip key={g}>
                      <TooltipTrigger asChild>
                        <div
                          role="img"
                          className="w-full transition-opacity hover:opacity-80"
                          style={{
                            height: `${segmentPct}%`,
                            background: colorByGame[g],
                          }}
                          aria-label={`${g}: ${formatUsd(value, { precise: true })}`}
                        />
                      </TooltipTrigger>
                      <TooltipContent side="top">
                        <div className="font-[var(--font-mono)]">
                          <div className="capitalize font-semibold">{g}</div>
                          <div className="text-[var(--color-muted-foreground)]">
                            {formatShortDate(d.date)} · {formatUsd(value, { precise: true })}
                          </div>
                        </div>
                      </TooltipContent>
                    </Tooltip>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>
      <div className="flex gap-1 mt-2">
        {data.map((d) => (
          <div
            key={d.date}
            className="flex-1 text-center text-[0.65rem] text-[var(--color-muted-foreground)] font-[var(--font-mono)] truncate"
          >
            {formatShortDate(d.date)}
          </div>
        ))}
      </div>
    </div>
  );
}

/** Sortable, filterable per-game estimates table. Default sort is `$/hr` descending. */
function EstimatesTable({
  estimates,
  colorByGame,
}: {
  estimates: CostEstimates | null;
  colorByGame: Record<string, string>;
}) {
  const [sortKey, setSortKey] = useState<SortKey>('costPerHour');
  const [sortDir, setSortDir] = useState<SortDir>('desc');
  const [filter, setFilter] = useState('');

  const rows: EstimateRow[] = useMemo(
    () =>
      estimates
        ? Object.entries(estimates.games).map(([game, est]) => ({ game, ...est }))
        : [],
    [estimates],
  );

  const filtered = useMemo(() => {
    const q = filter.trim().toLowerCase();
    return q ? rows.filter((r) => r.game.toLowerCase().includes(q)) : rows;
  }, [rows, filter]);

  const sorted = useMemo(() => {
    const list = [...filtered];
    list.sort((a, b) => {
      const av = a[sortKey];
      const bv = b[sortKey];
      const cmp = typeof av === 'string' && typeof bv === 'string'
        ? av.localeCompare(bv)
        : Number(av) - Number(bv);
      return sortDir === 'asc' ? cmp : -cmp;
    });
    return list;
  }, [filtered, sortKey, sortDir]);

  function toggleSort(key: SortKey) {
    if (key === sortKey) {
      setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortKey(key);
      setSortDir(key === 'game' ? 'asc' : 'desc');
    }
  }

  return (
    <Card>
      <CardHeader className="pb-3 flex flex-row items-center justify-between gap-4">
        <CardTitle className="text-xs uppercase tracking-wider text-[var(--color-muted-foreground)]">
          Per-game estimates
        </CardTitle>
        <div className="relative w-64">
          <Search className="absolute left-2 top-1/2 -translate-y-1/2 size-3.5 text-[var(--color-muted-foreground)]" aria-hidden="true" />
          <Input
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="Filter games…"
            className="pl-7 h-8 text-xs"
          />
        </div>
      </CardHeader>
      <CardContent>
        {rows.length === 0 ? (
          <div className="py-8 text-center text-sm text-[var(--color-muted-foreground)]">
            No estimates available.
          </div>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <SortableHeader label="Game"     sortKey="game"            currentKey={sortKey} dir={sortDir} onClick={toggleSort} />
                <SortableHeader label="vCPU"     sortKey="vcpu"            currentKey={sortKey} dir={sortDir} onClick={toggleSort} align="right" />
                <SortableHeader label="Memory"   sortKey="memoryGb"        currentKey={sortKey} dir={sortDir} onClick={toggleSort} align="right" />
                <SortableHeader label="$/hour"   sortKey="costPerHour"     currentKey={sortKey} dir={sortDir} onClick={toggleSort} align="right" />
                <SortableHeader label="$/day"    sortKey="costPerDay24h"   currentKey={sortKey} dir={sortDir} onClick={toggleSort} align="right" />
                <SortableHeader label="$/month"  sortKey="costPerMonth4hpd" currentKey={sortKey} dir={sortDir} onClick={toggleSort} align="right" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {sorted.map((r) => (
                <TableRow key={r.game}>
                  <TableCell className="capitalize">
                    <span className="inline-flex items-center gap-2">
                      <span
                        className="size-2.5 rounded-sm shrink-0"
                        style={{ background: colorByGame[r.game] ?? 'var(--color-muted-foreground)' }}
                        aria-hidden
                      />
                      {r.game}
                    </span>
                  </TableCell>
                  <TableCell className="text-right font-[var(--font-mono)]">{r.vcpu}</TableCell>
                  <TableCell className="text-right font-[var(--font-mono)]">{r.memoryGb} GB</TableCell>
                  <TableCell className="text-right font-[var(--font-mono)] text-[var(--color-primary-light)]">
                    {formatUsd(r.costPerHour, { precise: true })}
                  </TableCell>
                  <TableCell className="text-right font-[var(--font-mono)]">
                    {formatUsd(r.costPerDay24h)}
                  </TableCell>
                  <TableCell className="text-right font-[var(--font-mono)]">
                    {formatUsd(r.costPerMonth4hpd)}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
        <p className="mt-3 text-[0.7rem] text-[var(--color-muted-foreground)]">
          $/day assumes 24 hr/day. $/month assumes 4 hr/day × 30 days.
        </p>
      </CardContent>
    </Card>
  );
}

/** Header cell that renders a sort indicator and toggles sort state on click. */
function SortableHeader({
  label,
  sortKey,
  currentKey,
  dir,
  onClick,
  align = 'left',
}: {
  label: string;
  sortKey: SortKey;
  currentKey: SortKey;
  dir: SortDir;
  onClick: (key: SortKey) => void;
  align?: 'left' | 'right';
}) {
  const isActive = sortKey === currentKey;
  const Icon = !isActive ? ArrowUpDown : dir === 'asc' ? ArrowUp : ArrowDown;
  return (
    <TableHead className={align === 'right' ? 'text-right' : undefined}>
      <Button
        variant="ghost"
        size="sm"
        onClick={() => onClick(sortKey)}
        className={cn(
          'h-7 px-1 -mx-1 gap-1 text-xs uppercase tracking-wider text-[var(--color-muted-foreground)] hover:text-[var(--color-foreground)]',
          align === 'right' && 'ml-auto',
          isActive && 'text-[var(--color-foreground)]',
        )}
      >
        {label}
        <Icon className="size-3" aria-hidden="true" />
      </Button>
    </TableHead>
  );
}
