import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const apiMock = vi.hoisted(() => ({
  status: vi.fn(),
  costsEstimate: vi.fn(),
}));
vi.mock('../api.service.js', () => ({ api: apiMock }));

/**
 * Stub for `window.gsd.terraform` — `plan`/`approve`/`apply` are plain
 * `vi.fn()`s resolved per-test; `runs.streamLogs` and `runs.get` are keyed
 * off the run id so the plan and apply runs (started sequentially in the
 * same test) can be driven independently.
 */
const gsdMock = {
  terraform: {
    plan: vi.fn(),
    approve: vi.fn(),
    apply: vi.fn(),
    mintDestroyToken: vi.fn(),
    destroy: vi.fn(),
    output: vi.fn(),
    runs: {
      get: vi.fn(),
      streamLogs: vi.fn(),
    },
  },
};
vi.stubGlobal('gsd', gsdMock);

import { TerraformPage } from './terraform.page.js';
import { renderPage } from '../test-utils/render-page.utils.js';

const PLAN_RUN_ID = 'run-1';
const APPLY_RUN_ID = 'apply-1';
const DESTROY_RUN_ID = 'destroy-1';
const DESTROY_CONFIRM_PHRASE = 'destroy infrastructure';

/** Seeds a plan run that streams a summary line then finishes `awaiting_approval` with `planHash`. */
function seedSuccessfulPlan() {
  gsdMock.terraform.plan.mockResolvedValue({ started: true, runId: PLAN_RUN_ID });
  gsdMock.terraform.runs.streamLogs.mockImplementation(async function* (runId: string) {
    if (runId === PLAN_RUN_ID) {
      yield { stream: 'stdout', line: 'Plan: 3 to add, 1 to change, 0 to destroy.' };
    } else if (runId === APPLY_RUN_ID) {
      yield { stream: 'stdout', line: 'Apply complete! Resources: 3 added, 1 changed, 0 destroyed.' };
    }
  });
  gsdMock.terraform.runs.get.mockImplementation(async (runId: string) => {
    if (runId === PLAN_RUN_ID) {
      return {
        found: true,
        status: 'awaiting_approval',
        record: { runId: PLAN_RUN_ID, kind: 'plan', startedAt: 't0', completedAt: 't1', exitCode: 0, planHash: 'hash-1' },
      };
    }
    if (runId === APPLY_RUN_ID) {
      return { found: true, status: 'success' };
    }
    return { found: false };
  });
}

