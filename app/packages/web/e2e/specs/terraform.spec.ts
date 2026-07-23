import type { Page, ElectronApplication } from '../fixtures/index.js';
import { test, expect, launchElectron, applyGsdMocks } from '../fixtures/index.js';
import { TerraformPage } from '../pages/index.js';

/**
 * `/terraform` route specs (issue #110), driven via `_electron.launch()` and
 * the `window.gsd.__test.mock()` IPC seam — mirrors `dashboard.spec.ts`'s
 * shared-app pattern rather than the older per-test `_electron.launch()` in
 * `logs.spec.ts`.
 */

const PLAN_RUN_ID = 'run-1';
const APPLY_RUN_ID = 'apply-1';

interface TerraformMockOptions {
  planAck?: { started: boolean; runId?: string; error?: string; conflict?: string };
  planLines?: string[];
  planStatus?: string;
  planHash?: string;
  approveAck?: { approved: boolean; approvedBy?: string; approvedAt?: string; error?: string };
  applyAck?: { started: boolean; runId?: string; error?: string; conflict?: string };
  applyLines?: string[];
  applyStatus?: string;
}

/**
 * Seeds every `terraform.*` IPC channel `/terraform` consumes via
 * `window.gsd.__test.mock()`. Must be called before navigating to the page
 * under test.
 *
 * `terraform.runs.logs` backs `gsd.terraform.runs.streamLogs` and is
 * registered as an async generator, mirroring `logs.stream`'s mock shape in
 * `logs.spec.ts` — but its yielded chunks never actually reach the page: an
 * async generator object returned across Electron's `contextBridge` function
 * proxy (crossing back from this main-world mock into the isolated-world
 * `streamTerraformRunLogs`) fails with "An object could not be cloned",
 * regardless of which streaming channel or generator body is used — verified
 * against `logs.stream`'s own proven-working mock too. `useTerraformRunLog`'s
 * `try/catch` silently absorbs that failure and still flips `ended`, so the
 * page behaves as if the run produced no output — good enough to drive the
 * `runs.get`-derived states below (BUSY, approve, apply, success) end to end.
 * Actual chunk rendering (ANSI, ordering, summary parsing) is covered by
 * `terraform.page.test.tsx` and `ansi-log-viewer.component.test.tsx` instead,
 * which mock `window.gsd` directly in jsdom with no contextBridge involved.
 */
async function mockTerraform(win: Page, opts: TerraformMockOptions = {}): Promise<void> {
  const planAck = opts.planAck ?? { started: true, runId: PLAN_RUN_ID };
  const planLines = opts.planLines ?? ['Plan: 3 to add, 1 to change, 0 to destroy.'];
  const planStatus = opts.planStatus ?? 'awaiting_approval';
  const planHash = opts.planHash ?? 'hash-1';
  const approveAck = opts.approveAck ?? {
    approved: true,
    approvedBy: 'alice',
    approvedAt: new Date().toISOString(),
  };
  const applyAck = opts.applyAck ?? { started: true, runId: APPLY_RUN_ID };
  const applyLines = opts.applyLines ?? ['Apply complete! Resources: 3 added, 1 changed, 0 destroyed.'];
  const applyStatus = opts.applyStatus ?? 'success';

  await win.evaluate(
    ({ planAck, planLines, planStatus, planHash, approveAck, applyAck, applyLines, applyStatus, planRunId, applyRunId }) => {
      const gsd = (window as Record<string, unknown>)['gsd'] as {
        __test: { mock: (channel: string, handler: unknown) => void };
      };

      gsd.__test.mock('terraform.plan', () => Promise.resolve(planAck));
      gsd.__test.mock('terraform.approve', () => Promise.resolve(approveAck));
      gsd.__test.mock('terraform.apply', () => Promise.resolve(applyAck));
      gsd.__test.mock('terraform.runs.get', (payload: { runId: string }) => {
        if (payload.runId === planRunId) {
          return Promise.resolve({
            found: true,
            status: planStatus,
            record: { runId: planRunId, kind: 'plan', startedAt: 't0', completedAt: 't1', exitCode: 0, planHash },
          });
        }
        if (payload.runId === applyRunId) {
          return Promise.resolve({ found: true, status: applyStatus });
        }
        return Promise.resolve({ found: false });
      });
      gsd.__test.mock('terraform.runs.logs', async function* (runId: string) {
        if (runId === planRunId) {
          for (const line of planLines) yield { stream: 'stdout', line };
        } else if (runId === applyRunId) {
          for (const line of applyLines) yield { stream: 'stdout', line };
        }
      });
    },
    {
      planAck,
      planLines,
      planStatus,
      planHash,
      approveAck,
      applyAck,
      applyLines,
      applyStatus,
      planRunId: PLAN_RUN_ID,
      applyRunId: APPLY_RUN_ID,
    },
  );
}

test.describe('terraform page', () => {
  let app: ElectronApplication | undefined;
  let win: Page;
  let terraform: TerraformPage;

  test.beforeAll(async () => {
    ({ app, win } = await launchElectron());
    terraform = new TerraformPage(win);
  });

  test.afterAll(async () => {
    if (app) await app.close();
  });

  test.afterEach(async () => {
    if (!win) return;
    await win.evaluate(() => {
      const gsd = (window as Record<string, unknown>)['gsd'] as {
        __test: { clearMocks: () => void };
      };
      gsd.__test.clearMocks();
    });
  });

  test('should reach awaiting_approval and enable the Approve button once the plan run finishes', async () => {
    await applyGsdMocks(win);
    await mockTerraform(win);
    await terraform.gotoViaSidebar();

    await terraform.runPlanButton().click();

    await expect(terraform.approveButton()).toBeEnabled();
  });

  test('should render a BUSY banner when plan submission reports a workspace conflict', async () => {
    await applyGsdMocks(win);
    await mockTerraform(win, { planAck: { started: false, error: 'workspace busy', conflict: 'apply' } });
    await terraform.gotoViaSidebar();

    await terraform.runPlanButton().click();

    await expect(terraform.alerts().filter({ hasText: 'terraform apply' })).toBeVisible();
  });

  test('should approve the plan, then apply and reach the success banner', async () => {
    await applyGsdMocks(win);
    await mockTerraform(win);
    await terraform.gotoViaSidebar();

    await terraform.runPlanButton().click();
    await expect(terraform.approveButton()).toBeEnabled();
    await terraform.approveButton().click();

    await expect(terraform.approvedText()).toBeVisible();
    await expect(terraform.applyButton()).toBeEnabled();

    await terraform.applyButton().click();

    await expect(terraform.applyCompleteText()).toBeVisible();
    await expect(terraform.dashboardLink()).toBeVisible();
  });

  test('should show an expired-approval hint and keep Apply disabled until re-approved', async () => {
    const staleApprovedAt = new Date(Date.now() - 20 * 60 * 1000).toISOString();
    await applyGsdMocks(win);
    await mockTerraform(win, {
      approveAck: { approved: true, approvedBy: 'bob', approvedAt: staleApprovedAt },
    });
    await terraform.gotoViaSidebar();

    await terraform.runPlanButton().click();
    await expect(terraform.approveButton()).toBeEnabled();
    await terraform.approveButton().click();

    await expect(terraform.approvalExpiredText()).toBeVisible();
    await expect(terraform.applyButton()).toBeDisabled();
    await expect(terraform.reapproveButton()).toBeVisible();
  });
});
