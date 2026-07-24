import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const apiMock = vi.hoisted(() => ({
  status: vi.fn(),
  costsEstimate: vi.fn(),
}));
vi.mock('../api.service.js', () => ({ api: apiMock }));

/**
 * Stub for `react-router-dom`'s `useNavigate`, keeping every other export
 * (`Link`, `MemoryRouter`, ...) real — the rollback flow's `handleRolledBack`
 * navigates to `/terraform`, and this lets tests assert on the call without
 * standing up a second routed page.
 */
const navigateMock = vi.hoisted(() => vi.fn());
vi.mock('react-router-dom', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-router-dom')>();
  return { ...actual, useNavigate: () => navigateMock };
});

/** Stub for `window.gsd.terraform.runs.list` and the rollback flow's two IPC channels. */
const gsdMock = {
  terraform: {
    runs: {
      list: vi.fn(),
    },
    rollback: {
      resolve: vi.fn(),
      confirm: vi.fn(),
    },
  },
};
vi.stubGlobal('gsd', gsdMock);

import { TerraformHistoryPage } from './terraform-history.page.js';
import { renderPage } from '../test-utils/render-page.utils.js';

/** Builds a sample `RunHistoryRecord`, overridable per-test. */
function makeRecord(overrides: Record<string, unknown> = {}) {
  return {
    sk: '2026-07-17T00:00:00.000Z#run-1',
    runId: 'run-1',
    kind: 'apply',
    status: 'success',
    startedAt: '2026-07-17T00:00:00.000Z',
    completedAt: '2026-07-17T00:05:00.000Z',
    exitCode: 0,
    ...overrides,
  };
}

