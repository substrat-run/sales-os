import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '@substrat-run/elements/themes/base.css';
import '@substrat-run/elements/themes/ledger.css';
import { App } from './App';
import './styles.css';

// Web Awesome follows `wa-dark` on <html>; follow the person's system setting, live.
const dark = window.matchMedia('(prefers-color-scheme: dark)');
const apply = () => document.documentElement.classList.toggle('wa-dark', dark.matches);
apply();
dark.addEventListener('change', apply);

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
