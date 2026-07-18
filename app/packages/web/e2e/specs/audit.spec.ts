import { test, expect, stubApis } from '../fixtures/index.js';
import type { AuditPageResult } from '../fixtures/index.js';

/**
 * Specs for the `/audit` route added in issue #102: the mutation-history
 * table listing every `game_servers` change (timestamp, actor, action, game,
 * version), the expandable before/after JSON diff per row, and "Load more"
 * pagination via the `nextBefore` cursor. Plain browser-stub specs (chromium
 * project) — `/api/audit` is stubbed over HTTP via `stubApis`, same pattern
 * as `games.spec.ts`.
 */

/** First page of two audit entries, with a cursor to an older page. */
const PAGE_ONE: AuditPageResult = {
  entries: [
    {
      sk: '2026-07-02T00:00:00.000Z#01J001',
      timestamp: '2026-07-02T00:00:00.000Z',
      actor: 'alice',
      action: 'edit',
      game: 'minecraft',
      before: {
        name: 'minecraft',
        image: 'itzg/minecraft-server:1',
        cpu: 1024,
        memory: 2048,
        ports: [],
        volumes: [],
      },
      after: {
        name: 'minecraft',
        image: 'itzg/minecraft-server:2',
        cpu: 1024,
        memory: 2048,
        ports: [],
        volumes: [],
      },
      versionId: 'v-2',
    },
    {
      sk: '2026-07-01T00:00:00.000Z#01J000',
      timestamp: '2026-07-01T00:00:00.000Z',
      actor: 'bob',
      action: 'add',
      game: 'valheim',
      before: null,
      after: {
        name: 'valheim',
        image: 'lloesche/valheim-server',
        cpu: 512,
        memory: 1024,
        ports: [],
        volumes: [],
      },
      versionId: 'v-1',
    },
  ],
  nextBefore: '2026-07-01T00:00:00.000Z#01J000',
};

/**
 * Second, older page — returned once "Load more" passes PAGE_ONE's cursor
 * back as `before`. Has no `nextBefore`, so "Load more" disappears once it
 * loads.
 */
const PAGE_TWO: AuditPageResult = {
  entries: [
    {
      sk: '2026-06-30T00:00:00.000Z#01J-1',
      timestamp: '2026-06-30T00:00:00.000Z',
      actor: 'carol',
      action: 'remove',
      game: 'terraria',
      before: {
        name: 'terraria',
        image: 'ryshe/terraria',
        cpu: 512,
        memory: 1024,
        ports: [],
        volumes: [],
      },
      after: null,
    },
  ],
};

test.describe('audit log page', () => {
  test('should render the Audit Log heading and an empty state when there are no entries', async ({ audit }) => {
    await stubApis(audit.page, { audit: { entries: [] } });
    await audit.goto();

    await expect(audit.heading()).toBeVisible();
    await expect(audit.emptyStateMessage()).toBeVisible();
  });

  test('should list stubbed entries showing the timestamp, actor, action, game, and version for each row', async ({ audit }) => {
    await stubApis(audit.page, { audit: PAGE_ONE });
    await audit.goto();

    await expect(audit.entryRow(0)).toContainText('alice');
    await expect(audit.entryRow(0)).toContainText('edit');
    await expect(audit.entryRow(0)).toContainText('minecraft');
    await expect(audit.entryRow(0)).toContainText('v-2');

    await expect(audit.entryRow(1)).toContainText('bob');
    await expect(audit.entryRow(1)).toContainText('add');
    await expect(audit.entryRow(1)).toContainText('valheim');
    await expect(audit.entryRow(1)).toContainText('v-1');
  });

  test('should expand a row to reveal the before/after JSON diff', async ({ audit }) => {
    await stubApis(audit.page, { audit: PAGE_ONE });
    await audit.goto();
    await expect(audit.entryRow(0)).toContainText('alice');

    await audit.expandRow(0);

    await expect(audit.detailRow(0).getByText('itzg/minecraft-server:1')).toBeVisible();
    await expect(audit.detailRow(0).getByText('itzg/minecraft-server:2')).toBeVisible();
  });

  test('should not show a "Load more" button when the page has no nextBefore', async ({ audit }) => {
    await stubApis(audit.page, { audit: PAGE_TWO });
    await audit.goto();

    await expect(audit.entryRow(0)).toContainText('carol');
    await expect(audit.loadMoreButton()).toHaveCount(0);
  });

  test('should append a second page of entries when "Load more" is clicked against a stubbed cursor response', async ({ audit }) => {
    await stubApis(audit.page, {
      // The stub route always passes the parsed `before` query param through —
      // once the app clicks "Load more" it re-requests with
      // `before: PAGE_ONE.nextBefore`, so branch on that to hand back the
      // older page and drop the cursor.
      audit: (opts) => (opts.before === PAGE_ONE.nextBefore ? PAGE_TWO : PAGE_ONE),
    });
    await audit.goto();

    await expect(audit.entryRow(0)).toContainText('alice');
    await expect(audit.loadMoreButton()).toBeVisible();

    await audit.loadMoreButton().click();

    // Both the original page's rows and the newly appended page's row are present.
    await expect(audit.entryRow(2)).toContainText('carol');
    await expect(audit.entryRow(0)).toContainText('alice');
    await expect(audit.entryRow(1)).toContainText('bob');

    // The last page has no nextBefore, so "Load more" is gone.
    await expect(audit.loadMoreButton()).toHaveCount(0);
  });
});