describe('TerraformHistoryPage', () => {
  beforeEach(() => {
    apiMock.status.mockResolvedValue([]);
    apiMock.costsEstimate.mockResolvedValue({ games: {}, totalPerHourIfAllOn: 0 });
    gsdMock.terraform.runs.list.mockReset();
    gsdMock.terraform.rollback.resolve.mockReset();
    gsdMock.terraform.rollback.confirm.mockReset();
    navigateMock.mockClear();
  });

  it('should render recent runs newest-first with kind, status, and timestamps', async () => {
    gsdMock.terraform.runs.list.mockResolvedValue({ records: [makeRecord()] });
    renderPage(<TerraformHistoryPage />);

    expect(await screen.findByText('apply')).toBeInTheDocument();
    const table = screen.getByRole('table');
    expect(within(table).getByText('Success')).toBeInTheDocument();
  });

  it('should show the empty state when no runs match the current filters', async () => {
    gsdMock.terraform.runs.list.mockResolvedValue({ records: [] });
    renderPage(<TerraformHistoryPage />);

    expect(await screen.findByText(/No runs match the current filters\./)).toBeInTheDocument();
  });

  it('should fetch the next, older page and append it when Load more is clicked', async () => {
    gsdMock.terraform.runs.list.mockResolvedValueOnce({
      records: [makeRecord({ runId: 'run-1', sk: 'sk-1' })],
      nextBefore: 'sk-1',
    });
    renderPage(<TerraformHistoryPage />);
    await screen.findByText('apply');

    gsdMock.terraform.runs.list.mockResolvedValueOnce({
      records: [makeRecord({ runId: 'run-2', sk: 'sk-2', kind: 'plan' })],
    });
    await userEvent.click(screen.getByRole('button', { name: /Load more/ }));

    expect(await screen.findByText('plan')).toBeInTheDocument();
    expect(gsdMock.terraform.runs.list).toHaveBeenLastCalledWith({ limit: 25, before: 'sk-1', status: undefined });
  });

  it('should re-fetch with the selected status filter', async () => {
    gsdMock.terraform.runs.list.mockResolvedValue({ records: [makeRecord({ status: 'failed' })] });
    renderPage(<TerraformHistoryPage />);
    await screen.findByText('apply');

    await userEvent.selectOptions(screen.getByLabelText('Status'), 'failed');

    await waitFor(() =>
      expect(gsdMock.terraform.runs.list).toHaveBeenLastCalledWith({ limit: 25, status: 'failed' }),
    );
  });

  it('should apply the kind filter client-side without an extra fetch', async () => {
    gsdMock.terraform.runs.list.mockResolvedValue({
      records: [makeRecord({ runId: 'run-apply', kind: 'apply' }), makeRecord({ runId: 'run-plan', sk: 'sk-2', kind: 'plan' })],
    });
    renderPage(<TerraformHistoryPage />);
    await screen.findByText('apply');
    const callCountBefore = gsdMock.terraform.runs.list.mock.calls.length;

    await userEvent.selectOptions(screen.getByLabelText('Kind'), 'plan');

    expect(screen.queryByText('apply')).not.toBeInTheDocument();
    expect(screen.getByText('plan')).toBeInTheDocument();
    expect(gsdMock.terraform.runs.list.mock.calls.length).toBe(callCountBefore);
  });

  it('should link each row to its run-detail route', async () => {
    gsdMock.terraform.runs.list.mockResolvedValue({ records: [makeRecord({ runId: 'run-42' })] });
    renderPage(<TerraformHistoryPage />);

    const link = await screen.findByRole('link', { name: 'apply' });
    expect(link).toHaveAttribute('href', '/terraform/history/run-42');
  });

  it('should show approvedBy when present, else an em dash', async () => {
    gsdMock.terraform.runs.list.mockResolvedValue({
      records: [makeRecord({ runId: 'run-1', approvedBy: 'alice' }), makeRecord({ runId: 'run-2', sk: 'sk-2', kind: 'plan' })],
    });
    renderPage(<TerraformHistoryPage />);

    const rows = await screen.findAllByRole('row');
    const bodyRows = rows.slice(1);
    expect(within(bodyRows[0]!).getByText('alice')).toBeInTheDocument();
    expect(within(bodyRows[1]!).getByText('—')).toBeInTheDocument();
  });

  describe('rollback action (#112)', () => {
    it('should show a Rollback button only for apply rows that recorded a tfvarsVersionId', async () => {
      gsdMock.terraform.runs.list.mockResolvedValue({
        records: [
          makeRecord({ runId: 'apply-with-version', kind: 'apply', tfvarsVersionId: 'v-1' }),
          makeRecord({ runId: 'apply-without-version', sk: 'sk-2', kind: 'apply' }),
          makeRecord({ runId: 'plan-with-version', sk: 'sk-3', kind: 'plan', tfvarsVersionId: 'v-2' }),
        ],
      });
      renderPage(<TerraformHistoryPage />);
      await screen.findAllByRole('row');

      const rollbackButtons = await screen.findAllByRole('button', { name: 'Rollback' });
      expect(rollbackButtons).toHaveLength(1);
    });

    it('should resolve the rollback target and open a confirmation dialog naming it on click', async () => {
      gsdMock.terraform.runs.list.mockResolvedValue({
        records: [makeRecord({ runId: 'apply-1', kind: 'apply', tfvarsVersionId: 'v-1' })],
      });
      gsdMock.terraform.rollback.resolve.mockResolvedValue({
        resolved: true,
        versionId: 'v-prior',
        lastModified: '2026-07-18T00:00:00.000Z',
      });
      renderPage(<TerraformHistoryPage />);

      await userEvent.click(await screen.findByRole('button', { name: 'Rollback' }));

      expect(gsdMock.terraform.rollback.resolve).toHaveBeenCalledWith({ applyRunId: 'apply-1' });
      const dialog = await screen.findByRole('alertdialog');
      expect(within(dialog).getByText(/v-prior/)).toBeInTheDocument();
      expect(gsdMock.terraform.rollback.confirm).not.toHaveBeenCalled();
    });

    it('should surface a resolve failure inline without opening a confirmation dialog', async () => {
      gsdMock.terraform.runs.list.mockResolvedValue({
        records: [makeRecord({ runId: 'apply-1', kind: 'apply', tfvarsVersionId: 'v-1' })],
      });
      gsdMock.terraform.rollback.resolve.mockResolvedValue({
        resolved: false,
        error: 'Historic tfvars version "v-1" no longer exists — it may have expired. Nothing was written.',
      });
      renderPage(<TerraformHistoryPage />);

      await userEvent.click(await screen.findByRole('button', { name: 'Rollback' }));

      expect(await screen.findByRole('alert')).toHaveTextContent(/no longer exists/);
      expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    });

    it('should confirm the rollback and navigate to /terraform with the new versionId and rolledBackFrom', async () => {
      gsdMock.terraform.runs.list.mockResolvedValue({
        records: [makeRecord({ runId: 'apply-1', kind: 'apply', tfvarsVersionId: 'v-1' })],
      });
      gsdMock.terraform.rollback.resolve.mockResolvedValue({
        resolved: true,
        versionId: 'v-prior',
        lastModified: '2026-07-18T00:00:00.000Z',
      });
      gsdMock.terraform.rollback.confirm.mockResolvedValue({ confirmed: true, versionId: 'v-new-head' });
      renderPage(<TerraformHistoryPage />);

      await userEvent.click(await screen.findByRole('button', { name: 'Rollback' }));
      await screen.findByRole('alertdialog');
      await userEvent.click(screen.getByRole('button', { name: 'Roll back' }));

      expect(gsdMock.terraform.rollback.confirm).toHaveBeenCalledWith({ applyRunId: 'apply-1' });
      await waitFor(() =>
        expect(navigateMock).toHaveBeenCalledWith('/terraform', {
          state: { tfvarsVersionId: 'v-new-head', rolledBackFrom: 'apply-1' },
        }),
      );
    });

    it('should render a rollback badge on a row whose record carries rolledBackFrom', async () => {
      gsdMock.terraform.runs.list.mockResolvedValue({
        records: [makeRecord({ runId: 'plan-2', kind: 'plan', rolledBackFrom: 'apply-1' })],
      });
      renderPage(<TerraformHistoryPage />);

      expect(await screen.findByText('rollback')).toBeInTheDocument();
    });
  });
});
