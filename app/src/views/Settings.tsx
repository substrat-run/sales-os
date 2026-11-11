import { getAll, useLoad, type Member } from '../api';
import { LOOKS, setTheme, useTheme, type Mode } from '../theme';
import { Loading, Section, fmtDate } from '../ui';

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

function Team({ meId }: { meId: string }) {
  const q = useLoad(() => getAll<Member>('/members'), []);
  return (
    <Section title={`Team${q.data ? ` (${q.data.length})` : ''}`}>
      <Loading state={q} />
      {q.data && (
        <table>
          <thead><tr><th>Name</th><th>Email</th><th>Joined</th></tr></thead>
          <tbody>
            {q.data.map((m) => (
              <tr key={m.id}>
                <td>{m.display_name} {m.id === meId && <span className="badge">you</span>}</td>
                <td className="muted">{m.email ?? '—'}</td>
                <td className="muted">{fmtDate(m.created_at)}</td>
              </tr>
            ))}
            {!q.data.length && <tr><td colSpan={3} className="muted">Nobody has signed in yet.</td></tr>}
          </tbody>
        </table>
      )}
      <p className="muted">People appear here the first time they sign in. To change someone’s role or remove them, use the Substrat dashboard.</p>
    </Section>
  );
}
