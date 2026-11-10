import { useMemo, useState, type FormEvent } from 'react';
import {
  get, getAll, getWithEtag, post, qs, readPage, stageLabel, useLoad,
  type Company, type Contact, type HistoryEntry, type Interaction, type Opportunity, type TimelineEntry,
} from '../api';
import { EntityTable, type ColumnSpec, type TableSource } from '../elements';
import { Actor, Badge, ErrorBox, Field, Loading, Section, Who, fmtDate, fmtTime, money, useAction, useCan, useMemberNames } from '../ui';

export function Companies() {
  const names = useMemberNames();
  const [adding, setAdding] = useState(false);
  const [version, setVersion] = useState(0);
  // The table owns paging and search; both stay on the server. Stable identities, or it starts over.
  const source = useMemo<TableSource<Company>>(
    () => ({
      read: (q) => readPage<Company>('/companies' + qs({ limit: q.limit })),
      follow: (next) => readPage<Company>(next),
      search: async (term) => {
        const page = await readPage<Company>('/companies' + qs({ q: term }));
        return { results: page.entries, capped: page.next !== null };
      },
    }),
    [],
  );
  const columns = useMemo<ColumnSpec<Company>[]>(
    () => [
      { key: 'name', label: 'Name', href: (c) => `#/companies/${c.id}` },
      { key: 'domain', label: 'Domain', value: (c) => c.domain ?? '—' },
      { key: 'segment', label: 'Segment', value: (c) => c.segment ?? '—', priority: 2 },
      { key: 'owner', label: 'Owner', value: (c) => (c.owner_id ? (names.get(c.owner_id) ?? 'someone') : 'unassigned'), priority: 2 },
      { key: 'source', label: 'Source', value: (c) => c.source ?? '—', priority: 3 },
    ],
    [names],
  );
  return (
    <>
      <h1>Companies</h1>
      <div className="toolbar">
        <button onClick={() => setAdding(!adding)}>{adding ? 'Cancel' : 'Add company'}</button>
      </div>
      {adding && <AddCompany onDone={() => { setAdding(false); setVersion((v) => v + 1); }} />}
      <EntityTable
        label="Companies"
        source={source}
        columns={columns}
        reloadKey={version}
        empty={<span className="muted">No companies yet. Add one, or import a CSV.</span>}
      />
    </>
  );
}

function AddCompany({ onDone }: { onDone: () => void }) {
  const [f, setF] = useState({ companyName: '', domain: '', segment: '', source: '' });
  const act = useAction(onDone);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    void act.run(() => post('/companies', { companyName: f.companyName, source: f.source, ...(f.domain && { domain: f.domain }), ...(f.segment && { segment: f.segment }) }));
  };
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  return (
    <form className="card form" onSubmit={submit}>
      <Field label="Company name"><input required value={f.companyName} onChange={set('companyName')} /></Field>
      <Field label="Domain"><input value={f.domain} onChange={set('domain')} placeholder="acme.com" /></Field>
      <Field label="Segment"><input value={f.segment} onChange={set('segment')} /></Field>
      <Field label="Source" hint="Where did this lead come from?"><input required value={f.source} onChange={set('source')} /></Field>
      <ErrorBox error={act.error} />
      <button className="primary" disabled={act.busy}>Add company</button>
    </form>
  );
}

interface Detail { company: Company; contacts: Contact[]; opportunities: Opportunity[] }

export function CompanyDetail({ id }: { id: string }) {
  const d = useLoad(async () => {
    const r = await getWithEtag<Detail>(`/companies/${id}`);
    return { ...r.data, etag: r.etag };
  }, [id]);
  const inter = useLoad(() => getAll<Interaction>('/interactions' + qs({ companyId: id })), [id]);
  const refresh = () => { d.reload(); inter.reload(); };
  if (!d.data) return <Loading state={d} />;
  const { company, contacts, opportunities, etag } = d.data;
  return (
    <>
      <p><a href="#/companies">← Companies</a></p>
      <h1>{company.name} {company.merged_into && <Badge kind="warn">merged away</Badge>}</h1>
      {company.merged_into && (
        <p className="note">This record was merged into <a href={`#/companies/${company.merged_into}`}>another company</a>. Nothing was deleted.</p>
      )}
      <div className="grid2">
        <Section title="Details">
          <dl>
            <dt>Domain</dt><dd>{company.domain ?? '—'}</dd>
            <dt>Segment</dt><dd>{company.segment ?? '—'}</dd>
            <dt>Owner</dt><dd><Who id={company.owner_id} /></dd>
            <dt>Source</dt><dd>{company.source ?? '—'}</dd>
            <dt>Fit</dt><dd>{company.fit_score ?? '—'}{company.fit_reason ? ` — ${company.fit_reason}` : ''}</dd>
            <dt>Added</dt><dd>{fmtDate(company.created_at)}</dd>
          </dl>
          <Context key={etag ?? ''} company={company} etag={etag} onDone={refresh} />
        </Section>
        <ContactsSection company={company} contacts={contacts} onDone={refresh} />
      </div>
      <OpportunitiesSection company={company} opportunities={opportunities} onDone={refresh} />
      <InteractionsSection company={company} contacts={contacts} opportunities={opportunities} items={inter.data ?? []} onDone={refresh} />
      <TimelineSection id={id} version={inter.data?.length ?? 0} />
    </>
  );
}

