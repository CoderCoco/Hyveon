import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { AuditEntry, AuditPageResult } from '../api.service.js';

const apiMock = vi.hoisted(() => ({
  status: vi.fn(),
  costsEstimate: vi.fn(),
  audit: vi.fn(),
}));
vi.mock('../api.service.js', () => ({ api: apiMock }));

import { AuditPage } from './audit.page.js';
import { renderPage } from '../test-utils/render-page.utils.js';

/** First page of two audit entries, with a cursor to an older page. */
const PAGE_ONE: AuditPageResult = {
  entries: [
    {
      sk: '2026-07-02T00:00:00.000Z#01J001',
      timestamp: '2026-07-02T00:00:00.000Z',
      actor: 'alice',
      action: 'edit',
      game: 'minecraft',
      before: { name: 'minecraft', image: 'itzg/minecraft-server:1', cpu: 1024, memory: 2048, ports: [], volumes: [] },
      after: { name: 'minecraft', image: 'itzg/minecraft-server:2', cpu: 1024, memory: 2048, ports: [], volumes: [] },
      versionId: 'v-2',
    },
    {
      sk: '2026-07-01T00:00:00.000Z#01J000',
      timestamp: '2026-07-01T00:00:00.000Z',
      actor: 'bob',
      action: 'add',
      game: 'valheim',
      before: null,
      after: { name: 'valheim', image: 'lloesche/valheim-server', cpu: 512, memory: 1024, ports: [], volumes: [] },
      versionId: 'v-1',
    },
  ],
  nextBefore: '2026-07-01T00:00:00.000Z#01J000',
};

/** Second, older page — no `nextBefore`, so "Load more" disappears after it's fetched. */
const PAGE_TWO: AuditPageResult = {
  entries: [
    {
      sk: '2026-06-30T00:00:00.000Z#01J-1',
      timestamp: '2026-06-30T00:00:00.000Z',
      actor: 'carol',
      action: 'remove',
      game: 'terraria',
      before: { name: 'terraria', image: 'ryshe/terraria', cpu: 512, memory: 1024, ports: [], volumes: [] },
      after: null,
    },
  ],
};

function entryFixture(overrides: Partial<AuditEntry> = {}): AuditEntry {
  return {
    sk: '2026-07-01T00:00:00.000Z#01J000',
    timestamp: '2026-07-01T00:00:00.000Z',
    actor: 'bob',
    action: 'add',
    game: 'valheim',
    before: null,
    after: { name: 'valheim', image: 'lloesche/valheim-server', cpu: 512, memory: 1024, ports: [], volumes: [] },
    ...overrides,
  };
}

describe('AuditPage', () => {
  beforeEach(() => {
    apiMock.status.mockResolvedValue([]);
    apiMock.costsEstimate.mockResolvedValue({ games: {}, totalPerHourIfAllOn: 0 });
    apiMock.audit.mockReset();
  });

  it('should fetch api.audit({ limit: 25 }) on mount', async () => {
    apiMock.audit.mockResolvedValue({ entries: [] });

    renderPage(<AuditPage />, { initialEntries: ['/audit'] });

    await waitFor(() => expect(apiMock.audit).toHaveBeenCalledWith({ limit: 25 }));
  });

  it('should render a loading state before the audit fetch resolves', () => {
    apiMock.audit.mockReturnValue(new Promise(() => {}));

    renderPage(<AuditPage />, { initialEntries: ['/audit'] });

    expect(screen.getByText(/loading/i)).toBeInTheDocument();
  });

  it('should render an empty state when there are no audit entries', async () => {
    apiMock.audit.mockResolvedValue({ entries: [] });

    renderPage(<AuditPage />, { initialEntries: ['/audit'] });

    expect(await screen.findByText('No audit entries yet.')).toBeInTheDocument();
  });

  it('should render an error state when the audit fetch fails', async () => {
    apiMock.audit.mockRejectedValue(new Error('boom'));

    renderPage(<AuditPage />, { initialEntries: ['/audit'] });

    expect(await screen.findByText('Could not load the audit log.')).toBeInTheDocument();
  });

  it('should render rows showing the timestamp, actor, action, game, and versionId for each entry', async () => {
    apiMock.audit.mockResolvedValue(PAGE_ONE);

    renderPage(<AuditPage />, { initialEntries: ['/audit'] });

    expect(await screen.findByText('alice')).toBeInTheDocument();
    expect(screen.getByText('edit')).toBeInTheDocument();
    expect(screen.getByText('minecraft')).toBeInTheDocument();
    expect(screen.getByText('v-2')).toBeInTheDocument();
    expect(screen.getByText('bob')).toBeInTheDocument();
    expect(screen.getByText('add')).toBeInTheDocument();
    expect(screen.getByText('valheim')).toBeInTheDocument();
    expect(screen.getByText('v-1')).toBeInTheDocument();
  });

  it('should expand a row to show the before/after JSON diff and collapse it again on a second click', async () => {
    apiMock.audit.mockResolvedValue({ entries: [entryFixture()] });

    renderPage(<AuditPage />, { initialEntries: ['/audit'] });

    await screen.findByText('bob');
    expect(screen.queryByText(/lloesche\/valheim-server/, { selector: 'pre' })).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: /expand diff/i }));
    expect(screen.getByText(/lloesche\/valheim-server/, { selector: 'pre' })).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: /collapse diff/i }));
    expect(screen.queryByText(/lloesche\/valheim-server/, { selector: 'pre' })).not.toBeInTheDocument();
  });

  it('should show a "Load more" button when nextBefore is present, and hide it once the last page loads', async () => {
    apiMock.audit.mockResolvedValue(PAGE_ONE);

    renderPage(<AuditPage />, { initialEntries: ['/audit'] });

    await screen.findByText('alice');
    expect(screen.getByRole('button', { name: /load more/i })).toBeInTheDocument();
  });

  it('should not show a "Load more" button when the page has no nextBefore', async () => {
    apiMock.audit.mockResolvedValue({ entries: [entryFixture()] });

    renderPage(<AuditPage />, { initialEntries: ['/audit'] });

    await screen.findByText('bob');
    expect(screen.queryByRole('button', { name: /load more/i })).not.toBeInTheDocument();
  });

  it('should pass nextBefore as before and append the next page of entries when "Load more" is clicked', async () => {
    apiMock.audit.mockResolvedValueOnce(PAGE_ONE).mockResolvedValueOnce(PAGE_TWO);

    renderPage(<AuditPage />, { initialEntries: ['/audit'] });

    await screen.findByText('alice');
    await userEvent.click(screen.getByRole('button', { name: /load more/i }));

    await waitFor(() =>
      expect(apiMock.audit).toHaveBeenCalledWith({ limit: 25, before: PAGE_ONE.nextBefore }),
    );

    // Both the original page's rows and the newly appended page's row are present.
    expect(await screen.findByText('carol')).toBeInTheDocument();
    expect(screen.getByText('alice')).toBeInTheDocument();
    expect(screen.getByText('bob')).toBeInTheDocument();

    // The last page has no nextBefore, so "Load more" is gone.
    expect(screen.queryByRole('button', { name: /load more/i })).not.toBeInTheDocument();
  });
});
