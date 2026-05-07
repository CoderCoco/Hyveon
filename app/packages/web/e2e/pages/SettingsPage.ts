import type { Page, Locator } from '@playwright/test';

/**
 * Page object for the settings route (`/settings`). Wraps the Watchdog
 * Configuration panel and any other controls on the page.
 */
export class SettingsPage {
  constructor(public readonly page: Page) {}

  /** Navigate to the settings route. */
  async goto(): Promise<void> {
    await this.page.goto('/settings');
  }

  /** Save button in the Watchdog Configuration panel. */
  saveWatchdogButton(): Locator {
    return this.page.getByRole('button', { name: 'Save' });
  }
}