/** Sends the version it read as If-Match: a save over someone else's newer change is refused, not applied. */
function Context({ company, etag, onDone }: { company: Company; etag: string | null; onDone: () => void }) {
  const [text, setText] = useState(company.relationship_context ?? '');
  const act = useAction(onDone);
  return (
    <form onSubmit={(e) => { e.preventDefault(); void act.run(() => post(`/companies/${company.id}/update`, { companyId: company.id, relationshipContext: text }, etag)); }}>
      <Field label="Relationship context" hint="What we already know: how we met, who knows whom.">
        <textarea rows={3} value={text} onChange={(e) => setText(e.target.value)} />
      </Field>
      <ErrorBox error={act.error} onReload={onDone} />
      <button disabled={act.busy || !text || text === company.relationship_context}>Save context</button>
    </form>
  );
}

function ContactsSection({ company, contacts, onDone }: { company: Company; contacts: Contact[]; onDone: () => void }) {
  const [f, setF] = useState({ name: '', role: '', email: '' });
  const add = useAction(() => { setF({ name: '', role: '', email: '' }); onDone(); });
  const opt = useAction(onDone);
  const canLift = useCan('exclusion:lift');
  return (
    <Section title={`Contacts (${contacts.length})`}>
      <ul className="rows">
        {contacts.map((c) => (
          <li key={c.id}>
            <div>
              <strong>{c.name}</strong> {c.opted_out ? <Badge kind="warn">opted out</Badge> : null}
              <div className="muted">{[c.role, c.email].filter(Boolean).join(' · ') || '—'}</div>
            </div>
            {(!c.opted_out || canLift) && (
              <button disabled={opt.busy} onClick={() => opt.run(() => post(`/contacts/${c.id}/opt-out`, { contactId: c.id, optedOut: !c.opted_out }))}>
                {c.opted_out ? 'Lift opt-out' : 'Opt out'}
              </button>
            )}
          </li>
        ))}
      </ul>
      <ErrorBox error={opt.error} />
      <form className="inline" onSubmit={(e) => { e.preventDefault(); void add.run(() => post('/contacts', { companyId: company.id, name: f.name, ...(f.role && { role: f.role }), ...(f.email && { email: f.email }) })); }}>
        <input required placeholder="Name" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />
        <input placeholder="Role" value={f.role} onChange={(e) => setF({ ...f, role: e.target.value })} />
        <input type="email" placeholder="Email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} />
        <button disabled={add.busy}>Add contact</button>
      </form>
      <ErrorBox error={add.error} />
    </Section>
  );
}

function OpportunitiesSection({ company, opportunities, onDone }: { company: Company; opportunities: Opportunity[]; onDone: () => void }) {
  const [title, setTitle] = useState('');
  const add = useAction(() => { setTitle(''); onDone(); });
  return (
    <Section title={`Opportunities (${opportunities.length})`}>
      <table>
        <thead><tr><th>Use case</th><th>Stage</th><th>Value</th><th>Owner</th><th>Next step</th><th>Target</th></tr></thead>
        <tbody>
          {opportunities.map((o) => (
            <tr key={o.id}>
              <td>{o.title}</td>
              <td><Badge kind={o.stage}>{stageLabel(o.stage)}</Badge></td>
              <td>{money(o)}</td>
              <td><Who id={o.owner_id} /></td>
              <td>{o.next_step ?? <span className="muted">none</span>}</td>
              <td>{fmtDate(o.target_date)}</td>
            </tr>
          ))}
          {!opportunities.length && <tr><td colSpan={6} className="muted">No opportunities yet.</td></tr>}
        </tbody>
      </table>
      <form className="inline" onSubmit={(e) => { e.preventDefault(); void add.run(() => post('/opportunities', { companyId: company.id, title })); }}>
        <input required placeholder="Use case or system under discussion" value={title} onChange={(e) => setTitle(e.target.value)} />
        <button disabled={add.busy}>Open opportunity</button>
      </form>
      <ErrorBox error={add.error} />
      <p className="muted">Move stages and set values on the <a href="#/pipeline">Pipeline</a>.</p>
    </Section>
  );
}

