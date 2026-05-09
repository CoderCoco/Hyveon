import { ReactNode, useEffect, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { api, type EnvInfo } from '../api.service.js';
import { cn } from '../lib/utils.utils.js';
import { Button } from '@/components/ui/button.component';
import { isStale, usePollingActions, usePollingState } from '../polling/polling-provider.component.js';
import {
  LayoutDashboard,
  Server,
  ScrollText,
  BarChart3,
  Bell,
  MessageSquare,
  Settings,
  RefreshCw,
} from 'lucide-react';

interface NavItem {
  to: string;
  icon: typeof LayoutDashboard;
  label: string;
  disabled?: boolean;
}

const monitoringItems: NavItem[] = [
  { to: '/', icon: LayoutDashboard, label: 'Dashboard' },
  { to: '/servers', icon: Server, label: 'Servers', disabled: true },
  { to: '/logs', icon: ScrollText, label: 'Logs' },
  { to: '/metrics', icon: BarChart3, label: 'Metrics', disabled: true },
  { to: '/alerts', icon: Bell, label: 'Alerts', disabled: true },
];

const configItems: NavItem[] = [
  { to: '/discord', icon: MessageSquare, label: 'Discord' },
  { to: '/settings', icon: Settings, label: 'Settings' },
];

/**
 * Navigation shell — persistent sidebar + top bar that wraps all routed pages.
 * Sidebar shows "Monitoring" and "Configuration" sections with active-route
 * highlighting (purple gradient + 2px left accent). Top bar displays env pill
 * (e.g. "PROD · us-east-1"), search placeholder, and LIVE indicator.
 */
export function AppLayout({ children }: { children: ReactNode }) {
  const location = useLocation();
  const [env, setEnv] = useState<EnvInfo | null>(null);

  useEffect(() => {
    api.env().then(setEnv).catch(console.error);
  }, []);

  const envLabel = env
    ? `${env.environment} · ${env.region}`
    : 'local';

  return (
    <div className="flex h-screen bg-background">
      {/* Skip-to-content link — first focusable element, revealed on focus */}
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:fixed focus:top-4 focus:left-4 focus:z-50 focus:px-4 focus:py-2 focus:bg-card focus:text-foreground focus:rounded-[var(--radius-md)] focus:ring-2 focus:ring-[var(--color-primary)] focus:outline-none"
      >
        Skip to main content
      </a>

      {/* Sidebar */}
      <aside className="w-60 border-r border-border bg-card flex flex-col">
        {/* Brand */}
        <div className="px-4 py-5 border-b border-border">
          <div className="flex items-center gap-2">
            <div className="w-8 h-8 rounded bg-gradient-to-br from-purple-500 to-purple-700 flex items-center justify-center" aria-hidden="true">
              <Server className="w-5 h-5 text-white" />
            </div>
            <span className="font-semibold text-foreground">Game Servers</span>
          </div>
        </div>

        {/* Nav sections */}
        <nav aria-label="Main navigation" className="flex-1 overflow-y-auto px-3 py-4 space-y-6">
          {/* Monitoring */}
          <div>
            <p id="nav-monitoring" className="px-3 mb-2 text-xs font-semibold text-muted-foreground uppercase tracking-wider">
              Monitoring
            </p>
            <ul aria-labelledby="nav-monitoring" className="space-y-1 list-none">
              {monitoringItems.map((item) => (
                <li key={item.to + item.label}>
                  <NavLink item={item} active={location.pathname === item.to} />
                </li>
              ))}
            </ul>
          </div>

          {/* Configuration */}
          <div>
            <p id="nav-configuration" className="px-3 mb-2 text-xs font-semibold text-muted-foreground uppercase tracking-wider">
              Configuration
            </p>
            <ul aria-labelledby="nav-configuration" className="space-y-1 list-none">
              {configItems.map((item) => (
                <li key={item.to + item.label}>
                  <NavLink item={item} active={location.pathname === item.to} />
                </li>
              ))}
            </ul>
          </div>
        </nav>
      </aside>

      {/* Main content */}
      <div className="flex-1 flex flex-col overflow-hidden">
        {/* Top bar */}
        <header className="h-14 border-b border-border bg-card flex items-center justify-between px-6">
          <div className="flex items-center gap-4">
            <h1 className="text-lg font-semibold text-foreground">Game Server Manager</h1>
            <span className="inline-flex items-center px-2.5 py-0.5 rounded text-xs font-medium bg-purple-500/10 text-purple-400 border border-purple-500/20">
              {envLabel}
            </span>
          </div>

          <div className="flex items-center gap-4">
            {/* Search placeholder — not yet functional; hidden from keyboard/screen readers */}
            <div className="relative" aria-hidden="true">
              <input
                type="text"
                placeholder="Search... ⌘K"
                className="w-64 px-3 py-1.5 text-sm bg-muted border border-border rounded focus:outline-none focus:ring-2 focus:ring-purple-500/50"
                readOnly
                tabIndex={-1}
              />
            </div>

            <RefreshAllButton />
            <LiveIndicator />

            {/* Avatar placeholder — decorative */}
            <div
              className="w-8 h-8 rounded-full bg-gradient-to-br from-purple-500 to-purple-700 flex items-center justify-center"
              aria-hidden="true"
            >
              <span className="text-xs font-medium text-white">OP</span>
            </div>
          </div>
        </header>

        {/* Page content */}
        <main id="main" className="flex-1 overflow-auto p-8">
          {children}
        </main>
      </div>
    </div>
  );
}

/**
 * Top-bar Refresh button — triggers every active poller in the registry. The
 * icon spins while at least one poll is in flight so the operator gets a brief
 * loading affordance even if the underlying call returns instantly.
 */
export function RefreshAllButton() {
  const { refreshAll } = usePollingActions();
  const { pollers } = usePollingState();
  const anyLoading = Object.values(pollers).some((p) => p.loading);
  return (
    <Button
      variant="secondary"
      size="sm"
      onClick={() => void refreshAll()}
      aria-label="Refresh all"
      aria-busy={anyLoading}
      disabled={Object.keys(pollers).length === 0}
    >
      <RefreshCw className={cn('size-3.5', anyLoading && 'motion-safe:animate-spin')} aria-hidden="true" />
      Refresh
    </Button>
  );
}

/**
 * Top-bar LIVE indicator — pulses cyan while at least one poller has a fresh
 * success, dims gray when every poller is past 2× its interval, and goes
 * neutral when no pollers are registered yet.
 */
export function LiveIndicator() {
  const { pollers, tick } = usePollingState();
  void tick;
  const now = Date.now();
  const entries = Object.values(pollers);
  const anyFresh = entries.some((p) => p.lastSuccessAt !== null && !isStale(p, now));
  const allStale = entries.length > 0 && entries.every((p) => isStale(p, now));
  const dotClass = anyFresh
    ? 'bg-[var(--color-cyan)] motion-safe:animate-pulse'
    : allStale
      ? 'bg-[var(--color-muted-foreground)]/60'
      : 'bg-[var(--color-muted-foreground)]/40';
  const labelClass = allStale
    ? 'text-[var(--color-muted-foreground)]/60'
    : 'text-muted-foreground';
  const statusLabel = anyFresh ? 'Live — data is current' : allStale ? 'Stale — data may be out of date' : 'Connecting';
  return (
    <div
      className="flex items-center gap-2 px-3 py-1.5 bg-muted rounded border border-border"
      role="status"
      aria-label={statusLabel}
    >
      <div className={cn('w-2 h-2 rounded-full', dotClass)} aria-hidden="true" />
      <span className={cn('text-xs font-medium', labelClass)} aria-hidden="true">LIVE</span>
    </div>
  );
}

function NavLink({ item, active }: { item: NavItem; active: boolean }) {
  const Icon = item.icon;
  const className = cn(
    'relative flex items-center gap-3 px-3 py-2 rounded-md text-sm font-medium transition-colors',
    item.disabled && 'text-muted-foreground/40 cursor-not-allowed',
    !item.disabled && active && 'bg-gradient-to-r from-purple-500/10 to-transparent text-purple-400 before:absolute before:left-0 before:top-0 before:bottom-0 before:w-0.5 before:bg-purple-500 before:rounded-full',
    !item.disabled && !active && 'text-muted-foreground hover:text-foreground hover:bg-accent',
  );
  if (item.disabled) {
    return (
      <span className={className} aria-disabled="true">
        <Icon className="w-4 h-4" aria-hidden="true" />
        {item.label}
      </span>
    );
  }
  return (
    <Link to={item.to} className={className} aria-current={active ? 'page' : undefined}>
      <Icon className="w-4 h-4" aria-hidden="true" />
      {item.label}
    </Link>
  );
}