describe('TerraformPage', () => {
  beforeEach(() => {
    apiMock.status.mockResolvedValue([]);
    apiMock.costsEstimate.mockResolvedValue({ games: {}, totalPerHourIfAllOn: 0 });
    gsdMock.terraform.plan.mockReset();
    gsdMock.terraform.approve.mockReset();
    gsdMock.terraform.apply.mockReset();
    gsdMock.terraform.mintDestroyToken.mockReset();
    gsdMock.terraform.destroy.mockReset();
    gsdMock.terraform.runs.get.mockReset();
    gsdMock.terraform.runs.streamLogs.mockReset();
  });

  it('should render the Run plan trigger in the idle state', () => {
    renderPage(<TerraformPage />);
    expect(screen.getByRole('button', { name: /Run plan/ })).toBeInTheDocument();
  });

  it('should link to the run-history route', () => {
    renderPage(<TerraformPage />);
    expect(screen.getByRole('link', { name: 'View history' })).toHaveAttribute('href', '/terraform/history');
  });

  it('should stream plan output and render the resource-change summary once the plan finishes', async () => {
    seedSuccessfulPlan();
    renderPage(<TerraformPage />);

    await userEvent.click(screen.getByRole('button', { name: /Run plan/ }));

    expect(await screen.findByText(/Plan: 3 to add, 1 to change, 0 to destroy\./)).toBeInTheDocument();
    expect(await screen.findByText('3 to add')).toBeInTheDocument();
    expect(screen.getByText('1 to change')).toBeInTheDocument();
    expect(screen.getByText('0 to destroy')).toBeInTheDocument();

    await waitFor(() => expect(screen.getByRole('button', { name: /Approve plan/ })).toBeEnabled());
  });

  it('should render a BUSY banner when plan submission reports a workspace conflict', async () => {
    gsdMock.terraform.plan.mockResolvedValue({ started: false, error: 'workspace busy', conflict: 'apply' });
    renderPage(<TerraformPage />);

    await userEvent.click(screen.getByRole('button', { name: /Run plan/ }));

    const alerts = await screen.findAllByRole('alert');
    expect(alerts.some((el) => el.textContent?.includes('terraform apply'))).toBe(true);
  });

  it('should enable Apply only after the plan is approved, then stream apply output to completion', async () => {
    seedSuccessfulPlan();
    gsdMock.terraform.approve.mockResolvedValue({
      approved: true,
      approvedBy: 'alice',
      approvedAt: new Date().toISOString(),
    });
    gsdMock.terraform.apply.mockResolvedValue({ started: true, runId: APPLY_RUN_ID });
    renderPage(<TerraformPage />);

    await userEvent.click(screen.getByRole('button', { name: /Run plan/ }));
    await waitFor(() => expect(screen.getByRole('button', { name: /Approve plan/ })).toBeEnabled());

    // Apply isn't reachable yet — approval hasn't happened.
    expect(screen.queryByRole('button', { name: /^Apply$/ })).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: /Approve plan/ }));

    expect(await screen.findByText(/Approved by/)).toBeInTheDocument();
    const applyBtn = await screen.findByRole('button', { name: /^Apply$/ });
    expect(applyBtn).toBeEnabled();

    await userEvent.click(applyBtn);

    expect(gsdMock.terraform.apply).toHaveBeenCalledWith({ planRunId: PLAN_RUN_ID, planHash: 'hash-1' });
    expect(await screen.findByText(/Apply complete\./)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'View dashboard' })).toHaveAttribute('href', '/');
  });

  it('should show an expired-approval message and disable Apply until re-approved', async () => {
    seedSuccessfulPlan();
    const staleApprovedAt = new Date(Date.now() - 20 * 60 * 1000).toISOString(); // 20 minutes ago > 15-minute window
    gsdMock.terraform.approve.mockResolvedValue({ approved: true, approvedBy: 'bob', approvedAt: staleApprovedAt });
    renderPage(<TerraformPage />);

    await userEvent.click(screen.getByRole('button', { name: /Run plan/ }));
    await waitFor(() => expect(screen.getByRole('button', { name: /Approve plan/ })).toBeEnabled());
    await userEvent.click(screen.getByRole('button', { name: /Approve plan/ }));

    expect(await screen.findByText(/approval expired, re-approve to apply/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Apply$/ })).toBeDisabled();
    expect(screen.getByRole('button', { name: /Re-approve/ })).toBeInTheDocument();
  });

  describe('destroy flow (#307)', () => {
    it('should render the Destroy infrastructure trigger in the idle state', () => {
      renderPage(<TerraformPage />);
      expect(screen.getByRole('button', { name: /Destroy infrastructure/ })).toBeInTheDocument();
    });

    it('should open a confirmation dialog on click, without minting a token until the exact phrase is typed and confirmed', async () => {
      renderPage(<TerraformPage />);

      await userEvent.click(screen.getByRole('button', { name: /Destroy infrastructure/ }));

      const dialog = await screen.findByRole('alertdialog');
      expect(dialog).toBeInTheDocument();
      expect(gsdMock.terraform.mintDestroyToken).not.toHaveBeenCalled();

      // The dialog's own confirm button stays disabled until the exact phrase is typed.
      expect(screen.getByRole('button', { name: 'Destroy' })).toBeDisabled();

      await userEvent.type(screen.getByLabelText('Type to confirm'), 'wrong phrase');
      expect(screen.getByRole('button', { name: 'Destroy' })).toBeDisabled();
      expect(gsdMock.terraform.mintDestroyToken).not.toHaveBeenCalled();
    });

    it('should mint a token, submit destroy with it, and stream output through the log viewer once the exact phrase is confirmed', async () => {
      gsdMock.terraform.mintDestroyToken.mockResolvedValue({ token: 'destroy-token-1' });
      gsdMock.terraform.destroy.mockResolvedValue({ started: true, runId: DESTROY_RUN_ID });
      gsdMock.terraform.runs.streamLogs.mockImplementation(async function* (runId: string) {
        if (runId === DESTROY_RUN_ID) {
          yield { stream: 'stdout', line: 'Destroy complete! Resources: 4 destroyed.' };
        }
      });
      gsdMock.terraform.runs.get.mockResolvedValue({ found: true, status: 'success' });
      renderPage(<TerraformPage />);

      await userEvent.click(screen.getByRole('button', { name: /Destroy infrastructure/ }));
      await userEvent.type(screen.getByLabelText('Type to confirm'), DESTROY_CONFIRM_PHRASE);
      await userEvent.click(screen.getByRole('button', { name: 'Destroy' }));

      await waitFor(() => expect(gsdMock.terraform.mintDestroyToken).toHaveBeenCalledTimes(1));
      expect(gsdMock.terraform.destroy).toHaveBeenCalledWith({ confirmationToken: 'destroy-token-1' });

      expect(await screen.findByText(/Destroy complete! Resources: 4 destroyed\./)).toBeInTheDocument();
      expect(await screen.findByText('4 destroyed')).toBeInTheDocument();
      expect(await screen.findByText('Destroy complete.')).toBeInTheDocument();
      expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    });

    it('should render a BUSY banner when destroy submission reports a workspace conflict, without opening the log view', async () => {
      gsdMock.terraform.mintDestroyToken.mockResolvedValue({ token: 'destroy-token-1' });
      gsdMock.terraform.destroy.mockResolvedValue({
        started: false,
        error: 'terraform destroy refused: apply is already in flight',
        conflict: 'apply',
      });
      renderPage(<TerraformPage />);

      await userEvent.click(screen.getByRole('button', { name: /Destroy infrastructure/ }));
      await userEvent.type(screen.getByLabelText('Type to confirm'), DESTROY_CONFIRM_PHRASE);
      await userEvent.click(screen.getByRole('button', { name: 'Destroy' }));

      const alerts = await screen.findAllByRole('alert');
      expect(alerts.some((el) => el.textContent?.includes('terraform apply'))).toBe(true);
      expect(screen.queryByRole('heading', { name: 'Destroy run' })).not.toBeInTheDocument();
    });

    it('should mint a fresh token on every attempt', async () => {
      gsdMock.terraform.mintDestroyToken
        .mockResolvedValueOnce({ token: 'destroy-token-1' })
        .mockResolvedValueOnce({ token: 'destroy-token-2' });
      gsdMock.terraform.destroy
        .mockResolvedValueOnce({ started: false, error: 'workspace busy', conflict: 'apply' })
        .mockResolvedValueOnce({ started: true, runId: DESTROY_RUN_ID });
      gsdMock.terraform.runs.streamLogs.mockImplementation(async function* () { /* no chunks needed */ });
      gsdMock.terraform.runs.get.mockResolvedValue({ found: true, status: 'success' });
      renderPage(<TerraformPage />);

      await userEvent.click(screen.getByRole('button', { name: /Destroy infrastructure/ }));
      await userEvent.type(screen.getByLabelText('Type to confirm'), DESTROY_CONFIRM_PHRASE);
      await userEvent.click(screen.getByRole('button', { name: 'Destroy' }));
      await waitFor(() => expect(gsdMock.terraform.destroy).toHaveBeenCalledTimes(1));

      await userEvent.click(screen.getByRole('button', { name: /Destroy infrastructure/ }));
      await userEvent.type(screen.getByLabelText('Type to confirm'), DESTROY_CONFIRM_PHRASE);
      await userEvent.click(screen.getByRole('button', { name: 'Destroy' }));
      await waitFor(() => expect(gsdMock.terraform.destroy).toHaveBeenCalledTimes(2));

      expect(gsdMock.terraform.mintDestroyToken).toHaveBeenCalledTimes(2);
      expect(gsdMock.terraform.destroy).toHaveBeenNthCalledWith(1, { confirmationToken: 'destroy-token-1' });
      expect(gsdMock.terraform.destroy).toHaveBeenNthCalledWith(2, { confirmationToken: 'destroy-token-2' });
    });
  });

  describe('rollback flow (#112)', () => {
    it('should auto-submit a tagged plan with the rollback location.state, without requiring a Run plan click', async () => {
      gsdMock.terraform.plan.mockResolvedValue({ started: true, runId: PLAN_RUN_ID });
      gsdMock.terraform.runs.streamLogs.mockImplementation(async function* () {
        /* no chunks needed for this assertion */
      });
      gsdMock.terraform.runs.get.mockResolvedValue({ found: false });

      renderPage(<TerraformPage />, {
        initialEntries: [
          { pathname: '/terraform', state: { tfvarsVersionId: 'v-new-head', rolledBackFrom: 'apply-1' } },
        ],
      });

      await waitFor(() =>
        expect(gsdMock.terraform.plan).toHaveBeenCalledWith({
          tfvarsVersionId: 'v-new-head',
          rolledBackFrom: 'apply-1',
        }),
      );
      expect(screen.queryByRole('button', { name: /Run plan/ })).not.toBeInTheDocument();
    });

    it('should render a link to the rolled-back apply run once the plan record carries rolledBackFrom', async () => {
      gsdMock.terraform.plan.mockResolvedValue({ started: true, runId: PLAN_RUN_ID });
      gsdMock.terraform.runs.streamLogs.mockImplementation(async function* () {
        /* no chunks needed for this assertion */
      });
      gsdMock.terraform.runs.get.mockResolvedValue({
        found: true,
        status: 'awaiting_approval',
        record: {
          runId: PLAN_RUN_ID,
          kind: 'plan',
          startedAt: 't0',
          completedAt: 't1',
          exitCode: 0,
          planHash: 'hash-1',
          rolledBackFrom: 'apply-1',
        },
      });

      renderPage(<TerraformPage />, {
        initialEntries: [
          { pathname: '/terraform', state: { tfvarsVersionId: 'v-new-head', rolledBackFrom: 'apply-1' } },
        ],
      });

      const link = await screen.findByRole('link', { name: /apply run apply-1/ });
      expect(link).toHaveAttribute('href', '/terraform/history/apply-1');
    });

    it('should not auto-submit when there is no rollback location.state', () => {
      renderPage(<TerraformPage />);
      expect(gsdMock.terraform.plan).not.toHaveBeenCalled();
      expect(screen.getByRole('button', { name: /Run plan/ })).toBeInTheDocument();
    });
  });
});
