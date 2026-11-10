import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import '@substrat-run/elements/controls';
import '@substrat-run/elements/assistant';
import { assistantModel } from './assistant';
import { readPage, qs, type Company } from './api';

// ============================================================================
// Ctrl/Cmd+K: jump to a screen, or find a company. A Web Awesome dialog and input, so it follows the
// same theme as the rest. Company search is the server's `q` filter (two characters or more).
// ============================================================================

interface Item {
  key: string;
  label: string;
  hint: string;
  href: string;
}

export const OPEN_PALETTE = 'sales-os:open-palette';

export function CommandPalette({ screens, canAsk }: { screens: { route: string; label: string }[]; canAsk: boolean }) {
  const dialog = useRef<HTMLElement & { open: boolean }>(null);
  const input = useRef<HTMLElement & { value: string; focus(): void }>(null);
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const [companies, setCompanies] = useState<Company[]>([]);
  const [active, setActive] = useState(0);
  const [mode, setMode] = useState<'go' | 'ask'>('go');
  const assistant = useRef<HTMLElement & { model: unknown }>(null);

  // Ctrl/Cmd+K toggles it from anywhere; the header button asks for it by event.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setOpen((o) => !o);
      }
    };
    const onAsk = (e: Event) => {
      setMode((e as CustomEvent<{ mode?: 'go' | 'ask' }>).detail?.mode ?? 'go');
      setOpen(true);
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener(OPEN_PALETTE, onAsk as EventListener);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener(OPEN_PALETTE, onAsk as EventListener);
    };
  }, []);

  useEffect(() => {
    const d = dialog.current;
    if (!d) return;
    d.open = open;
    if (!open) return;
    setQ('');
    setCompanies([]);
    setActive(0);
  }, [open]);

  // The conversation is kept across opens; the element only needs handing it.
  useEffect(() => {
    if (mode === 'ask' && assistant.current) assistant.current.model = assistantModel();
  }, [mode, open]);

  useEffect(() => {
    const d = dialog.current;
    if (!d) return;
    const hide = () => setOpen(false);
    const show = () => input.current?.focus();
    d.addEventListener('wa-after-hide', hide);
    d.addEventListener('wa-after-show', show);
    return () => {
      d.removeEventListener('wa-after-hide', hide);
      d.removeEventListener('wa-after-show', show);
    };
  }, []);

  useEffect(() => {
    const i = input.current;
    if (!i) return;
    const on = () => setQ(i.value ?? '');
    i.addEventListener('input', on);
    return () => i.removeEventListener('input', on);
  }, []);

  // Debounced server search, and a stale answer never overwrites a newer one.
  useEffect(() => {
    if (q.trim().length < 2) {
      setCompanies([]);
      return;
    }
    let live = true;
    const t = setTimeout(() => {
      readPage<Company>('/companies' + qs({ q: q.trim(), limit: 6 })).then(
        (p) => live && setCompanies(p.entries),
        () => live && setCompanies([]),
      );
    }, 180);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [q]);

  const items = useMemo<Item[]>(() => {
    const needle = q.trim().toLowerCase();
    const screenItems = screens
      .filter((s) => !needle || s.label.toLowerCase().includes(needle))
      .map((s) => ({ key: `s:${s.route}`, label: s.label, hint: 'Screen', href: `#/${s.route}` }));
    const companyItems = companies.map((c) => ({ key: `c:${c.id}`, label: c.name, hint: c.domain ?? 'Company', href: `#/companies/${c.id}` }));
    return [...screenItems, ...companyItems];
  }, [q, screens, companies]);

  const go = useCallback((item: Item | undefined) => {
    if (!item) return;
    window.location.hash = item.href.slice(1);
    setOpen(false);
  }, []);

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActive((a) => Math.min(a + 1, items.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((a) => Math.max(a - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      go(items[active]);
    }
  };

  const noMatch = q.trim().length >= 2 && items.length === 0;
  return (
    <wa-dialog ref={dialog} label={mode === 'ask' ? 'Ask' : 'Go to'} light-dismiss="" onKeyDown={mode === 'go' ? onKeyDown : undefined}>
      {canAsk && (
        <div className="tabs" role="tablist">
          <button role="tab" aria-selected={mode === 'go'} className={mode === 'go' ? 'on' : ''} onClick={() => setMode('go')}>Go to</button>
          <button role="tab" aria-selected={mode === 'ask'} className={mode === 'ask' ? 'on' : ''} onClick={() => setMode('ask')}>Ask</button>
        </div>
      )}
      {mode === 'ask' && canAsk && (
        <>
          <sub-assistant ref={assistant} label="Ask Sales OS" placeholder="Ask about our product, pricing or pipeline" style={{ display: 'block', height: '50vh' }} />
          <p className="muted ask-note">Answers come from approved knowledge entries and our company records, with their sources. If it is not there, it says so. It cannot change anything.</p>
        </>
      )}
      <wa-input ref={input} hidden={mode === 'ask'} placeholder="Search screens and companies" aria-label="Search screens and companies" />
      <ul className="palette" role="listbox" hidden={mode === 'ask'}>
        {items.map((it, i) => (
          <li key={it.key} role="option" aria-selected={i === active} className={i === active ? 'active' : ''}
              onMouseEnter={() => setActive(i)} onClick={() => go(it)}>
            <span>{it.label}</span>
            <span className="muted">{it.hint}</span>
          </li>
        ))}
        {noMatch && <li className="muted">Nothing matches “{q.trim()}”.</li>}
      </ul>
    </wa-dialog>
  );
}
