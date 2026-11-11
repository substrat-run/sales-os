import { useEffect, useState } from 'react';
import { ApiError, get, useLoad } from './api';
import { CanProvider, MembersProvider, useMembersLoader } from './ui';
import { UserMenu } from './elements';
import { CommandPalette, OPEN_PALETTE } from './Palette';
import { Today } from './views/Today';
import { Companies, CompanyDetail } from './views/Companies';
import { Pipeline } from './views/Pipeline';
import { ImportView, Exclusions } from './views/Import';
import { KnowledgeView } from './views/Knowledge';
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
  ['import', 'Import', 'import:run'],
  ['exclusions', 'Do not contact', null],
  ['knowledge', 'Knowledge', null],
  ['audit', 'Audit', 'audit:read'],
];

export function App() {
  const [me, setMe] = useState<Me | null | undefined>(undefined);
  const [firstSignIn, setFirstSignIn] = useState(false);
  const [fault, setFault] = useState<string | null>(null);
  const route = useRoute();

  useEffect(() => {
    get<Me | NotSignedIn>('/me').then((r) => {
      // A signed-in answer names a principal. Anything else, a 200 with `needs-setup` included, is "not signed in".
      if ('principal' in r && typeof r.principal === 'string') setMe(r);
      else {
        setFirstSignIn(Boolean((r as NotSignedIn).firstSignInOpen));
        setMe(null);
      }
    }, (e: unknown) => {
      if (e instanceof ApiError && e.status === 401) setMe(null);
      else setFault(e instanceof Error ? e.message : String(e));
    });
  }, []);

  if (fault) return <main className="center"><p className="note error">{fault}</p></main>;
  if (me === undefined) return <main className="center"><p className="muted">Loading…</p></main>;
  if (me === null) {
    return (
      <main className="center">
        <h1>Substrat Sales OS</h1>
        <p className="muted">One place for prospects, conversations and what to do next.</p>
        {firstSignIn && (
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
  const [section = 'today', id] = route;
  if (!perms.data) return <main className="center"><p className="muted">{perms.error ? perms.error.message : 'Loading…'}</p></main>;
  const can = perms.data;
  const visible = NAV.filter(([, , need]) => !need || can.has(need));
  return (
    <CanProvider value={can}>
    <MembersProvider value={members.data ?? new Map()}>
      <header className="top">
        <strong className="brand">Substrat Sales OS</strong>
        <nav>
          {visible.map(([key, label]) => (
            <a key={key} href={`#/${key}`} className={section === key ? 'active' : ''}>
              {label}
            </a>
          ))}
        </nav>
        {can.has('assistant:use') && (
          <button onClick={() => window.dispatchEvent(new CustomEvent(OPEN_PALETTE, { detail: { mode: 'ask' } }))}>Ask</button>
        )}
        <button className="search" onClick={() => window.dispatchEvent(new CustomEvent(OPEN_PALETTE, { detail: { mode: 'go' } }))} aria-label="Search (Ctrl K)">
          Search <kbd>{/Mac|iPhone|iPad/.test(navigator.platform) ? '⌘K' : 'Ctrl K'}</kbd>
        </button>
        <UserMenu session={me} />
        <CommandPalette screens={visible.map(([route, label]) => ({ route, label }))} canAsk={can.has('assistant:use')} />
      </header>
      <main>
        {section === 'today' && <Today />}
        {section === 'companies' && (id ? <CompanyDetail id={id} /> : <Companies />)}
        {section === 'pipeline' && <Pipeline />}
        {section === 'import' && (can.has('import:run') ? <ImportView /> : <p className="note denied">Importing is for admins.</p>)}
        {section === 'exclusions' && (<><h1>Do not contact</h1><Exclusions /></>)}
        {section === 'knowledge' && <KnowledgeView />}
        {section === 'audit' && (can.has('audit:read') ? <AuditView entityType={route[1]} entityId={route[2]} /> : <p className="note denied">The audit trail is for admins.</p>)}
        {!NAV.some(([k]) => k === section) && <p className="muted">Nothing here.</p>}
      </main>
    </MembersProvider>
    </CanProvider>
  );
}
