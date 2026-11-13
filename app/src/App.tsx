import { useEffect, useState } from 'react';
import { ApiError, get, useLoad } from './api';
import { CanProvider, MembersProvider, useMembersLoader } from './ui';
import { UserMenu } from './elements';
import { CommandPalette, OPEN_PALETTE } from './Palette';
import { dropHeldClaim, redeemHeldClaim, takeClaimFromUrl } from './claim';
import { Today } from './views/Today';
import { Companies, CompanyDetail } from './views/Companies';
import { Pipeline } from './views/Pipeline';
import { MeetingsView } from './views/Meetings';
import { ImportView, Exclusions } from './views/Import';
import { KnowledgeView } from './views/Knowledge';
import { Settings } from './views/Settings';
import { AuditView } from './views/Audit';

interface Me {
  principal: string;
  display: string;
}

/**
 * What `/api/me` answers when nobody is signed in on a deployed instance: 200, not 401. While the instance
 * has no owner yet, `firstSignInOpen` is true and the first person to sign in takes the owner seat.
 */
interface NotSignedIn {
  status: string;
  firstSignInOpen?: boolean;
}

/** Hash routing: no server rewrite is needed, and a deep link survives a reload. */
function useRoute(): string[] {
  const read = () => window.location.hash.replace(/^#\/?/, '').split('/').filter(Boolean);
  const [route, setRoute] = useState(read);
  useEffect(() => {
    const on = () => setRoute(read());
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  return route;
}

/** [route, label, the permission that makes it worth showing — none means everyone]. */
const NAV: [string, string, string | null][] = [
  ['today', 'Today', null],
  ['companies', 'Companies', null],
  ['pipeline', 'Pipeline', null],
  ['meetings', 'Meetings', null],
  ['import', 'Import', 'import:run'],
  ['exclusions', 'Do not contact', null],
  ['knowledge', 'Knowledge', null],
  ['audit', 'Audit', 'audit:read'],
];

export function App() {
  const [me, setMe] = useState<Me | null | undefined>(undefined);
  // null: an ordinary signed-out visitor. 'open' / 'closed': the workspace has no owner yet (see NotSignedIn).
  const [unclaimed, setUnclaimed] = useState<'open' | 'closed' | null>(null);
  // A claim link the person arrived with: waiting for them to sign in, or refused.
  const [claim, setClaim] = useState<'sign-in' | 'refused' | null>(null);
  const [fault, setFault] = useState<string | null>(null);
  const route = useRoute();

  useEffect(() => {
    takeClaimFromUrl();
    const load = async (): Promise<void> => {
      let r: Me | NotSignedIn;
      try {
        r = await get<Me | NotSignedIn>('/me');
      } catch (e) {
        if (e instanceof ApiError && e.status === 401) setMe(null);
        else setFault(e instanceof Error ? e.message : String(e));
        return;
      }
      // A signed-in answer names a principal. Anything else, a 200 with `needs-setup` included, is "not signed in".
      if ('principal' in r && typeof r.principal === 'string') {
        dropHeldClaim();
        setMe(r);
        return;
      }
      const setup = (r as NotSignedIn).status === 'needs-setup';
      if (setup) {
        // An unclaimed workspace and a claim link in hand: redeem it. Signed out, that is a 401 that spends nothing.
        const outcome = await redeemHeldClaim();
        if (outcome === 'claimed') return load(); // now bound: ask who we are again
        if (outcome === 'sign-in' || outcome === 'refused') setClaim(outcome);
        setUnclaimed((r as NotSignedIn).firstSignInOpen ? 'open' : 'closed');
      }
      setMe(null);
    };
    void load();
  }, []);

  if (fault) return <main className="center"><p className="note error">{fault}</p></main>;
  if (me === undefined) return <main className="center"><p className="muted">Loading…</p></main>;
  if (me === null) {
    // A claim link, but nobody is signed in: signing in is the next step, and the link is kept for it.
    if (claim === 'sign-in') {
      return (
        <main className="center">
          <h1>Substrat Sales OS</h1>
          <p className="note">You have a claim link for this workspace. <strong>Sign in to become its admin.</strong></p>
          <a className="btn primary" href="/api/auth/login">Sign in</a>
        </main>
      );
    }
    if (claim === 'refused') {
      return (
        <main className="center">
          <h1>Substrat Sales OS</h1>
          <p className="note error">
            That claim link is invalid, expired or already used. Open the <strong>Owner seat</strong> card in the Substrat
            dashboard and mint a new one.
          </p>
        </main>
      );
    }
    // No owner yet, and the 15-minute first-sign-in window has closed: a plain sign-in binds nobody, so do not offer one.
    if (unclaimed === 'closed') {
      return (
        <main className="center">
          <h1>Substrat Sales OS</h1>
          <p className="note">
            This workspace has not been claimed yet, and the first-sign-in window has closed. Whoever installed it can open
            the <strong>Owner seat</strong> card for this app in the Substrat dashboard and follow the claim link it gives them.
            The link works once and expires after 15 minutes.
          </p>
        </main>
      );
    }
    return (
      <main className="center">
        <h1>Substrat Sales OS</h1>
        <p className="muted">One place for prospects, conversations and what to do next.</p>
        {unclaimed === 'open' && (
          <p className="note">Nobody has signed in yet. <strong>The first person to sign in becomes the admin</strong> of this workspace.</p>
        )}
        <a className="btn primary" href="/api/auth/login">Sign in</a>
      </main>
    );
  }
  return <Shell me={me} route={route} />;
}

function Shell({ me, route }: { me: Me; route: string[] }) {
  const members = useMembersLoader();
  const perms = useLoad(async () => new Set((await get<{ permissions: string[] }>('/my-permissions')).permissions), []);
  // Whether this host can actually answer questions. The deployed worker cannot yet, so Ask is not offered there.
  const assistantHost = useLoad(async () => (await get<{ available: boolean }>('/assistant/status')).available, []);
  const [section = 'today', id] = route;
  if (!perms.data) return <main className="center"><p className="muted">{perms.error ? perms.error.message : 'Loading…'}</p></main>;
  const can = perms.data;
  const canAsk = can.has('assistant:use') && assistantHost.data === true;
  const visible = NAV.filter(([, , need]) => !need || can.has(need));
  return (
    <CanProvider value={can}>
    <MembersProvider value={members.data ?? new Map()}>
      <div className="layout">
        {/* A left menu on a desktop; the same markup becomes the top bar on a narrow screen (see styles.css). */}
        <aside className="side">
          <strong className="brand">Substrat Sales OS</strong>
          <nav className="menu" aria-label="Main">
            {visible.map(([key, label]) => (
              <a key={key} href={`#/${key}`} className={section === key ? 'active' : ''}>
                {label}
              </a>
            ))}
          </nav>
          <div className="side-foot">
            {canAsk && (
              <button onClick={() => window.dispatchEvent(new CustomEvent(OPEN_PALETTE, { detail: { mode: 'ask' } }))}>Ask</button>
            )}
            <button className="search" onClick={() => window.dispatchEvent(new CustomEvent(OPEN_PALETTE, { detail: { mode: 'go' } }))} aria-label="Search (Ctrl K)">
              Search <kbd>{/Mac|iPhone|iPad/.test(navigator.platform) ? '⌘K' : 'Ctrl K'}</kbd>
            </button>
            <nav className="menu" aria-label="Account">
              <a href="#/settings" className={section === 'settings' ? 'active' : ''}>Settings</a>
            </nav>
            <UserMenu session={me} />
          </div>
        </aside>
        <main>
          {section === 'today' && <Today />}
          {section === 'companies' && (id ? <CompanyDetail id={id} /> : <Companies />)}
          {section === 'pipeline' && <Pipeline />}
          {section === 'meetings' && <MeetingsView id={id} />}
          {section === 'import' && (can.has('import:run') ? <ImportView /> : <p className="note denied">Importing is for admins.</p>)}
          {section === 'exclusions' && (<><h1>Do not contact</h1><Exclusions /></>)}
          {section === 'knowledge' && <KnowledgeView />}
          {section === 'audit' && (can.has('audit:read') ? <AuditView entityType={route[1]} entityId={route[2]} /> : <p className="note denied">The audit trail is for admins.</p>)}
          {section === 'settings' && <Settings meId={me.principal} />}
          {!NAV.some(([k]) => k === section) && section !== 'settings' && <p className="muted">Nothing here.</p>}
        </main>
      </div>
      <CommandPalette screens={[...visible.map(([route, label]) => ({ route, label })), { route: 'settings', label: 'Settings' }]} canAsk={canAsk} />
    </MembersProvider>
    </CanProvider>
  );
}
