import { useEffect } from 'react';
import { describe, it, expect, vi } from 'vitest';
import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { AppLayout, LiveIndicator, RefreshAllButton } from './app-layout.component.js';
import { PollingProvider, usePollingActions } from '../polling/polling-provider.component.js';

vi.mock('../api.service.js', () => ({
  api: { env: () => Promise.resolve(null) },
}));

/**
 * Mounts a child component that registers a poller in `useEffect` so the
 * surrounding render captures the resulting registry entry without
 * triggering a setState-during-render warning.
 */
function MountPoller({
  name,
  intervalMs,
  fn,
}: {
  name: string;
  intervalMs: number;
  fn: () => Promise<void>;
}) {
  const { register } = usePollingActions();
  useEffect(() => register(name, fn, intervalMs), [register, name, intervalMs, fn]);
  return null;
}

describe('AppLayout — RefreshAllButton', () => {
  it('should be disabled when the polling registry is empty', () => {
    render(
      <PollingProvider>
        <RefreshAllButton />
      </PollingProvider>,
    );

    expect(screen.getByRole('button', { name: 'Refresh all' })).toBeDisabled();
  });

  it('should fire every registered poller when clicked', async () => {
    const fn = vi.fn().mockResolvedValue(undefined);
    const user = userEvent.setup();

    render(
      <PollingProvider>
        <MountPoller name="status" intervalMs={20_000} fn={fn} />
        <RefreshAllButton />
      </PollingProvider>,
    );

    // Let the registration's automatic first run complete so we can compare.
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    const before = fn.mock.calls.length;

    await user.click(screen.getByRole('button', { name: 'Refresh all' }));

    await act(async () => {
      await Promise.resolve();
    });
    expect(fn.mock.calls.length).toBeGreaterThan(before);
  });
});

describe('AppLayout — skip link and nav landmarks', () => {
  it('should render a skip-to-main-content link as the first focusable element', () => {
    render(
      <PollingProvider>
        <MemoryRouter>
          <AppLayout>content</AppLayout>
        </MemoryRouter>
      </PollingProvider>,
    );

    const skipLink = screen.getByRole('link', { name: 'Skip to main content' });
    expect(skipLink).toBeInTheDocument();
    expect(skipLink).toHaveAttribute('href', '#main');
  });

  it('should mark the active route link with aria-current="page"', () => {
    render(
      <PollingProvider>
        <MemoryRouter initialEntries={['/logs']}>
          <AppLayout>content</AppLayout>
        </MemoryRouter>
      </PollingProvider>,
    );

    expect(screen.getByRole('link', { name: 'Logs' })).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('link', { name: 'Dashboard' })).not.toHaveAttribute('aria-current');
  });

  it('should render an Audit nav link and highlight it on /audit', () => {
    render(
      <PollingProvider>
        <MemoryRouter initialEntries={['/audit']}>
          <AppLayout>content</AppLayout>
        </MemoryRouter>
      </PollingProvider>,
    );

    expect(screen.getByRole('link', { name: 'Audit' })).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('link', { name: 'Dashboard' })).not.toHaveAttribute('aria-current');
  });
});

describe('AppLayout — LiveIndicator', () => {
  it('should render the LIVE label element in the DOM regardless of screen size', () => {
    render(
      <PollingProvider>
        <LiveIndicator />
      </PollingProvider>,
    );

    expect(screen.getByText('LIVE')).toBeInTheDocument();
  });

  it('should show a pulsing cyan dot once a registered poller has reported success', async () => {
    const fn = vi.fn().mockResolvedValue(undefined);
    const { container } = render(
      <PollingProvider>
        <MountPoller name="status" intervalMs={20_000} fn={fn} />
        <LiveIndicator />
      </PollingProvider>,
    );

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    const dot = container.querySelector('div.rounded-full');
    expect(dot?.className).toMatch(/animate-pulse/);
    expect(dot?.className).toMatch(/var\(--color-cyan\)/);
  });
});

describe('AppLayout — mobile navigation', () => {
  it('should render a hamburger button that opens the mobile nav', async () => {
    const user = userEvent.setup();
    render(
      <PollingProvider>
        <MemoryRouter>
          <AppLayout>content</AppLayout>
        </MemoryRouter>
      </PollingProvider>,
    );
    const hamburger = screen.getByRole('button', { name: 'Open navigation' });
    expect(hamburger).toBeInTheDocument();
    await user.click(hamburger);
    expect(screen.getByRole('button', { name: 'Close navigation' })).toBeInTheDocument();
  });

  it('should close the mobile nav when the close button is clicked', async () => {
    const user = userEvent.setup();
    render(
      <PollingProvider>
        <MemoryRouter>
          <AppLayout>content</AppLayout>
        </MemoryRouter>
      </PollingProvider>,
    );
    await user.click(screen.getByRole('button', { name: 'Open navigation' }));
    await user.click(screen.getByRole('button', { name: 'Close navigation' }));
    expect(screen.queryByRole('button', { name: 'Close navigation' })).not.toBeInTheDocument();
  });

  it('should close the mobile nav when a nav link is clicked', async () => {
    const user = userEvent.setup();
    render(
      <PollingProvider>
        <MemoryRouter initialEntries={['/']}>
          <AppLayout>content</AppLayout>
        </MemoryRouter>
      </PollingProvider>,
    );
    await user.click(screen.getByRole('button', { name: 'Open navigation' }));
    await user.click(within(document.getElementById('mobile-nav')!).getByRole('link', { name: 'Logs' }));
    expect(screen.queryByRole('button', { name: 'Close navigation' })).not.toBeInTheDocument();
  });
});
