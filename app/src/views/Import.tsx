import { useMemo, useState } from 'react';
import { getAll, post, qs, readPage, useLoad, type Batch, type Duplicate, type Exclusion, type ImportRow } from '../api';
import { EntityTable, type ColumnSpec, type TableSource } from '../elements';
import { Badge, CompanyLink, ErrorBox, Field, Loading, Section, Who, fmtDate, useAction, useCan } from '../ui';

const TEMPLATE = 'company,domain,segment,source,contact_name,contact_email,contact_role,contact_phone,notes\n';

export function ImportView() {
  const [batch, setBatch] = useState<Batch | null>(null);
  const dups = useLoad(() => getAll<Duplicate>('/duplicates' + qs({ status: 'open' })), []);
  return (
    <>
      <h1>Import</h1>
      <Upload onImported={(b) => { setBatch(b); dups.reload(); }} />
      {batch && <BatchResult batch={batch} />}
      <Duplicates state={dups} />
      <p className="muted">Companies and domains we must not contact are kept under <a href="#/exclusions">Do not contact</a>; an import skips them.</p>
    </>
  );
}

function Upload({ onImported }: { onImported: (b: Batch) => void }) {
  const [csv, setCsv] = useState('');
  const [filename, setFilename] = useState('pasted.csv');
  const act = useAction();
  const pick = async (file: File | undefined) => {
    if (!file) return;
    setFilename(file.name);
    setCsv(await file.text());
  };
  return (
    <Section title="Upload a CSV" aside={<a href={`data:text/csv;charset=utf-8,${encodeURIComponent(TEMPLATE)}`} download="sales-os-template.csv">Download template</a>}>
      <p className="muted">
        Columns: <code>company</code> (required), <code>domain</code>, <code>segment</code>, <code>source</code>, <code>contact_name</code>,{' '}
        <code>contact_email</code>, <code>contact_role</code>, <code>contact_phone</code>, <code>notes</code>. Rows are matched, never silently merged;
        anything unclear is flagged for you.
      </p>
      <input type="file" accept=".csv,text/csv" onChange={(e) => void pick(e.target.files?.[0])} />
      <Field label="…or paste it here"><textarea rows={5} value={csv} onChange={(e) => setCsv(e.target.value)} /></Field>
      <ErrorBox error={act.error} />
      <button className="primary" disabled={act.busy || !csv.trim()} onClick={() => act.run(async () => { onImported(await post<Batch>('/imports', { filename, csv })); setCsv(''); })}>
        Import
      </button>
    </Section>
  );
}

function BatchResult({ batch }: { batch: Batch }) {
  // One paged read of this batch's rows; the outcome filter is the read's own `outcome` parameter.
  const source = useMemo<TableSource<ImportRow>>(
    () => ({
      read: (q) => readPage<ImportRow>(`/imports/${batch.id}/rows` + qs({ outcome: q.filters.outcome, limit: q.limit })),
      follow: (next) => readPage<ImportRow>(next),
    }),
    [batch.id],
  );
  const columns = useMemo<ColumnSpec<ImportRow>[]>(
    () => [
      { key: 'row_number', label: '#', kind: 'number', align: 'end' },
      {
        key: 'raw',
        label: 'As uploaded',
        value: (r) => {
          const raw = JSON.parse(r.raw) as Record<string, string>;
          return [raw.company || '(no company)', raw.domain, raw.contact_email].filter(Boolean).join(' · ');
        },
      },
      { key: 'outcome', label: 'Outcome', kind: 'badge', tones: { created: 'success', matched: 'neutral', flagged: 'warning' } },
      { key: 'note', label: 'Why', value: (r) => r.note ?? '', priority: 2 },
    ],
    [],
  );
  const filters = useMemo(
    () => [{ key: 'outcome', label: 'Outcome', options: ['created', 'matched', 'flagged'].map((v) => ({ value: v, label: v })) }],
    [],
  );
  return (
    <Section title={`Imported ${batch.filename}`} aside={<span className="muted">{batch.row_count} rows</span>}>
      <p>
        <Badge kind="won">{batch.created_count} created</Badge> <Badge>{batch.matched_count} matched</Badge> <Badge kind="warn">{batch.flagged_count} flagged</Badge>
      </p>
      <EntityTable label={`Rows of ${batch.filename}`} source={source} columns={columns} filters={filters} />
    </Section>
  );
}

function Duplicates({ state }: { state: ReturnType<typeof useLoad<Duplicate[]>> }) {
  const act = useAction(state.reload);
  const list = state.data ?? [];
  return (
    <Section title={`Possible duplicates (${list.length})`}>
      <Loading state={state} />
      <ErrorBox error={act.error} />
      {!state.loading && !list.length && <p className="muted">Nothing to review.</p>}
      <ul className="rows">
        {list.map((d) => (
          <li key={d.id}>
            <div>
              <CompanyLink id={d.left_id} /> <span className="muted">and</span> <CompanyLink id={d.right_id} />
              <div className="muted">{d.reason}</div>
            </div>
            <div className="actions">
              <button disabled={act.busy} onClick={() => act.run(() => post(`/duplicates/${d.id}/resolve`, { duplicateId: d.id, decision: 'keep_both' }))}>Keep both</button>
              <button disabled={act.busy} onClick={() => act.run(() => post(`/duplicates/${d.id}/resolve`, { duplicateId: d.id, decision: 'merge', survivorId: d.left_id }))}>Merge into the first</button>
              <button disabled={act.busy} onClick={() => act.run(() => post(`/duplicates/${d.id}/resolve`, { duplicateId: d.id, decision: 'merge', survivorId: d.right_id }))}>Merge into the second</button>
            </div>
          </li>
        ))}
      </ul>
      <p className="muted">A merge moves contacts, opportunities, interactions and tasks to the one you keep. Nothing is deleted; the other record stays on file.</p>
    </Section>
  );
}

export function Exclusions() {
  const canLift = useCan('exclusion:lift');
  const q = useLoad(() => getAll<Exclusion>('/exclusions'), []);
  const [f, setF] = useState({ kind: 'domain', value: '', reason: '' });
  const add = useAction(() => { setF({ ...f, value: '', reason: '' }); q.reload(); });
  const lift = useAction(q.reload);
  return (
    <Section title="Do not contact">
      <Loading state={q} />
      <ul className="rows">
        {(q.data ?? []).map((x) => (
          <li key={x.id}>
            <div><strong>{x.value}</strong> <Badge>{x.kind}</Badge><div className="muted">{x.reason} · added <Who id={x.created_by} /> {fmtDate(x.created_at)}</div></div>
            {canLift && <button disabled={lift.busy} onClick={() => lift.run(() => post(`/exclusions/${x.id}/lift`, { exclusionId: x.id }))}>Lift</button>}
          </li>
        ))}
      </ul>
      <ErrorBox error={lift.error} />
      <form className="inline" onSubmit={(e) => { e.preventDefault(); void add.run(() => post('/exclusions', f)); }}>
        <select value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value })}><option>domain</option><option>company</option></select>
        <input required placeholder={f.kind === 'domain' ? 'example.com' : 'Company name'} value={f.value} onChange={(e) => setF({ ...f, value: e.target.value })} />
        <input required placeholder="Reason" value={f.reason} onChange={(e) => setF({ ...f, reason: e.target.value })} />
        <button disabled={add.busy}>Add</button>
      </form>
      <ErrorBox error={add.error} />
    </Section>
  );
}
