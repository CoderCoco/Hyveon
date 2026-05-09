import { useMemo } from 'react';
import { Server, DollarSign, TrendingUp, Bell } from 'lucide-react';
import { type ActualCosts, type CostEstimates, type GameStatus } from '../api.service.js';
import { cn } from '../lib/utils.utils.js';

interface Props {
  statuses: GameStatus[];
  estimates: CostEstimates | null;
  /** 7-day actual spend, fetched once in `DashboardPage` and shared with `CostPanel`. */
  actualCosts: ActualCosts | null;
}

type AccentColor = 'purple' | 'cyan' | 'orange' | 'pink';

interface TileSpec {
  accent: AccentColor;
  label: string;
  Icon: typeof Server;
  value: string;
  delta?: { text: string; tone: 'good' | 'bad' | 'neutral' } | null;
  spark: number[];
}

/**
 * Tailwind class lookup keyed by accent color and the visual element it
 * styles. Grouped so each tile pulls its rule / bar / icon classes from the
 * same place — `ACCENT.rule[accent]`, `ACCENT.bar[accent]`, etc.
 */
const ACCENT: Record<'rule' | 'bar' | 'icon', Record<AccentColor, string>> = {
  rule: {
    purple: 'bg-[var(--color-primary)]',
    cyan:   'bg-[var(--color-cyan)]',
    orange: 'bg-[var(--color-orange)]',
    pink:   'bg-[var(--color-pink)]',
  },
  bar: {
    purple: 'bg-[var(--color-primary)]',
    cyan:   'bg-[var(--color-cyan)]',
    orange: 'bg-[var(--color-orange)]',
    pink:   'bg-[var(--color-pink)]',
  },
  icon: {
    purple: 'text-[var(--color-primary-light)]',
    cyan:   'text-[var(--color-cyan-light)]',
    orange: 'text-[var(--color-orange)]',
    pink:   'text-[var(--color-pink)]',
  },
};

/** Pad a daily-cost array to 7 entries (most recent last) so the sparkline has a stable bar count. */
function pad7(values: number[]): number[] {
  const trimmed = values.slice(-7);
  if (trimmed.length === 7) return trimmed;
  return [...new Array<number>(7 - trimmed.length).fill(0), ...trimmed];
}

/** Calendar days in the current month — used by both forecast and budget calculations to keep them aligned. */
function currentMonthDays(): number {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
}

/** Forecast a month-end total by extrapolating average-daily-spend over the calendar month. */
function forecastMonthly(actual: ActualCosts | null, daysInMonth: number): number | null {
  if (!actual?.daily?.length) return null;
  const avg = actual.total / Math.max(actual.days, 1);
  return avg * daysInMonth;
}

/** Returns "+12.3%", "-4.1%", or null when comparison isn't meaningful. */
function pctChange(today: number, yesterday: number): { text: string; tone: 'good' | 'bad' | 'neutral' } | null {
  if (yesterday <= 0) return null;
  const ratio = (today - yesterday) / yesterday;
  const sign = ratio >= 0 ? '+' : '';
  const text = `${sign}${(ratio * 100).toFixed(1)}% vs yesterday`;
  // For spend, lower is better — invert tone.
  const tone: 'good' | 'bad' | 'neutral' = ratio === 0 ? 'neutral' : ratio < 0 ? 'good' : 'bad';
  return { text, tone };
}

/**
 * KPI strip rendered at the top of the Dashboard. Shows four tiles —
 * Servers running, Spend today, Forecast MTD, Active alerts — each with a
 * top color accent rule and a 7-bar sparkline beneath the value. Sparkline
 * data for cost-related tiles comes from `/api/costs/actual` (7 days);
 * non-cost tiles reuse the same series as a coarse activity proxy because
 * we don't keep historical counts of running servers / alerts.
 */
