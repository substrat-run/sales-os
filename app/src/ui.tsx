import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { ApiError, get, getAll, useLoad, type Member } from './api';

// ============================================================================
// Small shared pieces: who is who, errors that say what happened, and the forms.
// ============================================================================

/** The permission keys the signed-in person holds, so a screen hides what they cannot do. The server still decides. */
const CanCtx = createContext<Set<string>>(new Set());
export const CanProvider = CanCtx.Provider;
export function useCan(key: string): boolean {
  return useContext(CanCtx).has(key);
}

/** principal id → display name. The member table is the ONE source of a person's name. */
const MembersCtx = createContext<Map<string, string>>(new Map());
export const MembersProvider = MembersCtx.Provider;
export function useMemberNames() {
  return useContext(MembersCtx);
}
export function useMembersLoader() {
  return useLoad(async () => new Map((await getAll<Member>('/members')).map((m) => [m.id, m.display_name])), []);
}
export function Who({ id }: { id: string | null | undefined }) {
  const names = useMemberNames();
  if (!id) return <span className="muted">unassigned</span>;
  return <>{names.get(id) ?? 'someone'}</>;
}

/** A person's id out of the kernel's `actor` union, however it was encoded. */
export function actorId(actor: unknown): string | null {
  const text = typeof actor === 'string' ? actor : JSON.stringify(actor ?? '');
  return /[0-9A-Z]{26}/.exec(text)?.[0] ?? null;
}
export function Actor({ actor }: { actor: unknown }) {
  const names = useMemberNames();
  const id = actorId(actor);
  if (id && names.has(id)) return <>{names.get(id)}</>;
  const kind = typeof actor === 'object' && actor ? String((actor as { type?: string; kind?: string }).type ?? (actor as { kind?: string }).kind ?? '') : '';
  return <span className="muted">{kind || 'the system'}</span>;
}

/** The company name for an id, fetched once and remembered. */
const companyCache = new Map<string, Promise<string>>();
export function companyName(id: string): Promise<string> {
  let p = companyCache.get(id);
  if (!p) {
    p = get<{ company: { name: string; domain: string | null } }>(`/companies/${id}`).then(
      (r) => (r.company.domain ? `${r.company.name} · ${r.company.domain}` : r.company.name),
      () => 'unknown company',
    );
    companyCache.set(id, p);
  }
  return p;
}
export function forgetCompanyNames() {
  companyCache.clear();
}
export function CompanyLink({ id, name }: { id: string; name?: string }) {
  const [n, setN] = useState(name);
  useEffect(() => {
    if (!name) void companyName(id).then(setN);
  }, [id, name]);
  return <a href={`#/companies/${id}`}>{n ?? '…'}</a>;
}

export function ErrorBox({ error, onReload }: { error: ApiError | Error | null | undefined; onReload?: () => void }) {
  if (!error) return null;
  if (error instanceof ApiError && error.stale) {
    return (
      <div className="note denied" role="alert">
        Someone else changed this record while you were editing it, so your changes were not saved.{' '}
        {onReload ? <button type="button" onClick={onReload}>Load the latest version</button> : 'Reload the page to see the latest version.'}
      </div>
    );
  }
  const denied = error instanceof ApiError && error.denied;
  return (
    <div className={denied ? 'note denied' : 'note error'} role="alert">
      {denied ? 'Your role does not allow this. ' : ''}
      {error.message}
    </div>
  );
}

export function Loading({ state }: { state: { loading: boolean; data: unknown; error: ApiError | null } }) {
  if (state.error) return <ErrorBox error={state.error} />;
  if (state.loading && state.data === undefined) return <p className="muted">Loading…</p>;
  return null;
}

/** Run an action, keep the error, then run `after`. */
export function useAction(after?: () => void) {
  const [error, setError] = useState<Error | null>(null);
  const [busy, setBusy] = useState(false);
  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      after?.();
      return true;
    } catch (e) {
      setError(e as Error);
      return false;
    } finally {
      setBusy(false);
    }
  };
  return { run, error, busy };
}

export function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) {
  return (
    <label className="field">
      <span>{label}</span>
      {children}
      {hint ? <small className="muted">{hint}</small> : null}
    </label>
  );
}

export function Section({ title, aside, children }: { title: string; aside?: ReactNode; children: ReactNode }) {
  return (
    <section className="card">
      <header>
        <h2>{title}</h2>
        {aside}
      </header>
      {children}
    </section>
  );
}

export function Badge({ kind, children }: { kind?: string; children: ReactNode }) {
  return <span className={`badge ${kind ?? ''}`}>{children}</span>;
}

export const fmtDate = (iso: string | null | undefined) => (iso ? iso.slice(0, 10) : '—');
export const fmtTime = (iso: string) => iso.slice(0, 16).replace('T', ' ');
export const money = (o: { value_low: string | null; value_high: string | null; currency: string }) =>
  o.value_low || o.value_high ? `${o.value_low ?? '?'}–${o.value_high ?? '?'} ${o.currency}` : '—';
export const csvSelect = (v: string) => (v === '' ? undefined : v);
