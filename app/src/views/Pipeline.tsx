import { useCallback, useState, type FormEvent } from 'react';
import { Board, type KanbanMove } from '../elements';
import { getAll, getWithEtag, post, stageLabel, useLoad, STAGES, type Company, type Opportunity } from '../api';
import { ErrorBox, Field, Loading, fmtDate, money, useAction, useMemberNames } from '../ui';

const FORWARD = STAGES.filter((s) => s !== 'lost');

const COLUMNS = STAGES.map((s) => ({ key: s, label: stageLabel(s) }));
const isOpen = (stage: string) => stage !== 'won' && stage !== 'lost';

export function Pipeline() {
  const q = useLoad(async () => {
    const [opps, companies] = await Promise.all([getAll<Opportunity>('/opportunities', 10), getAll<Company>('/companies', 10)]);
    return { opps, companies, names: new Map(companies.map((c) => [c.id, c.name])) };
  }, []);
  const members = useMemberNames();
  const [adding, setAdding] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [asking, setAsking] = useState<{ resolve: (reason: string) => void; reject: () => void } | null>(null);
  const names = q.data?.names;
  // Stable identities: the board starts over when these change.
  const mount = useCallback((el: HTMLElement, o: Opportunity) => {
    const draw = (o: Opportunity) => {
      el.replaceChildren();
      const line = (text: string, cls = '') => { const d = document.createElement('div'); d.textContent = text; if (cls) d.className = cls; el.append(d); return d; };
      line(o.title).style.fontWeight = '600';
      const a = document.createElement('a'); a.href = `#/companies/${o.company_id}`; a.textContent = names?.get(o.company_id) ?? 'company';
      const c = document.createElement('div'); c.className = 'muted'; c.append(a); el.append(c);
      line(money(o));
      line(`${o.owner_id ? members.get(o.owner_id) ?? 'someone' : 'unassigned'} · target ${fmtDate(o.target_date)}`, 'muted');
      if (!o.next_step && isOpen(o.stage)) line('no next step', 'badge warn');
      else if (o.next_step) line(`Next: ${o.next_step}`);
      if (o.lost_reason) line(`Lost: ${o.lost_reason}`, 'muted');
    };
    draw(o);
    return { update: draw };
  }, [names, members]);
  const canDrag = useCallback((o: Opportunity) => isOpen(o.stage), []);
  // One step forward, or lost from any open stage. A reorder inside a column is never refused by the board.
  const canDrop = useCallback((o: Opportunity, from: string, to: string) => {
    if (!isOpen(from)) return false;
    if (to === 'lost') return true;
    const i = FORWARD.indexOf(from as (typeof FORWARD)[number]);
    return FORWARD[i + 1] === to;
  }, []);
  const move = useCallback(async (m: KanbanMove<Opportunity>) => {
    setFailure(null);
    if (m.from === m.to) return; // The order inside a column is not stored.
    const o = m.card;
    if (m.to === 'lost') {
      const reason = await new Promise<string>((resolve, reject) => setAsking({ resolve, reject }));
      await post(`/opportunities/${o.id}/move`, { opportunityId: o.id, stage: 'lost', lostReason: reason });
    } else {
      await post(`/opportunities/${o.id}/move`, { opportunityId: o.id, stage: m.to });
    }
    q.reload();
  }, [q.reload]);
  const keyOf = useCallback((o: Opportunity) => o.id, []);
  const columnOf = useCallback((o: Opportunity) => o.stage, []);
  const labelOf = useCallback((o: Opportunity) => o.title, []);
  const onFailed = useCallback((e: unknown) => {
    // A cancelled reason is not an error; the card just goes back.
    if (e === undefined) return;
    setFailure(e instanceof Error ? e.message : 'The move was refused.');
  }, []);
  if (!q.data) return <Loading state={q} />;
  const { opps, companies } = q.data;
  const current = opps.find((o) => o.id === selected);
  return (
    <>
      <h1>Pipeline</h1>
      <div className="toolbar">
        <button onClick={() => setAdding(!adding)}>{adding ? 'Cancel' : 'New opportunity'}</button>
      </div>
      {adding && <NewOpportunity companies={companies.filter((c) => !c.merged_into)} onDone={() => { setAdding(false); q.reload(); }} />}
      {failure && <div className="note error" role="alert">{failure}</div>}
      <div className="kanban-frame">
        <Board<Opportunity>
          label="Pipeline" columns={COLUMNS} cards={opps} keyOf={keyOf} columnOf={columnOf} labelOf={labelOf}
          mount={mount} canDrag={canDrag} canDrop={canDrop} move={move} onOpen={(o) => setSelected(o.id)} onFailed={onFailed}
        />
      </div>
      <p className="muted">Drag a card one stage forward, or onto Lost (it asks why). Tab to a card and press Space to move it with the keyboard. Click a card to edit it.</p>
      {current && <Detail key={current.id} o={current} onClose={() => setSelected(null)} onDone={q.reload} />}
      {asking && (
        <LostReason onSubmit={(r) => { asking.resolve(r); setAsking(null); }} onCancel={() => { asking.reject(); setAsking(null); }} />
      )}
    </>
  );
}

function LostReason({ onSubmit, onCancel }: { onSubmit: (reason: string) => void; onCancel: () => void }) {
  const [reason, setReason] = useState('');
  return (
    <div className="modal" role="dialog" aria-modal="true" aria-label="Why was it lost?">
      <form className="card form" onSubmit={(e) => { e.preventDefault(); onSubmit(reason); }}>
        <Field label="Why was it lost?"><input required autoFocus value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
        <div className="actions"><button className="primary">Mark lost</button><button type="button" onClick={onCancel}>Cancel</button></div>
      </form>
    </div>
  );
}

function Detail({ o, onClose, onDone }: { o: Opportunity; onClose: () => void; onDone: () => void }) {
  const act = useAction(onDone);
  const idx = FORWARD.indexOf(o.stage as (typeof FORWARD)[number]);
  const next = isOpen(o.stage) ? FORWARD[idx + 1] : undefined;
  return (
    <section className="card">
      <h2>{o.title}</h2>
      <ErrorBox error={act.error} />
      <div className="actions">
        {next && <button disabled={act.busy} onClick={() => act.run(() => post(`/opportunities/${o.id}/move`, { opportunityId: o.id, stage: next }))}>→ {stageLabel(next)}</button>}
        <button onClick={onClose}>Close</button>
      </div>
      {isOpen(o.stage) ? <EditOpp o={o} onDone={() => { onDone(); }} /> : <p className="muted">{o.stage === 'won' ? 'Won' : 'Lost'}: closed opportunities are not edited.</p>}
    </section>
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
