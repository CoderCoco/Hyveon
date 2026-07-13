import { test, expect, stubApis } from '../fixtures/index.js';
import type { GameListEntry } from '../fixtures/index.js';

/**
 * Specs for the read-only Games routes added in issue #93: the
 * declared/deployed drift table at `/games` and the per-game detail view at
 * `/games/:name`. These are plain browser-stub specs (chromium project) —
 * `/api/games` is stubbed over HTTP via `stubApis`, same pattern as
 * `settings.spec.ts`.
 */

/** A fully declared + deployed game — the "in sync" row, with every optional config field populated. */
const declaredDeployed: GameListEntry = {
  name: 'minecraft',
  declared: true,
  deployed: true,
  config: {
    name: 'minecraft',
    image: 'itzg/minecraft-server:latest',
    cpu: 1024,
    memory: 2048,
    https: true,
    ports: [{ container: 25565, protocol: 'tcp' }],
    volumes: [{ name: 'data', container_path: '/data' }],
    environment: [{ name: 'EULA', value: 'TRUE' }],
    connect_message: 'Connect via minecraft.example.com:25565',
    file_seeds: [{ path: '/data/server.properties', mode: '0644' }],
  },
};

/** Declared but not yet applied — the "pending deploy" row. */
const declaredOnly: GameListEntry = {
  name: 'valheim',
  declared: true,
  deployed: false,
  config: {
    name: 'valheim',
    image: 'lloesche/valheim-server:latest',
    cpu: 4096,
    memory: 8192,
    ports: [{ container: 2456, protocol: 'udp' }],
    volumes: [],
  },
};

/** Deployed but no tfvars entry — the "ghost" / "undeclared" row (no `config`). */
const ghostRow: GameListEntry = {
  name: 'terraria',
  declared: false,
  deployed: true,
};

test.describe('games list page', () => {
  test('should render the Games heading and an empty state when no games exist', async ({ games }) => {
    await stubApis(games.page, { games: [] });
    await games.goto();

    await expect(games.heading()).toBeVisible();
    await expect(games.emptyStateMessage()).toBeVisible();
  });

  test('should render the columns and an "In sync" chip for a declared and deployed game', async ({ games }) => {
    await stubApis(games.page, { games: [declaredDeployed] });
    await games.goto();

    await expect(games.gameLink('minecraft')).toBeVisible();
    await expect(games.driftChip('In sync')).toBeVisible();
    await expect(games.tableCell('itzg/minecraft-server:latest')).toBeVisible();
    await expect(games.tableCell('25565/tcp')).toBeVisible();
    await expect(games.tableCell('1024')).toBeVisible();
    await expect(games.tableCell('2048')).toBeVisible();
  });

  test('should render a "Pending deploy" chip for a declared-only game', async ({ games }) => {
    await stubApis(games.page, { games: [declaredOnly] });
    await games.goto();

    await expect(games.gameLink('valheim')).toBeVisible();
    await expect(games.driftChip('Pending deploy')).toBeVisible();
  });

  test('should render an "Undeclared" chip and em-dash columns for a ghost row', async ({ games }) => {
    await stubApis(games.page, { games: [ghostRow] });
    await games.goto();

    await expect(games.gameLink('terraria')).toBeVisible();
    await expect(games.driftChip('Undeclared')).toBeVisible();
    // image, ports, cpu, memory columns all fall back to an em dash.
    await expect(games.tableCell('—')).toHaveCount(4);
  });

  test('should navigate to the /games/:name detail route when a row link is clicked', async ({ games }) => {
    await stubApis(games.page, { games: [declaredDeployed, declaredOnly, ghostRow] });
    await games.goto();

    await games.openGame('minecraft');

    await expect(games.detailHeading('minecraft')).toBeVisible();
  });

  test('should navigate to the games list from the sidebar Games link', async ({ dashboard, games, layout }) => {
    await stubApis(dashboard.page, { games: [declaredDeployed] });
    await dashboard.goto();

    await layout.navigateTo('Games', '/games');

    await expect(games.heading()).toBeVisible();
  });
});

test.describe('game detail page', () => {
  test('should render every declared config panel for a fully declared game', async ({ games }) => {
    await stubApis(games.page, { games: [declaredDeployed] });
    await games.gotoDetail('minecraft');

    await expect(games.detailHeading('minecraft')).toBeVisible();
    await expect(games.driftChip('In sync')).toBeVisible();

    // Container overview.
    await expect(games.panelTitle('Container')).toBeVisible();
    await expect(games.page.getByText('itzg/minecraft-server:latest')).toBeVisible();
    await expect(games.page.getByText('1024')).toBeVisible();
    await expect(games.page.getByText('2048')).toBeVisible();
    await expect(games.page.getByText('Enabled')).toBeVisible();

    // Ports.
    await expect(games.panelTitle('Ports')).toBeVisible();
    await expect(games.page.getByRole('cell', { name: '25565' })).toBeVisible();
    await expect(games.page.getByRole('cell', { name: /tcp/i })).toBeVisible();

    // Volumes.
    await expect(games.panelTitle('Volumes')).toBeVisible();
    // exact: true — otherwise the substring "data" also matches the
    // container-path cell ("/data"), tripping Playwright's strict mode.
    await expect(games.page.getByRole('cell', { name: 'data', exact: true })).toBeVisible();
    await expect(games.page.getByRole('cell', { name: '/data' })).toBeVisible();

    // Environment variables.
    await expect(games.panelTitle('Environment variables')).toBeVisible();
    await expect(games.page.getByRole('cell', { name: 'EULA' })).toBeVisible();

    // File seeds (collapsed).
    await expect(games.fileSeedsSummary(1)).toBeVisible();

    // Connect message.
    await expect(games.panelTitle('Connect message')).toBeVisible();
    await expect(games.connectMessage('Connect via minecraft.example.com:25565')).toBeVisible();
  });

  test('should navigate back to the games list via the back link', async ({ games }) => {
    await stubApis(games.page, { games: [declaredDeployed] });
    await games.gotoDetail('minecraft');

    await games.backLink().click();

    await expect(games.heading()).toBeVisible();
  });

  test('should show a ghost message when a deployed game has no declared config', async ({ games }) => {
    await stubApis(games.page, { games: [ghostRow] });
    await games.gotoDetail('terraria');

    await expect(games.detailHeading('terraria')).toBeVisible();
    await expect(games.driftChip('Undeclared')).toBeVisible();
    await expect(games.ghostMessage()).toBeVisible();
    await expect(games.panelTitle('Container')).toHaveCount(0);
  });

  test('should show a not-found message for a name that matches no merged entry', async ({ games }) => {
    await stubApis(games.page, { games: [declaredDeployed] });
    await games.gotoDetail('unknown-game');

    await expect(games.notFoundMessage('unknown-game')).toBeVisible();
  });
});
