import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, type RenderOptions } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { PollingProvider } from '../polling/polling-provider.component.js';

// Mock the API client so the component drives off canned data instead of real
// fetch calls. `vi.mock` is hoisted above the import so LogsPage picks up the stub.
const apiMock = vi.hoisted(() => ({
  games: vi.fn(),
}));
vi.mock('../api.service.js', () => ({
  api: apiMock,
}));

// Stub window.gsd.logs so the component can open IPC streams without a real
// Electron main process. `stream(game, signal)` returns an async iterable; the
// default stub (set in beforeEach) yields nothing so tests drive off the
// seeded `get` snapshot. Individual tests override `stream` to emit chunks.
const gsdMock = {
  logs: {
    get: vi.fn(),
    stream: vi.fn(),
  },
};
vi.stubGlobal('gsd', gsdMock);

import { LogsPage } from './logs.page.js';

/**
 * `<LogsPage>` reads the polling registry to render the shared
 * {@link PollingIndicator} in its header. The provider is just a registry —
 * it never starts a background fetch on its own — so it's safe to wrap every
 * test render with it without affecting the assertions below.
 */
const renderWithProviders = (
  ui: React.ReactElement,
  opts?: Omit<RenderOptions, 'wrapper'>,
) => render(ui, { wrapper: PollingProvider, ...opts });

const SAMPLE_LINES = [
  '2026-05-03T12:00:00Z INFO Server started on port 25565',
  '2026-05-03T12:00:01Z DEBUG Loaded world "world" in 1.2s',
  '2026-05-03T12:00:02Z WARN Deprecated config option',
  '2026-05-03T12:00:03Z ERROR Connection refused from 10.0.0.5',
  '2026-05-03T12:00:04Z Player joined the game',
];

describe('LogsPage', () => {
  beforeEach(() => {
    apiMock.games.mockResolvedValue({
      games: [{ name: 'minecraft', declared: true, deployed: true }],
    });
    gsdMock.logs.get.mockResolvedValue({ game: 'minecraft', lines: SAMPLE_LINES });
    // Default stream emits nothing and ends immediately — tests assert on the
    // seeded snapshot. Override per-test to drive live chunks through `for await`.
    gsdMock.logs.stream.mockImplementation(async function* () {});
  });

  it('should render the Server Logs heading and the LIVE badge', async () => {
    renderWithProviders(<LogsPage />);

    expect(await screen.findByRole('heading', { name: 'Server Logs' })).toBeInTheDocument();
    expect(screen.getByText('Live', { selector: 'div' })).toBeInTheDocument();
  });

  it('should render seeded log lines once the snapshot resolves', async () => {
    renderWithProviders(<LogsPage />);

    expect(await screen.findByText(/Server started on port 25565/)).toBeInTheDocument();
    expect(screen.getByText(/Connection refused from 10.0.0.5/)).toBeInTheDocument();
  });

  it('should color-code lines containing INFO/WARN/ERROR/DEBUG with badges', async () => {
    renderWithProviders(<LogsPage />);

    // Wait until the first seeded line is rendered, then assert one badge per
    // detected level. The badge text is exact-matched to avoid colliding with
    // the same token inside the underlying log line.
    await screen.findByText(/Server started/);
    for (const lvl of ['INFO', 'WARN', 'ERROR', 'DEBUG']) {
      // The `<Badge>` for a line is a div containing exactly the level text;
      // the same token also appears inside the line itself, so we expect
      // multiple matches and assert on the first.
      const matches = screen.getAllByText(lvl, { exact: true });
      expect(matches.length).toBeGreaterThanOrEqual(1);
    }
  });

  it('should toggle the Pause / Resume button and the LIVE / PAUSED badge', async () => {
    const user = userEvent.setup();
    renderWithProviders(<LogsPage />);
    await screen.findByText(/Server started/);

    await user.click(screen.getByRole('button', { name: 'Pause' }));
    expect(screen.getByText('Paused', { selector: 'div' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Resume' })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Resume' }));
    expect(screen.getByText('Live', { selector: 'div' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Pause' })).toBeInTheDocument();
  });

  it('should highlight matches inside <mark> when typing in the search input', async () => {
    const user = userEvent.setup();
    const { container } = renderWithProviders(<LogsPage />);
    await screen.findByText(/Server started/);

    expect(container.querySelectorAll('mark')).toHaveLength(0);

    await user.type(screen.getByPlaceholderText('Search visible buffer…'), 'Connection');

    const marks = container.querySelectorAll('mark');
    expect(marks.length).toBeGreaterThan(0);
    expect(Array.from(marks).some((m) => m.textContent === 'Connection')).toBe(true);
    // The matched line stays in the buffer — search highlights, never filters.
    expect(screen.getByText(/refused from 10.0.0.5/)).toBeInTheDocument();
  });

  it('should hide ERROR-level lines after unchecking ERROR in the Levels filter', async () => {
    const user = userEvent.setup();
    renderWithProviders(<LogsPage />);
    await screen.findByText(/Server started/);
    expect(screen.getByText(/Connection refused/)).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /Levels/ }));
    await user.click(await screen.findByRole('menuitemcheckbox', { name: 'ERROR' }));

    await waitFor(() => {
      expect(screen.queryByText(/Connection refused/)).toBeNull();
    });
  });

  it('should display "5 lines · oldest …" in the footer for the seeded buffer', async () => {
    renderWithProviders(<LogsPage />);

    expect(await screen.findByText(/^5 lines · oldest /)).toBeInTheDocument();
  });

  it('should call window.gsd.logs.get with the selected game on mount', async () => {
    renderWithProviders(<LogsPage />);

    await waitFor(() => {
      expect(apiMock.games).toHaveBeenCalled();
      expect(gsdMock.logs.get).toHaveBeenCalledWith('minecraft');
    });
  });

  it('should append live chunks yielded by the stream iterator after the seeded snapshot', async () => {
    gsdMock.logs.stream.mockImplementation(async function* () {
      yield '2026-05-03T12:00:05Z INFO Live chunk one';
      yield '2026-05-03T12:00:06Z ERROR Live chunk two';
    });
    renderWithProviders(<LogsPage />);

    // Seeded snapshot first, then the two chunks consumed via `for await`.
    await screen.findByText(/Server started on port 25565/);
    expect(await screen.findByText(/Live chunk one/)).toBeInTheDocument();
    expect(await screen.findByText(/Live chunk two/)).toBeInTheDocument();
  });

  it('should pass the selected game and an AbortSignal to stream', async () => {
    renderWithProviders(<LogsPage />);

    await waitFor(() => {
      expect(gsdMock.logs.stream).toHaveBeenCalledWith('minecraft', expect.any(AbortSignal));
    });
  });
});
