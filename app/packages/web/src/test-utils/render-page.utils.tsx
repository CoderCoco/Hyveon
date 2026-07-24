import type { ReactElement, ReactNode } from 'react';
import { render, type RenderOptions, type RenderResult } from '@testing-library/react';
import { MemoryRouter, type Location } from 'react-router-dom';
import { PollingProvider } from '../polling/polling-provider.component.js';
import { GameStatusProvider } from '../polling/game-status-provider.component.js';

interface RenderPageOptions extends Omit<RenderOptions, 'wrapper'> {
  /**
   * Initial route(s) the `MemoryRouter` should render. Override when the
   * page under test reads `useLocation`. A plain string sets only the
   * pathname; pass `{ pathname, state }` when the page also reads
   * `location.state` (e.g. the rollback flow's `RollbackNavState`). Defaults
   * to `/`.
   */
  initialEntries?: Array<string | Partial<Location>>;
}

/**
 * Renders a routed page under the same provider stack the app uses in
 * production (Polling → GameStatus → Router). Pair with `vi.mock('../api.js')`
 * to stub the network layer before `render` is called.
 *
 * Use this for tests that exercise a whole page — including the
 * `<PollingIndicator />` integration on the page header — without standing
 * up the full Nest server. For per-component tests that don't depend on the
 * providers, render the component directly instead.
 */
export function renderPage(
  ui: ReactElement,
  { initialEntries = ['/'], ...opts }: RenderPageOptions = {},
): RenderResult {
  function Wrapper({ children }: { children: ReactNode }) {
    return (
      <PollingProvider>
        <GameStatusProvider>
          <MemoryRouter initialEntries={initialEntries}>{children}</MemoryRouter>
        </GameStatusProvider>
      </PollingProvider>
    );
  }
  return render(ui, { wrapper: Wrapper, ...opts });
}
