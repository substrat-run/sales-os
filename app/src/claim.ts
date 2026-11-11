import { ApiError, post } from './api';

// ============================================================================
// Claiming a new workspace's owner seat. The installer's dashboard mints a one-use link, `/?claim=<secret>`;
// the app redeems it with `POST /api/claim-owner { token }` once somebody is SIGNED IN (a signed-out attempt
// is a 401 and does not spend the link). Signing in leaves the page and comes back to `/`, so the secret is
// held in sessionStorage across that round trip, and taken out of the address bar at once so it does not
// linger in history or travel in a Referer.
// ============================================================================

const KEY = 'sales-os:claim';

const store = {
  get: () => { try { return sessionStorage.getItem(KEY); } catch { return null; } },
  set: (v: string) => { try { sessionStorage.setItem(KEY, v); } catch { /* private mode: the link then has to be opened again after sign-in */ } },
  clear: () => { try { sessionStorage.removeItem(KEY); } catch { /* nothing to clear */ } },
};

/** Move a `?claim=` secret from the address bar into storage. Call once, before anything reads the URL. */
export function takeClaimFromUrl(): void {
  const params = new URLSearchParams(window.location.search);
  const token = params.get('claim');
  if (!token) return;
  store.set(token);
  params.delete('claim');
  const rest = params.toString();
  window.history.replaceState(null, '', window.location.pathname + (rest ? `?${rest}` : '') + window.location.hash);
}

export type ClaimOutcome = 'none' | 'claimed' | 'sign-in' | 'refused';

/** Try the held link, if there is one. `sign-in`: nobody is signed in yet, the link is kept. `refused`: it is dropped. */
export async function redeemHeldClaim(): Promise<ClaimOutcome> {
  const token = store.get();
  if (!token) return 'none';
  try {
    await post('/claim-owner', { token });
    store.clear();
    return 'claimed';
  } catch (e) {
    if (e instanceof ApiError && e.status === 401) return 'sign-in';
    store.clear();
    return 'refused';
  }
}

/** Forget a held link: someone already bound here has nothing to claim, so it must not linger. */
export function dropHeldClaim(): void {
  store.clear();
}
