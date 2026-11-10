import { useState, type FormEvent } from 'react';
import { getAll, getWithEtag, post, stageLabel, useLoad, STAGES, type Company, type Opportunity } from '../api';
import { Badge, CompanyLink, ErrorBox, Field, Loading, Who, fmtDate, money, useAction } from '../ui';

const FORWARD = STAGES.filter((s) => s !== 'lost');

export function Pipeline() {
  const q = useLoad(async () => {
    const [opps, companies] = await Promise.all([getAll<Opportunity>('/opportunities', 10), getAll<Company>('/companies', 10)]);
    return { opps, companies, names: new Map(companies.map((c) => [c.id, c.name])) };
  }, []);
  const [adding, setAdding] = useState(false);
  if (!q.data) return <Loading state={q} />;
  const { opps, companies, names } = q.data;
  return (
    <>
      <h1>Pipeline</h1>
      <div className="toolbar">
        <button onClick={() => setAdding(!adding)}>{adding ? 'Cancel' : 'New opportunity'}</button>
      </div>
      {adding && <NewOpportunity companies={companies.filter((c) => !c.merged_into)} onDone={() => { setAdding(false); q.reload(); }} />}
      <div className="board">
        {STAGES.map((stage) => {
          const cards = opps.filter((o) => o.stage === stage);
          return (
            <div className="column" key={stage}>
              <h3>{stageLabel(stage)} <span className="muted">{cards.length}</span></h3>
              {cards.map((o) => <Card key={o.id} o={o} name={names.get(o.company_id)} onDone={q.reload} />)}
            </div>
          );
        })}
      </div>
      <p className="muted">A stage moves one step at a time. An opportunity can be marked lost from any open stage, with a reason.</p>
    </>
  );
}

function NewOpportunity({ companies, onDone }: { companies: Company[]; onDone: () => void }) {
  const [f, setF] = useState({ companyId: '', title: '', valueLow: '', valueHigh: '', nextStep: '', targetDate: '' });
  const act = useAction(onDone);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    void act.run(() => post('/opportunities', {
      companyId: f.companyId, title: f.title,
      ...(f.valueLow && { valueLow: f.valueLow }), ...(f.valueHigh && { valueHigh: f.valueHigh }),
      ...(f.nextStep && { nextStep: f.nextStep }), ...(f.targetDate && { targetDate: f.targetDate }),
    }));
  };
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  return (
    <form className="card form" onSubmit={submit}>
      <Field label="Company">
        <select required value={f.companyId} onChange={set('companyId')}>
          <option value="">choose…</option>
          {companies.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
      </Field>
      <Field label="Use case or system under discussion"><input required value={f.title} onChange={set('title')} /></Field>
      <div className="inline">
        <input inputMode="decimal" pattern="\d+(\.\d+)?" placeholder="Value from" value={f.valueLow} onChange={set('valueLow')} />
        <input inputMode="decimal" pattern="\d+(\.\d+)?" placeholder="Value to" value={f.valueHigh} onChange={set('valueHigh')} />
        <input type="date" value={f.targetDate} onChange={set('targetDate')} />
      </div>
      <Field label="Next step"><input value={f.nextStep} onChange={set('nextStep')} /></Field>
      <ErrorBox error={act.error} />
      <button className="primary" disabled={act.busy}>Open opportunity</button>
    </form>
  );
}

function Card({ o, name, onDone }: { o: Opportunity; name: string | undefined; onDone: () => void }) {
  const [open, setOpen] = useState(false);
  const [lost, setLost] = useState<string | null>(null);
  const act = useAction(() => { setLost(null); onDone(); });
  const idx = FORWARD.indexOf(o.stage as (typeof FORWARD)[number]);
  const next = o.stage === 'won' || o.stage === 'lost' ? undefined : FORWARD[idx + 1];
  return (
    <article className="opp">
      <strong>{o.title}</strong>
      <div className="muted"><CompanyLink id={o.company_id} name={name} /></div>
      <div>{money(o)}</div>
      <div className="muted"><Who id={o.owner_id} /> · target {fmtDate(o.target_date)}</div>
      <div>{o.next_step ? <>Next: {o.next_step}</> : <Badge kind="warn">no next step</Badge>}</div>
      {o.lost_reason && <div className="muted">Lost: {o.lost_reason}</div>}
      <ErrorBox error={act.error} />
      {next && (
        <div className="actions">
          <button disabled={act.busy} onClick={() => act.run(() => post(`/opportunities/${o.id}/move`, { opportunityId: o.id, stage: next }))}>→ {stageLabel(next)}</button>
          <button disabled={act.busy} onClick={() => setLost(lost === null ? '' : null)}>Lost…</button>
          <button onClick={() => setOpen(!open)}>Edit</button>
        </div>
      )}
      {lost !== null && (
        <form className="inline" onSubmit={(e) => { e.preventDefault(); void act.run(() => post(`/opportunities/${o.id}/move`, { opportunityId: o.id, stage: 'lost', lostReason: lost })); }}>
          <input required autoFocus placeholder="Why was it lost?" value={lost} onChange={(e) => setLost(e.target.value)} />
          <button disabled={act.busy}>Mark lost</button>
        </form>
      )}
      {open && <EditOpp o={o} onDone={() => { setOpen(false); onDone(); }} />}
    </article>
  );
}

/** Edits the CURRENT row: it is read fresh when the form opens, and its version rides back as If-Match. */
function EditOpp({ o, onDone }: { o: Opportunity; onDone: () => void }) {
  const cur = useLoad(() => getWithEtag<Opportunity>(`/opportunities/${o.id}`), [o.id]);
  if (!cur.data) return <Loading state={cur} />;
  return <EditOppForm key={cur.data.etag ?? ''} row={cur.data.data} etag={cur.data.etag} onDone={onDone} onReload={cur.reload} />;
}

function EditOppForm({ row: o, etag, onDone, onReload }: { row: Opportunity; etag: string | null; onDone: () => void; onReload: () => void }) {
  const [f, setF] = useState({ valueLow: o.value_low ?? '', valueHigh: o.value_high ?? '', nextStep: o.next_step ?? '', targetDate: o.target_date ?? '' });
  const act = useAction(onDone);
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  return (
    <form className="form" onSubmit={(e) => {
      e.preventDefault();
      void act.run(() => post(`/opportunities/${o.id}/update`, {
        opportunityId: o.id,
        ...(f.valueLow && { valueLow: f.valueLow }), ...(f.valueHigh && { valueHigh: f.valueHigh }),
        ...(f.nextStep && { nextStep: f.nextStep }), ...(f.targetDate && { targetDate: f.targetDate }),
      }, etag));
    }}>
      <div className="inline">
        <input inputMode="decimal" pattern="\d+(\.\d+)?" placeholder="Value from" value={f.valueLow} onChange={set('valueLow')} />
        <input inputMode="decimal" pattern="\d+(\.\d+)?" placeholder="Value to" value={f.valueHigh} onChange={set('valueHigh')} />
      </div>
      <input placeholder="Next step" value={f.nextStep} onChange={set('nextStep')} />
      <input type="date" value={f.targetDate} onChange={set('targetDate')} />
      <ErrorBox error={act.error} onReload={onReload} />
      <button disabled={act.busy}>Save</button>
    </form>
  );
}