export function KpiStrip({ statuses, estimates, actualCosts }: Props) {
  const tiles = useMemo<TileSpec[]>(() => {
    const total = statuses.length;
    const running = statuses.filter((s) => s.state === 'running').length;
    const errors  = statuses.filter((s) => s.state === 'error').length;

    // Cost Explorer can be unavailable (no IAM permission, opt-in not enabled,
    // or the call errored on the server). In any of those cases the API
    // returns `{ daily: [], total: 0, error: '...' }` — treat that as "no
    // data" and render `—` instead of misleading $0.00 values.
    const costsAvailable = !!actualCosts && actualCosts.daily.length > 0 && !actualCosts.error;
    const dailySeries = pad7(costsAvailable ? actualCosts.daily.map((d) => d.cost) : []);
    const today = dailySeries[dailySeries.length - 1] ?? 0;
    const yest  = dailySeries[dailySeries.length - 2] ?? 0;
    const daysInMonth = currentMonthDays();
    const forecast = costsAvailable ? forecastMonthly(actualCosts, daysInMonth) : null;

    const totalIfAllOn = estimates?.totalPerHourIfAllOn ?? 0;
    const budgetText = totalIfAllOn > 0 && forecast !== null
      ? `$${(totalIfAllOn * 24 * daysInMonth).toFixed(0)} all-on cap`
      : null;

    // For non-cost tiles, fall back to flat zeros when costs are unavailable
    // so the sparkline doesn't show a stale series from an earlier render.
    const baselineSpark = costsAvailable ? dailySeries : new Array<number>(7).fill(0);

    return [
      {
        accent: 'purple',
        label: 'Servers running',
        Icon: Server,
        value: total === 0 ? '—' : `${running}/${total}`,
        delta: total === 0
          ? null
          : { text: running === 0 ? 'all idle' : `${running} active`, tone: 'neutral' },
        spark: baselineSpark,
      },
      {
        accent: 'cyan',
        label: 'Spend today',
        Icon: DollarSign,
        value: costsAvailable ? `$${today.toFixed(2)}` : '—',
        delta: costsAvailable ? pctChange(today, yest) : null,
        spark: baselineSpark,
      },
      {
        accent: 'orange',
        label: 'Forecast MTD',
        Icon: TrendingUp,
        value: forecast !== null ? `$${forecast.toFixed(2)}` : '—',
        delta: budgetText ? { text: budgetText, tone: 'neutral' } : null,
        spark: baselineSpark,
      },
      {
        accent: 'pink',
        label: 'Active alerts',
        Icon: Bell,
        value: String(errors),
        delta: errors === 0
          ? { text: 'all healthy', tone: 'good' }
          : { text: `${errors} need attention`, tone: 'bad' },
        spark: errors === 0 ? new Array<number>(7).fill(0) : baselineSpark,
      },
    ];
  }, [statuses, estimates, actualCosts]);

  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
      {tiles.map((t) => (
        <KpiTile key={t.label} {...t} />
      ))}
    </div>
  );
}

function KpiTile({ accent, label, Icon, value, delta, spark }: TileSpec) {
  const max = Math.max(...spark, 0.001);

  return (
    <div className="relative overflow-hidden rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-[var(--color-surface)] p-4">
      {/* Top accent rule */}
      <div className={cn('absolute top-0 left-0 right-0 h-0.5', ACCENT.rule[accent])} />

      <div className="flex items-center justify-between mb-3">
        <span className="text-[0.7rem] font-medium uppercase tracking-wider text-[var(--color-muted-foreground)]">
          {label}
        </span>
        <Icon className={cn('size-4', ACCENT.icon[accent])} aria-hidden="true" />
      </div>

      <div className="font-[var(--font-ui)] text-2xl font-bold leading-none mb-2 text-[var(--color-foreground)]">
        {value}
      </div>

      {delta && (
        <div
          className={cn(
            'text-[0.7rem] mb-2',
            delta.tone === 'good' && 'text-[var(--color-green)]',
            delta.tone === 'bad'  && 'text-[var(--color-red)]',
            delta.tone === 'neutral' && 'text-[var(--color-muted-foreground)]',
          )}
        >
          {delta.text}
        </div>
      )}

      {/* Sparkline */}
      <div className="flex items-end gap-[3px] h-6 mt-2" aria-hidden="true">
        {spark.map((v, i) => (
          <div
            key={i}
            className={cn('flex-1 rounded-t-sm opacity-60', ACCENT.bar[accent])}
            style={{ height: `${Math.max((v / max) * 100, 6)}%` }}
          />
        ))}
      </div>
    </div>
  );
}
