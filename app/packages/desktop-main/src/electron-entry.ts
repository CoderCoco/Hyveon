import { app, BrowserWindow } from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bootstrap } from './main.js';

// electron-vite injects __dirname for main-process entries, but we also
// compute it explicitly via import.meta.url so the file is valid plain ESM.
const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Creates the main application window with the preload script wired in and
 * loads either the dev server URL or the production renderer bundle.
 */
function createWindow(): void {
  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    webPreferences: {
      // electron-vite names the preload bundle after the input file, so the
      // output lands at out/preload/preload.js. __dirname here resolves to
      // out/main, so we go one level up.
      preload: path.join(__dirname, '../preload/preload.js'),
      contextIsolation: true,
      sandbox: true,
    },
  });

  const load = process.env.ELECTRON_RENDERER_URL
    ? win.loadURL(process.env.ELECTRON_RENDERER_URL)
    : win.loadFile(path.join(__dirname, '../renderer/index.html'));

  load.catch((err: unknown) => {
    console.error('[desktop-main] Renderer failed to load — quitting:', err);
    app.quit();
  });
}

/**
 * True when Playwright (or another test harness) sets HYVEON_TEST_MODE=1.
 *
 * This is a forward-looking seam, not a behaviour switch: the window is still
 * created so Playwright's `_electron.launch()` can resolve `firstWindow()` and
 * assert on the renderer. F.7 (#198) will key the preload's
 * `window.gsd.__test.mock()` injection off this same flag.
 */
const isTestMode = process.env.HYVEON_TEST_MODE === '1';

app.whenReady().then(() => {
  bootstrap()
    .then(() => {
      if (isTestMode) {
        console.log('[desktop-main] HYVEON_TEST_MODE active — test seam enabled');
      }

      createWindow();

      // On macOS re-create the window when the dock icon is clicked and there
      // are no other windows open (standard macOS behaviour).
      app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) createWindow();
      });
    })
    .catch((err: unknown) => {
      console.error('[desktop-main] NestJS IPC bootstrap failed — quitting:', err);
      app.quit();
    });
});

// Quit the app when all windows are closed, except on macOS where the app and
// its menu bar conventionally stay active until the user explicitly quits.
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
