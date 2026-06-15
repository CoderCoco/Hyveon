import { test, expect, _electron } from '@playwright/test';
import { electronMain, electronEnv } from '../../playwright.config.js';

/**
 * Smoke spec for the native Electron shell.
 *
 * Asserts two things that prove the app launches correctly:
 *  1. A BrowserWindow is opened (firstWindow() resolves).
 *  2. `window.gsd` is defined — confirming the preload script ran and
 *     exposed the IPC bridge to the renderer.
 *
 * Each test manages its own ElectronApplication lifecycle so the spec is
 * self-contained and runnable independently of the global setup.
 */
test.describe('electron smoke', () => {
  test('should open a BrowserWindow', async () => {
    const app = await _electron.launch({ args: [electronMain], env: electronEnv });

    try {
      const win = await app.firstWindow();
      expect(win).toBeTruthy();
    } finally {
      await app.close();
    }
  });

  test('should expose window.gsd from the preload script', async () => {
    const app = await _electron.launch({ args: [electronMain], env: electronEnv });

    try {
      const win = await app.firstWindow();
      const gsd = await win.evaluate(() => typeof (window as Record<string, unknown>)['gsd']);
      expect(gsd).toBe('object');
    } finally {
      await app.close();
    }
  });
});
