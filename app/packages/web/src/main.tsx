import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './app.component.js';
import { ErrorBoundary } from './components/error-boundary.component.js';
import { installConsoleForwarding, installGlobalErrorReporting } from './lib/report-renderer-error.utils.js';
import './index.css';

installGlobalErrorReporting();
installConsoleForwarding();
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </StrictMode>,
);
