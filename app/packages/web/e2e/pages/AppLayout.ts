import type { Page, Locator } from '@playwright/test';

/**
 * Page object for the persistent navigation shell rendered by `AppLayout.tsx`
 * (sidebar + top bar). Encapsulates locators that are shared across every
 * route so individual specs don't reach into the layout chrome.
 */
export class AppLayout {
  constructor(public readonly page: Page) {}

  /** Top-bar product heading — used as a "the dashboard mounted" smoke check. */
  brandHeading(): Locator {
    return this.page.getByRole('heading', { name: 'Hyveon' });
  }

  /** Sidebar nav link by visible label (e.g. "Logs", "Discord", "Settings"). */
  sidebarLink(label: string): Locator {
    return this.page.getByRole('link', { name: label });
  }

  /**
   * Click a sidebar nav link and wait for the route to change to `expectedPath`.
   *
   * Matches on `url.pathname` rather than passing `expectedPath` as a glob:
   * under chromium a bare path is resolved against `baseURL`, but the Electron
   * shell has no `baseURL` and serves from a `file://` origin, so a bare-path
   * glob would never match `file:///logs`. Comparing pathnames works for both
   * (`http://localhost:4173/logs` and `file:///logs` both resolve to `/logs`).
   */
  async navigateTo(label: string, expectedPath: string): Promise<void> {
    await this.sidebarLink(label).click();
    await this.page.waitForURL((url) => url.pathname === expectedPath);
  }

  /** Main heading rendered by the Logs page (`/logs`). */
  logsPageHeading(): Locator {
    return this.page.getByRole('heading', { name: 'Server Logs' });
  }

  /** A visible Sonner toast matched by its message text. */
  toastMessage(text: string | RegExp): import('@playwright/test').Locator {
    return this.page.locator('[data-sonner-toast]').filter({ hasText: text });
  }

  /** The Undo action button inside a Sonner toast. */
  toastUndoButton(): import('@playwright/test').Locator {
    return this.page.locator('[data-sonner-toast]').getByRole('button', { name: 'Undo' });
  }
}
