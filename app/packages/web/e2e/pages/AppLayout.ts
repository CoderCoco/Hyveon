import type { Page, Locator } from '@playwright/test';

/**
 * Page object for the persistent navigation shell rendered by `AppLayout.tsx`
 * (sidebar + top bar). Encapsulates locators that are shared across every
 * authenticated route so individual specs don't reach into the layout chrome.
 */
export class AppLayout {
  constructor(public readonly page: Page) {}

  /** Top-bar product heading — used as a "the dashboard mounted" smoke check. */
  brandHeading(): Locator {
    return this.page.getByRole('heading', { name: 'Game Server Manager' });
  }

  /** Sidebar nav link by visible label (e.g. "Logs", "Discord", "Settings"). */
  sidebarLink(label: string): Locator {
    return this.page.getByRole('link', { name: label });
  }

  /** Click a sidebar nav link and wait for the URL to change to `expectedPath`. */
  async navigateTo(label: string, expectedPath: string): Promise<void> {
    await this.sidebarLink(label).click();
    await this.page.waitForURL(expectedPath);
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
