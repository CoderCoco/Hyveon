export type { GsdApi } from './gsd-api.js';

declare global {
  interface Window {
    gsd?: import('./gsd-api.js').GsdApi;
  }
}

export {};
