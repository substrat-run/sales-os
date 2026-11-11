import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '@substrat-run/elements/themes/base.css';
import '@substrat-run/elements/themes/ledger.css';
import '@substrat-run/elements/themes/atelier.css';
import { initTheme } from './theme';
import { App } from './App';
import './styles.css';

// The saved look and light/dark choice (default: Ledger, following the system), applied before the first paint.
initTheme();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
