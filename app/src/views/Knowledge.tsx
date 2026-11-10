import { useState } from 'react';
import { CATEGORIES, CLAIMS, getAll, getWithEtag, post, qs, useLoad, type Knowledge } from '../api';
import { Badge, ErrorBox, Field, Loading, Section, Who, fmtDate, useAction, useCan } from '../ui';

const CLAIM_TEXT: Record<string, string> = { shipped: 'Shipped', built_unproven: 'Built, unproven', bet: 'Bet' };

export function KnowledgeView() {
  const [category, setCategory] = useState('');
  const [status, setStatus] = useState('');
  const q = useLoad(() => getAll<Knowledge>('/knowledge' + qs({ category, status })), [category, status]);
  const [adding, setAdding] = useState(false);
  const canManage = useCan('knowledge:manage');
  return (
    <>
      <h1>Knowledge base</h1>
      <p className="muted">The approved source of truth. Every product claim says whether it is shipped, built but unproven, or a bet. Only approved entries are to be relied on.</p>
      <div className="toolbar">
        <select value={category} onChange={(e) => setCategory(e.target.value)}>
          <option value="">all categories</option>{CATEGORIES.map((c) => <option key={c}>{c}</option>)}
        </select>
        <select value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="">all statuses</option><option>draft</option><option>approved</option><option>retired</option>
        </select>
        {canManage && <button onClick={() => setAdding(!adding)}>{adding ? 'Cancel' : 'New entry'}</button>}
      </div>
      {adding && <NewEntry onDone={() => { setAdding(false); q.reload(); }} />}
      <Loading state={q} />
      {(q.data ?? []).map((k) => <Entry key={k.id} k={k} onDone={q.reload} />)}
      {q.data && !q.data.length && <p className="muted">No entries match.</p>}
    </>
  );
}

function NewEntry({ onDone }: { onDone: () => void }) {
  const [f, setF] = useState({ title: '', body: '', category: 'positioning', claimLabel: '', source: '', sourceDate: '' });
  const act = useAction(onDone);
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  const needsLabel = f.category === 'positioning' || f.category === 'capability';
  return (
    <form className="card form" onSubmit={(e) => {
      e.preventDefault();
      void act.run(() => post('/knowledge', { title: f.title, body: f.body, category: f.category, source: f.source, ...(f.claimLabel && { claimLabel: f.claimLabel }), ...(f.sourceDate && { sourceDate: f.sourceDate }) }));
    }}>
      <Field label="Title"><input required value={f.title} onChange={set('title')} /></Field>
      <div className="inline">
        <select value={f.category} onChange={set('category')}>{CATEGORIES.map((c) => <option key={c}>{c}</option>)}</select>
        <select required={needsLabel} value={f.claimLabel} onChange={set('claimLabel')}>
          <option value="">{needsLabel ? 'claim label (required)' : 'claim label'}</option>
          {CLAIMS.map((c) => <option key={c} value={c}>{CLAIM_TEXT[c]}</option>)}
        </select>
      </div>
      <Field label="Entry"><textarea required rows={4} value={f.body} onChange={set('body')} /></Field>
      <div className="inline">
        <input required placeholder="Source (document, person, link)" value={f.source} onChange={set('source')} />
        <input type="date" value={f.sourceDate} onChange={set('sourceDate')} />
      </div>
      <ErrorBox error={act.error} />
      <button className="primary" disabled={act.busy}>Save as draft</button>
    </form>
  );
}

function Entry({ k, onDone }: { k: Knowledge; onDone: () => void }) {
  const canManage = useCan('knowledge:manage');
  const act = useAction(onDone);
  const [editing, setEditing] = useState(false);
  return (
    <Section title={k.title} aside={<span><Badge>{k.category}</Badge> {k.claim_label && <Badge kind={`claim-${k.claim_label}`}>{CLAIM_TEXT[k.claim_label]}</Badge>} <Badge kind={k.status === 'approved' ? 'won' : k.status === 'retired' ? 'lost' : 'warn'}>{k.status}</Badge></span>}>
      {editing ? (
        <EditEntry id={k.id} onSaved={() => { setEditing(false); onDone(); }} />
      ) : (
        <p className="pre">{k.body}</p>
      )}
      <p className="muted">
        Source: {k.source}{k.source_date ? ` (${fmtDate(k.source_date)})` : ''} · written by <Who id={k.created_by} />
        {k.approved_by ? <> · approved by <Who id={k.approved_by} /> {fmtDate(k.approved_at)}</> : null}
      </p>
      <ErrorBox error={act.error} />
      {canManage && <div className="actions">
        {k.status === 'draft' && <button className="primary" disabled={act.busy} onClick={() => act.run(() => post(`/knowledge/${k.id}/approve`, { knowledgeId: k.id }))}>Approve</button>}
        {k.status !== 'retired' && <button disabled={act.busy} onClick={() => setEditing(!editing)}>{editing ? 'Cancel' : 'Edit'}</button>}
        {k.status !== 'retired' && <button disabled={act.busy} onClick={() => act.run(() => post(`/knowledge/${k.id}/retire`, { knowledgeId: k.id }))}>Retire</button>}
      </div>}
    </Section>
  );
}

/** Edits the CURRENT entry: read fresh when the form opens, its version sent back as If-Match. */
function EditEntry({ id, onSaved }: { id: string; onSaved: () => void }) {
  const cur = useLoad(() => getWithEtag<Knowledge>(`/knowledge/${id}`), [id]);
  if (!cur.data) return <Loading state={cur} />;
  return <EditEntryForm key={cur.data.etag ?? ''} row={cur.data.data} etag={cur.data.etag} onSaved={onSaved} onReload={cur.reload} />;
}

function EditEntryForm({ row, etag, onSaved, onReload }: { row: Knowledge; etag: string | null; onSaved: () => void; onReload: () => void }) {
  const [body, setBody] = useState(row.body);
  const act = useAction(onSaved);
  return (
    <form className="form" onSubmit={(e) => { e.preventDefault(); void act.run(() => post(`/knowledge/${row.id}/update`, { knowledgeId: row.id, body }, etag)); }}>
      <textarea rows={4} value={body} onChange={(e) => setBody(e.target.value)} />
      <p className="muted">Editing an approved entry sends it back to draft for approval.</p>
      <ErrorBox error={act.error} onReload={onReload} />
      <button disabled={act.busy}>Save</button>
    </form>
  );
}
