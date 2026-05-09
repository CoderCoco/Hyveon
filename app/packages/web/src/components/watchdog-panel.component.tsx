import { useState, useEffect, useId } from 'react';
import { HelpCircle } from 'lucide-react';
import { toast } from 'sonner';
import { api, type WatchdogConfig } from '../api.service.js';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip.component';

/**
 * Bottom-right dashboard panel that reads and writes the three watchdog knobs
 * via `/api/config`. Note these settings tune the in-app behaviour only — the
 * Lambda's EventBridge schedule is baked in at `terraform apply` time.
 */
export function WatchdogPanel() {
  const [cfg, setCfg] = useState<WatchdogConfig>({
    watchdog_interval_minutes: 15,
    watchdog_idle_checks: 4,
    watchdog_min_packets: 100,
  });
  useEffect(() => {
    void api.config().then(setCfg);
  }, []);

  const idleMinutes = cfg.watchdog_interval_minutes * cfg.watchdog_idle_checks;

  async function handleSave() {
    try {
      await api.saveConfig(cfg);
      toast.success('Watchdog settings saved');
    } catch (err) {
      toast.error('Failed to save watchdog settings', {
        description: err instanceof Error ? err.message : 'An unknown error occurred',
      });
    }
  }

  return (
    <TooltipProvider delayDuration={150}>
      <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: '12px', padding: '1.25rem' }}>
        <p style={{ fontSize: '0.75rem', textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--text-dim)', marginBottom: '1rem' }}>
          Watchdog Settings
        </p>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.6rem' }}>
          <Field
            label="Check interval (min)"
            tooltip="How often the watchdog inspects each running task. Lower = faster shutdown, higher = less CPU."
            value={cfg.watchdog_interval_minutes}
            onChange={(v) => setCfg((c) => ({ ...c, watchdog_interval_minutes: v }))}
          />
          <Field
            label="Idle checks before shutdown"
            tooltip="Number of consecutive idle checks before the task stops. With 5 min interval × 5 checks = 25 idle minutes."
            value={cfg.watchdog_idle_checks}
            onChange={(v) => setCfg((c) => ({ ...c, watchdog_idle_checks: v }))}
          />
          <Field
            label="Min packets (activity threshold)"
            tooltip="If a task receives fewer than this many network packets in an interval, it counts as idle."
            value={cfg.watchdog_min_packets}
            onChange={(v) => setCfg((c) => ({ ...c, watchdog_min_packets: v }))}
          />
        </div>
        <p style={{ fontSize: '0.72rem', color: 'var(--text-dim)', marginTop: '0.6rem' }}>
          Auto-shutdown after {idleMinutes} minutes idle ({cfg.watchdog_interval_minutes} min × {cfg.watchdog_idle_checks} checks).
          Update Terraform vars to change the Lambda schedule.
        </p>
        <div style={{ marginTop: '0.75rem' }}>
          <button className="btn-secondary btn-sm" onClick={() => void handleSave()}>
            Save
          </button>
        </div>
      </div>
    </TooltipProvider>
  );
}

function Field({
  label,
  tooltip,
  value,
  onChange,
}: {
  label: string;
  tooltip: string;
  value: number;
  onChange: (v: number) => void;
}) {
  const id = useId();
  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: '0.25rem', marginBottom: '0.2rem' }}>
        <label htmlFor={id} style={{ fontSize: '0.72rem', color: 'var(--text-dim)' }}>
          {label}
        </label>
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              aria-label={`${label} help`}
              style={{ display: 'inline-flex', alignItems: 'center', background: 'none', border: 'none', padding: 0, cursor: 'help', color: 'inherit' }}
            >
              <HelpCircle style={{ width: '0.7rem', height: '0.7rem', flexShrink: 0 }} />
            </button>
          </TooltipTrigger>
          <TooltipContent side="top" className="max-w-56">
            {tooltip}
          </TooltipContent>
        </Tooltip>
      </div>
      <input
        id={id}
        type="number"
        value={value}
        onChange={(e) => onChange(parseInt(e.target.value, 10) || 0)}
        style={{ width: '100%', padding: '0.4rem 0.6rem', background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: '6px', color: 'var(--text)', fontSize: '0.82rem' }}
      />
    </div>
  );
}