function InteractionsSection(p: { company: Company; contacts: Contact[]; opportunities: Opportunity[]; items: Interaction[]; onDone: () => void }) {
  const blank = { kind: 'call', direction: '', summary: '', quote: '', contactId: '', opportunityId: '', generated: false };
  const [f, setF] = useState(blank);
  const act = useAction(() => { setF(blank); p.onDone(); });
  const contactName = (id: string | null) => p.contacts.find((c) => c.id === id)?.name;
  const submit = (e: FormEvent) => {
    e.preventDefault();
    void act.run(() =>
      post('/interactions', {
        companyId: p.company.id, kind: f.kind, summary: f.summary, generated: f.generated,
        ...(f.direction && { direction: f.direction }), ...(f.quote && { customerQuote: f.quote }),
        ...(f.contactId && { contactId: f.contactId }), ...(f.opportunityId && { opportunityId: f.opportunityId }),
      }),
    );
  };
  return (
    <Section title={`Interactions (${p.items.length})`}>
      <form className="form" onSubmit={submit}>
        <div className="inline">
          <select value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value })}>
            {['call', 'email', 'meeting', 'note'].map((k) => <option key={k}>{k}</option>)}
          </select>
          <select value={f.direction} onChange={(e) => setF({ ...f, direction: e.target.value })}>
            <option value="">direction —</option><option>inbound</option><option>outbound</option>
          </select>
          <select value={f.contactId} onChange={(e) => setF({ ...f, contactId: e.target.value })}>
            <option value="">contact —</option>
            {p.contacts.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
          <select value={f.opportunityId} onChange={(e) => setF({ ...f, opportunityId: e.target.value })}>
            <option value="">opportunity —</option>
            {p.opportunities.map((o) => <option key={o.id} value={o.id}>{o.title}</option>)}
          </select>
        </div>
        <Field label="Summary"><textarea required rows={2} value={f.summary} onChange={(e) => setF({ ...f, summary: e.target.value })} /></Field>
        <Field label="Customer quote" hint="Their exact words, kept apart from the summary and never overwritten.">
          <textarea rows={2} value={f.quote} onChange={(e) => setF({ ...f, quote: e.target.value })} />
        </Field>
        <label className="check"><input type="checkbox" checked={f.generated} onChange={(e) => setF({ ...f, generated: e.target.checked })} /> This text was AI-generated</label>
        <ErrorBox error={act.error} />
        <button className="primary" disabled={act.busy}>Log interaction</button>
      </form>
      <ul className="rows">
        {[...p.items].reverse().map((i) => (
          <li key={i.id}>
            <div>
              <Badge>{i.kind}{i.direction ? ` · ${i.direction}` : ''}</Badge>{' '}
              {i.generated ? <Badge kind="warn">AI-generated</Badge> : null}{' '}
              <span className="muted">{fmtTime(i.occurred_at)} · <Who id={i.performed_by} />{contactName(i.contact_id) ? ` · with ${contactName(i.contact_id)}` : ''}</span>
              <p>{i.summary}</p>
              {i.customer_quote && <blockquote>“{i.customer_quote}”<footer>customer quote, verbatim</footer></blockquote>}
            </div>
          </li>
        ))}
      </ul>
    </Section>
  );
}

function TimelineSection({ id, version }: { id: string; version: number }) {
  const t = useLoad(() => getAll<TimelineEntry>(`/timeline/company/${id}`), [id, version]);
  return (
    <Section title="Timeline" aside={<a href={`#/audit/company/${id}`}>Full audit trail</a>}>
      <Loading state={t} />
      <ul className="rows">
        {[...(t.data ?? [])].reverse().map((e) => (
          <li key={e.id}><div>{e.type.replace('sales.', '').replace(/-/g, ' ')} <span className="muted">· {fmtTime(e.occurredAt)} · <Actor actor={e.actor} /></span></div></li>
        ))}
      </ul>
    </Section>
  );
}

export type { HistoryEntry };
