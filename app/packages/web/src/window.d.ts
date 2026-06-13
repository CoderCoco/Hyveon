import type { GsdApi } from '@hyveon/desktop-preload';

declare global {
  interface Window {
    /** IPC bridge injected by the Electron preload script. Absent in browser/web contexts. */
    gsd?: GsdApi;
  }
}

export {};
