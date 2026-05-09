import { useEffect } from 'react';
import { describe, it, expect } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { PollingIndicator } from './polling-indicator.component.js';
import { PollingProvider, usePollingActions } from './polling-provider.component.js';

/**
 * Mounts a child component that registers a poller under `name` with the
 * given interval, so the indicator has an entry to render against. Runs the
 * registration in `useEffect` to avoid a setState-during-render warning.
 */
function PollerSeed({ name, intervalMs }: { name: string; intervalMs: number }) {
  const { register } = usePollingActions();
  useEffect(
    () => register(name, () => Promise.resolve(), intervalMs),
    [register, name, intervalMs],
  );
  return null;
}

/**
 * Wait for any registered poller's `runOne` to finish. The provider's
 * `register()` immediately schedules `runOne` which runs through two
 * microtasks (set loading, await fn, set lastSuccessAt), so we flush a
 * couple of times before asserting the result.
 */
async function flushPolls() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe('PollingIndicator', () => {
  it('should render the "Not polling" placeholder when no poller is registered under the name', () => {
    render(
      <PollingProvider>
        <PollingIndicator name="missing" />
      </PollingProvider>,
    );

    expect(screen.getByText('Not polling')).toBeInTheDocument();
  });

  it('should render an "Updated …" label once a registered poller has resolved', async () => {
    render(
      <PollingProvider>
        <PollerSeed name="status" intervalMs={20_000} />
        <PollingIndicator />
      </PollingProvider>,
    );

    await flushPolls();

    expect(screen.getByText(/^Updated\b/)).toBeInTheDocument();
  });

  it('should remove the poller from the registry when the registering component unmounts', async () => {
    // Regression: the cleanup closure used to check `cur.timerId === timerId`,
    // but runOne() replaces the initial timer before register() returns, so
    // the check was always false and cleanups were silently no-ops, leaking
    // pollers indefinitely. Now register() uses a stable Symbol (regId) that
    // runOne() never touches, so the cleanup always fires correctly.
    function ConditionalPoller({ show }: { show: boolean }) {
      return show ? <PollerSeed name="cleanup-test" intervalMs={20_000} /> : null;
    }

    const { rerender } = render(
      <PollingProvider>
        <ConditionalPoller show={true} />
        <PollingIndicator name="cleanup-test" />
      </PollingProvider>,
    );

    await flushPolls();
    expect(screen.getByText(/^Updated\b/)).toBeInTheDocument();

    // Unmount the PollerSeed — the cleanup must remove the entry from the
    // registry so the indicator falls back to "Not polling".
    await act(async () => {
      rerender(
        <PollingProvider>
          <ConditionalPoller show={false} />
          <PollingIndicator name="cleanup-test" />
        </PollingProvider>,
      );
    });

    expect(screen.getByText('Not polling')).toBeInTheDocument();
  });

  it('should have role="status" so screen readers announce updates', async () => {
    render(
      <PollingProvider>
        <PollerSeed name="status" intervalMs={20_000} />
        <PollingIndicator />
      </PollingProvider>,
    );

    await flushPolls();

    expect(screen.getByRole('status')).toBeInTheDocument();
  });

  it('should expose the next-poll countdown via the tooltip on hover', async () => {
    const user = userEvent.setup();
    render(
      <PollingProvider>
        <PollerSeed name="status" intervalMs={20_000} />
        <PollingIndicator />
      </PollingProvider>,
    );

    await flushPolls();

    await user.hover(screen.getByText(/^Updated\b/));

    // Radix renders the tooltip body twice (visual bubble + screen-reader
    // copy), so we accept any number of matches.
    expect((await screen.findAllByText(/next refresh in \d+s/)).length).toBeGreaterThan(0);
  });
});
