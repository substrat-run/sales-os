import { useState } from 'react';
import { getAll, post, useLoad, type Invite, type Member } from '../api';
import { LOOKS, setTheme, useTheme, type Mode } from '../theme';
import { Badge, ErrorBox, Loading, Section, Who, fmtDate, useAction, useCan } from '../ui';

const MODES: { id: Mode; label: string }[] = [
  { id: 'system', label: 'Match my device' },
  { id: 'light', label: 'Light' },
  { id: 'dark', label: 'Dark' },
];

export function Settings({ meId }: { meId: string }) {
  return (
    <>
      <h1>Settings</h1>
      <Appearance />
      <Team meId={meId} />
    </>
  );
}

function Appearance() {
  const theme = useTheme();
  return (
    <Section title="Appearance" aside={<span className="muted">Saved in this browser</span>}>
      <h3>Look</h3>
      <div className="choices" role="group" aria-label="Look">
        {LOOKS.map((l) => (
          <button key={l.id} type="button" aria-pressed={theme.look === l.id} className={theme.look === l.id ? 'choice on' : 'choice'} onClick={() => setTheme({ look: l.id })}>
            <strong>{l.label}</strong>
            <span className="muted">{l.hint}</span>
          </button>
        ))}
      </div>
      <h3>Light or dark</h3>
      <div className="segmented" role="group" aria-label="Light or dark">
        {MODES.map((m) => (
          <button key={m.id} type="button" aria-pressed={theme.mode === m.id} className={theme.mode === m.id ? 'on' : ''} onClick={() => setTheme({ mode: m.id })}>
            {m.label}
          </button>
        ))}
      </div>
    </Section>
  );
}

const ROLE_LABEL: Record<string, string> = { 'sales-admin': 'Admin', 'sales-member': 'Member' };
const STATUS_TONE: Record<string, string> = { open: 'warn', arrived: 'won', expired: 'lost', withdrawn: '' };

function Team({ meId }: { meId: string }) {
  const canManage = useCan('member:manage');
  const members = useLoad(() => getAll<Member>('/members'), []);
  const invites = useLoad(() => (canManage ? getAll<Invite>('/team/invites') : Promise.resolve([] as Invite[])), [canManage]);
  const refresh = () => { members.reload(); invites.reload(); };
  return (
    <Section title={`Team${members.data ? ` (${members.data.length})` : ''}`}>
      <Loading state={members} />
      {members.data && (
        <table>
          <thead><tr><th>Name</th><th>Email</th><th>Joined</th></tr></thead>
          <tbody>
            {members.data.map((m) => (
              <tr key={m.id}>
                <td>{m.display_name} {m.id === meId && <span className="badge">you</span>}</td>
                <td className="muted">{m.email ?? '—'}</td>
                <td className="muted">{fmtDate(m.created_at)}</td>
              </tr>
            ))}
            {!members.data.length && <tr><td colSpan={3} className="muted">Nobody has signed in yet.</td></tr>}
          </tbody>
        </table>
      )}
      {canManage && <Invitations invites={invites.data ?? []} onChange={refresh} />}
      <p className="muted">
        {canManage
          ? 'To change someone’s role or remove them, use the Substrat dashboard.'
          : 'Admins invite people from here. To change a role or remove someone, an admin uses the Substrat dashboard.'}
      </p>
    </Section>
  );
}

/** Admins only. The sign-in door makes the invitation: it admits the person by the address their sign-in provider verified. */
function Invitations({ invites, onChange }: { invites: Invite[]; onChange: () => void }) {
  const [email, setEmail] = useState('');
  const [role, setRole] = useState('sales-member');
  const [sent, setSent] = useState<string | null>(null);
  const invite = useAction(() => { setSent(email); setEmail(''); onChange(); });
  const withdraw = useAction(onChange);
  return (
    <>
      <h3>Invite someone</h3>
      <form className="inline" onSubmit={(e) => { e.preventDefault(); void invite.run(() => post('/member-invites', { email: email.trim(), roleKey: role })); }}>
        <input type="email" required placeholder="name@company.com" value={email} onChange={(e) => setEmail(e.target.value)} aria-label="Email address" />
        <select value={role} onChange={(e) => setRole(e.target.value)} aria-label="Role">
          <option value="sales-member">Member: works the pipeline</option>
          <option value="sales-admin">Admin: can also manage the team, imports and knowledge</option>
        </select>
        <button className="primary" disabled={invite.busy}>Invite</button>
      </form>
      <ErrorBox error={invite.error} />
      {sent && (
        <p className="note">
          Invited <strong>{sent}</strong>. No email is sent: ask them to open <strong>{window.location.origin}</strong> and sign in with that address, and they are let in.
        </p>
      )}
      {invites.length > 0 && (
        <>
          <h3>Invitations</h3>
          <ErrorBox error={withdraw.error} />
          <table>
            <thead><tr><th>Email</th><th>Role</th><th>Status</th><th>Invited by</th><th /></tr></thead>
            <tbody>
              {[...invites].reverse().map((i) => (
                <tr key={i.id}>
                  <td>{i.email}</td>
                  <td>{ROLE_LABEL[i.role_key] ?? i.role_key}</td>
                  <td><Badge kind={STATUS_TONE[i.status] ?? ''}>{i.status}</Badge>{i.status === 'open' && <span className="muted"> until {fmtDate(i.expires_at)}</span>}</td>
                  <td className="muted"><Who id={i.invited_by} /></td>
                  <td>{i.status === 'open' && <button disabled={withdraw.busy} onClick={() => withdraw.run(() => post(`/member-invites/${i.id}/withdraw`, {}))}>Withdraw</button>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </>
  );
}
