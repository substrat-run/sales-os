import { useCallback, useEffect, useRef, useState } from 'react';

// ============================================================================
// The API client. The app calls its OWN origin (`/api/…`): in dev Vite proxies it,
// deployed the worker answers it. Never a baked-in base URL.
// ============================================================================

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
  get denied(): boolean {
    return this.status === 403;
  }
  /** Someone else saved the record after this person read it (If-Match no longer matches). */
  get stale(): boolean {
    return this.status === 412;
  }
}

export interface Result<T> {
  data: T;
  next: string | null;
  etag: string | null;
}

/** The next page's URL, read off the `Link` header the platform sets on every paged read. */
function nextOf(link: string | null): string | null {
  if (!link) return null;
  for (const part of link.split(',')) {
    const m = /<([^>]+)>\s*;\s*rel="?next"?/.exec(part);
    if (m) {
      try {
        const u = new URL(m[1]!, window.location.origin);
        return u.pathname + u.search;
      } catch {
        return null;
      }
    }
  }
  return null;
}

async function send<T>(method: string, path: string, body?: unknown, ifMatch?: string | null): Promise<Result<T>> {
  const res = await fetch(path.startsWith('/api') ? path : '/api' + path, {
    method,
    credentials: 'same-origin',
    headers: {
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(ifMatch ? { 'if-match': ifMatch } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  let json: unknown = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    // An HTML body here means the request never reached the worker (a missing runWorkerFirst prefix).
    throw new ApiError(res.status, `unexpected non-JSON answer (${res.status})`);
  }
  if (!res.ok) {
    const j = json as { detail?: string; error?: string } | null;
    throw new ApiError(res.status, j?.detail ?? j?.error ?? `request failed (${res.status})`);
  }
  return { data: json as T, next: nextOf(res.headers.get('link')), etag: res.headers.get('etag') };
}

export const get = async <T,>(path: string): Promise<T> => (await send<T>('GET', path)).data;
export const getWithEtag = <T,>(path: string) => send<T>('GET', path);
export const post = async <T,>(path: string, body: unknown = {}, ifMatch?: string | null): Promise<T> =>
  (await send<T>('POST', path, body, ifMatch)).data;

/** One page in the shape `<sub-entity-table>` reads: `{ entries, next, total }`. `next` is a URL to follow, not to rebuild. */
export async function readPage<T>(path: string): Promise<{ entries: T[]; next: string | null; total: number | null }> {
  const r = await send<T[]>('GET', path);
  return { entries: r.data, next: r.next, total: null };
}

export function qs(params: Record<string, string | number | boolean | undefined | null>): string {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== '') p.set(k, String(v));
  const s = p.toString();
  return s ? '?' + s : '';
}

/** Read every page of a list, up to `max` pages: the workspace is small, and a page is bounded. */
export async function getAll<T>(path: string, max = 10): Promise<T[]> {
  const out: T[] = [];
  let url: string | null = path;
  for (let i = 0; i < max && url; i++) {
    const r: Result<T[]> = await send<T[]>('GET', url);
    out.push(...r.data);
    url = r.next;
  }
  return out;
}

// ------------------------------------------------------------------ hooks

export interface Loaded<T> {
  data: T | undefined;
  error: ApiError | null;
  loading: boolean;
  reload: () => void;
}

export function useLoad<T>(fn: () => Promise<T>, deps: unknown[]): Loaded<T> {
  const [data, setData] = useState<T>();
  const [error, setError] = useState<ApiError | null>(null);
  const [loading, setLoading] = useState(true);
  const [tick, setTick] = useState(0);
  const live = useRef(0);
  useEffect(() => {
    const mine = ++live.current;
    setLoading(true);
    fn().then(
      (d) => {
        if (live.current !== mine) return;
        setData(d);
        setError(null);
        setLoading(false);
      },
      (e: unknown) => {
        if (live.current !== mine) return;
        setError(e instanceof ApiError ? e : new ApiError(0, String(e)));
        setLoading(false);
      },
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, tick]);
  const reload = useCallback(() => setTick((t) => t + 1), []);
  return { data, error, loading, reload };
}

// ------------------------------------------------------------------ row types

export interface Company {
  id: string; name: string; domain: string | null; segment: string | null; fit_score: number | null;
  fit_reason: string | null; owner_id: string | null; source: string | null;
  relationship_context: string | null; merged_into: string | null; created_at: string; updated_at: string;
}
export interface Contact {
  id: string; company_id: string; name: string; role: string | null; email: string | null; phone: string | null;
  source: string | null; owner_id: string | null; opted_out: number; created_at: string;
}
export interface Opportunity {
  id: string; company_id: string; title: string; stage: string; fit_rationale: string | null;
  value_low: string | null; value_high: string | null; currency: string; owner_id: string | null;
  next_step: string | null; target_date: string | null; lost_reason: string | null; created_at: string; updated_at: string;
}
export interface Interaction {
  id: string; company_id: string; contact_id: string | null; opportunity_id: string | null; kind: string;
  direction: string | null; summary: string; customer_quote: string | null; generated: number;
  performed_by_kind: string; performed_by: string; occurred_at: string; created_at: string;
}
export interface Task {
  id: string; company_id: string | null; opportunity_id: string | null; title: string; due_date: string;
  owner_id: string | null; done_at: string | null; created_at: string;
}
export interface Knowledge {
  id: string; title: string; body: string; category: string; claim_label: string | null; source: string;
  source_date: string | null; status: string; created_by: string; approved_by: string | null;
  approved_at: string | null; created_at: string; updated_at: string;
}
export interface Exclusion { id: string; kind: string; value: string; reason: string; created_by: string; created_at: string }
export interface Member { id: string; display_name: string; email: string | null; created_at: string }
export interface Batch {
  id: string; filename: string; uploaded_by: string; row_count: number; created_count: number;
  matched_count: number; flagged_count: number; created_at: string;
}
export interface ImportRow {
  id: string; batch_id: string; row_number: number; raw: string; outcome: string; note: string | null;
  company_id: string | null; contact_id: string | null;
}
export interface Duplicate {
  id: string; kind: string; left_id: string; right_id: string; reason: string; status: string;
  batch_id: string | null; decided_by: string | null; decided_at: string | null; snapshot: string | null; created_at: string;
}
export interface TimelineEntry { id: string; type: string; occurredAt: string; actor: unknown }
export interface HistoryEntry extends TimelineEntry { payload: unknown; authorization: unknown; piiClass?: string }
export interface TodayData {
  today: string; stalledAfterDays: number; overdueTasks: Task[]; dueToday: Task[];
  stalledOpportunities: Opportunity[]; opportunitiesWithoutNextStep: Opportunity[];
}

export const STAGES = ['new', 'contacted', 'in_conversation', 'meeting_held', 'proposal', 'won', 'lost'] as const;
export const stageLabel = (s: string) => s.replace(/_/g, ' ');
export const CATEGORIES = ['positioning', 'capability', 'icp', 'pricing', 'collateral', 'security', 'faq', 'case', 'relationship'] as const;
export const CLAIMS = ['shipped', 'built_unproven', 'bet'] as const;
