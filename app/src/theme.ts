import { useSyncExternalStore } from 'react';

// ============================================================================
// The app's look. Two independent choices, both kept in THIS browser (a personal preference, so it needs no
// permission and touches no data): which Substrat theme (a class on <html>), and light / dark / follow-the-system
// (Web Awesome's `wa-dark` class). Applied before the first paint so there is no flash of the wrong theme.
// ============================================================================

export type Look = 'ledger' | 'base' | 'atelier';
export type Mode = 'system' | 'light' | 'dark';
export interface Theme {
  look: Look;
  mode: Mode;
}

export const LOOKS: { id: Look; label: string; hint: string }[] = [
  { id: 'ledger', label: 'Ledger', hint: 'Dense and flat, with hairline borders. For screens you work in all day.' },
  { id: 'base', label: 'Standard', hint: 'Web Awesome’s default: neutral and comfortable.' },
  { id: 'atelier', label: 'Atelier', hint: 'Warm and roomy, with serif headings.' },
];

const KEY = 'sales-os:theme';
const DEFAULT: Theme = { look: 'ledger', mode: 'system' };

function load(): Theme {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? 'null') as Partial<Theme> | null;
    const look = LOOKS.some((l) => l.id === raw?.look) ? (raw!.look as Look) : DEFAULT.look;
    const mode = raw?.mode === 'light' || raw?.mode === 'dark' || raw?.mode === 'system' ? raw.mode : DEFAULT.mode;
    return { look, mode };
  } catch {
    return DEFAULT; // storage blocked or unreadable: the default, never an error
  }
}

let current = load();
const listeners = new Set<() => void>();
const systemDark = window.matchMedia('(prefers-color-scheme: dark)');

export function applyTheme(t: Theme): void {
  const root = document.documentElement;
  root.classList.remove('sub-theme-ledger', 'sub-theme-atelier');
  if (t.look !== 'base') root.classList.add(`sub-theme-${t.look}`);
  root.classList.toggle('wa-dark', t.mode === 'dark' || (t.mode === 'system' && systemDark.matches));
}

/** Call once at startup: apply the saved theme, and follow the system setting while the mode is "system". */
export function initTheme(): void {
  applyTheme(current);
  systemDark.addEventListener('change', () => {
    if (current.mode === 'system') applyTheme(current);
  });
}

export function setTheme(patch: Partial<Theme>): void {
  current = { ...current, ...patch };
  try {
    localStorage.setItem(KEY, JSON.stringify(current));
  } catch {
    /* still applied for this visit; it just will not be remembered */
  }
  applyTheme(current);
  listeners.forEach((l) => l());
}

export function useTheme(): Theme {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => current,
  );
}
