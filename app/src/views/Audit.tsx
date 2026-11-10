import { useState } from 'react';
import { getAll, useLoad, type HistoryEntry } from '../api';
import { Actor, ErrorBox, Field, Loading, Section, fmtTime } from '../ui';

const TYPES = ['company', 'contact', 'opportunity', 'interaction', 'task', 'knowledge', 'exclusion', 'duplicate'];

/** The full trail of one record: who or what, when, the payload, and the permission that allowed it. */
export function AuditView({ entityType, entityId }: { entityType?: string | undefined; entityId?: string | undefined }) {
  const [type, setType] = useState(entityType ?? 'company');
  const [id, setId] = useState(entityId ?? '');
  const [asked, setAsked] = useState(entityType && entityId ? { type: entityType, id: entityId } : null);
  const q = useLoad(() => (asked ? getAll<HistoryEntry>(`/audit/${asked.type}/${asked.id}`) : Promise.resolve([] as HistoryEntry[])), [asked?.type, asked?.id]);
  return (
    <>
      <h1>Audit trail</h1>
      <p className="muted">Admins only. Every change to a record: what, when, who or what made it, and which permission allowed it.</p>
      <form className="inline" onSubmit={(e) => { e.preventDefault(); setAsked({ type, id: id.trim() }); }}>
        <select value={type} onChange={(e) => setType(e.target.value)}>{TYPES.map((t) => <option key={t}>{t}</option>)}</select>
        <input required placeholder="Record id" value={id} onChange={(e) => setId(e.target.value)} />
        <button>Show</button>
      </form>
      <Loading state={q} />
      <ErrorBox error={q.error} />
      {asked && q.data && (
        <Section title={`${asked.type} ${asked.id}`}>
          {!q.data.length && <p className="muted">No events recorded for this record.</p>}
          <ul className="rows">
            {[...q.data].reverse().map((e) => (
              <li key={e.id}>
                <div>
                  <strong>{e.type}</strong> <span className="muted">{fmtTime(e.occurredAt)} · <Actor actor={e.actor} /></span>
                  <details>
                    <summary>Details</summary>
                    <Field label="Payload"><pre>{JSON.stringify(e.payload, null, 2)}</pre></Field>
                    <Field label="Authorized by"><pre>{JSON.stringify(e.authorization, null, 2)}</pre></Field>
                  </details>
                </div>
              </li>
            ))}
          </ul>
        </Section>
      )}
    </>
  );
}
