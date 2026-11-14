import { useEffect, useRef, useState, type FormEvent } from 'react';
import {
  ApiError, get, getAll, getWithEtag, post, qs, uploadAudio, useLoad,
  type Company, type Meeting, type Opportunity, type Recording, type RecordingLink, type TranscriptRun, type TranscriptSegment,
  type TranscriptSpeaker, type TranscriptionModel, type TranscriptionStatus,
} from '../api';
import { startLive, type Passage } from '../live';
import { Badge, CompanyLink, ErrorBox, Field, Loading, Section, Who, fmtLocal, useAction } from '../ui';

const statusKind = (s: string) => (s === 'held' ? 'won' : s === 'cancelled' ? 'lost' : '');
/** `<input type="datetime-local">` is the reader's local time; the API stores UTC. */
const toIso = (local: string) => new Date(local).toISOString();
const toLocalInput = (iso: string) => {
  const d = new Date(iso);
  d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
  return d.toISOString().slice(0, 16);
};

export function MeetingsView({ id }: { id?: string }) {
  return id ? <MeetingDetail id={id} /> : <MeetingList />;
}

function MeetingList() {
  const [adding, setAdding] = useState(false);
  const q = useLoad(async () => {
    const [meetings, companies] = await Promise.all([getAll<Meeting>('/meetings', 4), getAll<Company>('/companies', 4)]);
    return { meetings, companies, names: new Map(companies.map((c) => [c.id, c.name])) };
  }, []);
  if (!q.data) return <Loading state={q} />;
  const { meetings, companies, names } = q.data;
  const now = new Date().toISOString();
  const upcoming = meetings.filter((m) => m.status === 'scheduled' && m.starts_at >= now).sort((a, b) => a.starts_at.localeCompare(b.starts_at));
  const rest = meetings.filter((m) => !upcoming.includes(m)).sort((a, b) => b.starts_at.localeCompare(a.starts_at));
  const row = (m: Meeting) => (
    <li key={m.id}>
      <div>
        <a href={`#/meetings/${m.id}`}><strong>{m.title}</strong></a> <Badge kind={statusKind(m.status)}>{m.status}</Badge>
        <div className="muted">
          {fmtLocal(m.starts_at)} · {m.duration_min} min · <CompanyLink id={m.company_id} name={names.get(m.company_id)} /> · <Who id={m.owner_id} />
        </div>
      </div>
    </li>
  );
  return (
    <>
      <h1>Meetings</h1>
      <div className="toolbar">
        <button onClick={() => setAdding(!adding)}>{adding ? 'Cancel' : 'Schedule meeting'}</button>
      </div>
      {adding && <ScheduleMeeting companies={companies} onDone={() => { setAdding(false); q.reload(); }} />}
      <Section title={`Upcoming (${upcoming.length})`}>
        {upcoming.length ? <ul className="rows">{upcoming.map(row)}</ul> : <p className="muted">Nothing scheduled.</p>}
      </Section>
      <Section title={`Earlier and cancelled (${rest.length})`}>
        {rest.length ? <ul className="rows">{rest.map(row)}</ul> : <p className="muted">No earlier meetings.</p>}
      </Section>
    </>
  );
}

/** Schedule a meeting. With a `companyId` the company is fixed (the company page); otherwise the person picks one. */
export function ScheduleMeeting({ companies, companyId, onDone }: { companies?: Company[]; companyId?: string; onDone: () => void }) {
  const [f, setF] = useState({ companyId: companyId ?? '', opportunityId: '', title: '', startsAt: '', durationMin: '30', location: '', attendees: '', agenda: '' });
  const opps = useLoad(() => (f.companyId ? getAll<Opportunity>('/opportunities' + qs({ companyId: f.companyId }), 2) : Promise.resolve([])), [f.companyId]);
  const act = useAction(onDone);
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    void act.run(() =>
      post('/meetings', {
        companyId: f.companyId, title: f.title, startsAt: toIso(f.startsAt), durationMin: Number(f.durationMin) || 30,
        ...(f.opportunityId && { opportunityId: f.opportunityId }), ...(f.location && { location: f.location }),
        ...(f.attendees && { attendees: f.attendees }), ...(f.agenda && { agenda: f.agenda }),
      }),
    );
  };
  return (
    <form className="card form" onSubmit={submit}>
      {!companyId && (
        <Field label="Company">
          <select required value={f.companyId} onChange={(e) => setF({ ...f, companyId: e.target.value, opportunityId: '' })}>
            <option value="">Choose…</option>
            {(companies ?? []).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </Field>
      )}
      <Field label="Opportunity (optional)">
        <select value={f.opportunityId} onChange={set('opportunityId')} disabled={!f.companyId}>
          <option value="">None</option>
          {(opps.data ?? []).map((o) => <option key={o.id} value={o.id}>{o.title}</option>)}
        </select>
      </Field>
      <Field label="Title"><input required value={f.title} onChange={set('title')} placeholder="Intro call" /></Field>
      <div className="inline">
        <Field label="Starts"><input required type="datetime-local" value={f.startsAt} onChange={set('startsAt')} /></Field>
        <Field label="Minutes"><input type="number" min={5} max={600} value={f.durationMin} onChange={set('durationMin')} /></Field>
      </div>
      <Field label="Where" hint="A video link or an address."><input value={f.location} onChange={set('location')} /></Field>
      <Field label="Attendees"><input value={f.attendees} onChange={set('attendees')} placeholder="Anna (CTO), Bo" /></Field>
      <Field label="Agenda"><textarea rows={3} value={f.agenda} onChange={set('agenda')} /></Field>
      <ErrorBox error={act.error} />
      <button className="primary" disabled={act.busy}>Schedule</button>
    </form>
  );
}

/** A company's meetings, for its page. */
export function CompanyMeetings({ company, version }: { company: Company; version: number }) {
  const [adding, setAdding] = useState(false);
  const q = useLoad(() => getAll<Meeting>('/meetings' + qs({ companyId: company.id }), 2), [company.id, version]);
  const list = (q.data ?? []).slice().sort((a, b) => b.starts_at.localeCompare(a.starts_at));
  return (
    <Section title={`Meetings (${list.length})`} aside={<button onClick={() => setAdding(!adding)}>{adding ? 'Cancel' : 'Schedule meeting'}</button>}>
      {adding && <ScheduleMeeting companyId={company.id} onDone={() => { setAdding(false); q.reload(); }} />}
      {list.length ? (
        <ul className="rows">
          {list.map((m) => (
            <li key={m.id}>
              <div>
                <a href={`#/meetings/${m.id}`}><strong>{m.title}</strong></a> <Badge kind={statusKind(m.status)}>{m.status}</Badge>
                <div className="muted">{fmtLocal(m.starts_at)} · {m.duration_min} min</div>
              </div>
            </li>
          ))}
        </ul>
      ) : <p className="muted">No meetings yet.</p>}
    </Section>
  );
}

function MeetingDetail({ id }: { id: string }) {
  const d = useLoad(async () => {
    const r = await getWithEtag<Meeting>(`/meetings/${id}`);
    const company = await get<{ company: Company }>(`/companies/${r.data.company_id}`);
    return { meeting: r.data, etag: r.etag, company: company.company };
  }, [id]);
  const status = useAction(d.reload);
  if (!d.data) return <Loading state={d} />;
  const { meeting: m, etag, company } = d.data;
  const setStatus = (to: string) => status.run(() => post(`/meetings/${id}/status`, { meetingId: id, status: to }));
  return (
    <>
      <p><a href="#/meetings">← Meetings</a></p>
      <h1>{m.title} <Badge kind={statusKind(m.status)}>{m.status}</Badge></h1>
      <div className="grid2">
        <Section title="Details">
          <dl>
            <dt>When</dt><dd>{fmtLocal(m.starts_at)} · {m.duration_min} min</dd>
            <dt>Company</dt><dd><CompanyLink id={company.id} name={company.name} /></dd>
            <dt>Where</dt><dd>{m.location ?? '—'}</dd>
            <dt>Attendees</dt><dd>{m.attendees ?? '—'}</dd>
            <dt>Agenda</dt><dd className="pre">{m.agenda ?? '—'}</dd>
            <dt>Owner</dt><dd><Who id={m.owner_id} /></dd>
          </dl>
          <div className="actions">
            {m.status !== 'held' && m.status !== 'cancelled' && <button disabled={status.busy} onClick={() => setStatus('held')}>Mark held</button>}
            {m.status !== 'cancelled' && <button disabled={status.busy} onClick={() => setStatus('cancelled')}>Cancel meeting</button>}
            {m.status === 'cancelled' && <button disabled={status.busy} onClick={() => setStatus('scheduled')}>Schedule again</button>}
          </div>
          <ErrorBox error={status.error} />
        </Section>
        <EditMeeting key={etag ?? ''} meeting={m} etag={etag} onDone={d.reload} />
      </div>
      <RecordingsAndTranscript meeting={m} />
    </>
  );
}

/** Sends the version it read as If-Match: a save over someone else's newer change is refused, not applied. */
function EditMeeting({ meeting: m, etag, onDone }: { meeting: Meeting; etag: string | null; onDone: () => void }) {
  const [f, setF] = useState({ title: m.title, startsAt: toLocalInput(m.starts_at), durationMin: String(m.duration_min), location: m.location ?? '', attendees: m.attendees ?? '', agenda: m.agenda ?? '' });
  const act = useAction(onDone);
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  return (
    <Section title="Edit">
      <form className="form" onSubmit={(e) => {
        e.preventDefault();
        void act.run(() => post(`/meetings/${m.id}/update`, {
          meetingId: m.id, title: f.title, startsAt: toIso(f.startsAt), durationMin: Number(f.durationMin) || m.duration_min,
          ...(f.location && { location: f.location }), ...(f.attendees && { attendees: f.attendees }), ...(f.agenda && { agenda: f.agenda }),
        }, etag));
      }}>
        <Field label="Title"><input required value={f.title} onChange={set('title')} /></Field>
        <div className="inline">
          <Field label="Starts"><input required type="datetime-local" value={f.startsAt} onChange={set('startsAt')} /></Field>
          <Field label="Minutes"><input type="number" min={5} max={600} value={f.durationMin} onChange={set('durationMin')} /></Field>
        </div>
        <Field label="Where"><input value={f.location} onChange={set('location')} /></Field>
        <Field label="Attendees"><input value={f.attendees} onChange={set('attendees')} /></Field>
        <Field label="Agenda"><textarea rows={3} value={f.agenda} onChange={set('agenda')} /></Field>
        <ErrorBox error={act.error} onReload={onDone} />
        <button disabled={act.busy}>Save</button>
      </form>
    </Section>
  );
}

const fmtSize = (bytes: number) => (bytes >= 1_048_576 ? `${(bytes / 1_048_576).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} kB`);
const fmtClock = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;

function RecordingsAndTranscript({ meeting }: { meeting: Meeting }) {
  const [version, setVersion] = useState(0);
  return (
    <>
      <Recordings meeting={meeting} onSaved={() => setVersion((v) => v + 1)} />
      <Transcript meetingId={meeting.id} version={version} />
    </>
  );
}

const fmtOffset = (ms: number) => fmtClock(Math.floor(ms / 1000));

const usd = (n: number) => (n < 0.005 ? 'under 1 cent' : `about $${n.toFixed(2)}`);
const minutesOf = (bytes: number) => Math.max(1, Math.round(bytes / 4000 / 60));
const processorsText = (m: TranscriptionModel | undefined) => (m ? m.processors.join(' and ') : 'a cloud service');
const runName = (r: TranscriptRun, models?: TranscriptionModel[]) =>
  `${models?.find((m) => m.key === r.model)?.label ?? r.model} · ${r.source === 'live' ? 'live' : 'again'} · ${fmtLocal(r.created_at)}${r.is_current ? ' (shown)' : ''}`;

/** The versions of a transcript, the passages of the one picked, who is speaking, and a way to make another version. */
function Transcript({ meetingId, version }: { meetingId: string; version: number }) {
  const [tick, setTick] = useState(0);
  const [picked, setPicked] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [text, setText] = useState('');
  const [renaming, setRenaming] = useState<number | null>(null);
  const [name, setName] = useState('');
  const reload = () => setTick((t) => t + 1);
  const runs = useLoad(() => getAll<TranscriptRun>(`/meetings/${meetingId}/transcript-runs`, 2), [meetingId, version, tick]);
  const status = useLoad(() => get<TranscriptionStatus>('/transcription/models').catch(() => null), []);
  const recordings = useLoad(async () => { try { return await get<Recording[]>(`/meetings/${meetingId}/recordings`); } catch { return [] as Recording[]; } }, [meetingId, version]);
  const done = (runs.data ?? []).filter((r) => r.status === 'done');
  const failed = (runs.data ?? []).filter((r) => r.status === 'failed');
  const shown = picked && done.some((r) => r.id === picked) ? picked : done.find((r) => r.is_current)?.id ?? null;
  const shownRun = done.find((r) => r.id === shown);
  const q = useLoad(() => getAll<TranscriptSegment>(`/meetings/${meetingId}/transcript${shown ? qs({ runId: shown }) : ''}`, 4), [meetingId, version, tick, shown]);
  const speakers = useLoad(() => (shown ? getAll<TranscriptSpeaker>(`/transcript-runs/${shown}/speakers`, 1) : Promise.resolve([] as TranscriptSpeaker[])), [shown, tick]);
  const act = useAction(() => { setEditing(null); setRenaming(null); reload(); });
  if (!q.data || !runs.data) return <Loading state={q.data ? runs : q} />;
  const names = new Map((speakers.data ?? []).map((s) => [s.number, s.name]));
  const label = (n: number) => names.get(n) ?? `Speaker ${n}`;
  const rows = q.data.slice().sort((a, b) => (a.recording_id ?? '').localeCompare(b.recording_id ?? '') || a.seq - b.seq);
  const speakerNumbers = [...new Set(rows.map((r) => r.speaker).filter((n): n is number => n !== null))].sort((a, b) => a - b);
  const models = status.data?.models;
  return (
    <Section title={`Transcript (${rows.length})`}>
      {done.length > 1 && (
        <div className="inline">
          <label>Version{' '}
            <select value={shown ?? ''} onChange={(e) => setPicked(e.target.value)}>
              {done.map((r) => <option key={r.id} value={r.id}>{runName(r, models)}</option>)}
            </select>
          </label>
          {shownRun && !shownRun.is_current && (
            <button disabled={act.busy} onClick={() => void act.run(() => post(`/transcript-runs/${shownRun.id}/current`, { runId: shownRun.id }))}>Show this version by default</button>
          )}
        </div>
      )}
      {speakerNumbers.length > 0 && shown && (
        <p className="speakers">
          {speakerNumbers.map((n) => (
            renaming === n ? (
              <form key={n} className="inline" onSubmit={(e) => { e.preventDefault(); void act.run(() => post(`/transcript-runs/${shown}/speakers`, { runId: shown, number: n, name: name.trim() })); }}>
                <input value={name} maxLength={80} autoFocus onChange={(e) => setName(e.target.value)} aria-label={`Name for speaker ${n}`} />
                <button disabled={act.busy || !name.trim()}>Save</button>
                <button type="button" onClick={() => setRenaming(null)}>Cancel</button>
              </form>
            ) : (
              <button key={n} className="chip" title="Rename this speaker in this version" onClick={() => { setRenaming(n); setName(names.get(n) ?? ''); }}>{label(n)} ✎</button>
            )
          ))}
        </p>
      )}
      {rows.length ? (
        <ul className="rows transcript">
          {rows.map((r) => (
            <li key={r.id}>
              <span className="muted stamp">{fmtOffset(r.start_ms)}</span>
              {editing === r.id ? (
                <form className="form grow" onSubmit={(e) => { e.preventDefault(); void act.run(() => post(`/transcript/${r.id}/update`, { segmentId: r.id, text })); }}>
                  <textarea rows={2} value={text} onChange={(e) => setText(e.target.value)} autoFocus />
                  <div className="actions"><button disabled={act.busy || !text.trim()}>Save</button><button type="button" onClick={() => setEditing(null)}>Cancel</button></div>
                </form>
              ) : (
                <>
                  <span className="grow">{r.speaker !== null && <strong>{label(r.speaker)}: </strong>}{r.text}{r.corrected_at ? <> <Badge>corrected</Badge></> : null}</span>
                  <button onClick={() => { setEditing(r.id); setText(r.text); }}>Edit</button>
                </>
              )}
            </li>
          ))}
        </ul>
      ) : <p className="muted">No transcript. Tick “transcribe” when recording, or transcribe a recording below.</p>}
      {failed.length > 0 && (
        <ul className="muted notes-list">
          {failed.map((r) => <li key={r.id}>{models?.find((m) => m.key === r.model)?.label ?? r.model} did not finish ({fmtLocal(r.created_at)}): {r.failure ?? 'it failed'}</li>)}
        </ul>
      )}
      <ErrorBox error={act.error} />
      {status.data && recordings.data && recordings.data.length > 0 && (
        <TranscribeAgain
          meetingId={meetingId}
          status={status.data}
          recordings={recordings.data}
          used={(runs.data ?? []).length}
          onDone={(id) => { setPicked(id); reload(); }}
          onReload={reload}
        />
      )}
    </Section>
  );
}

const MAX_RUNS = 5;

/** Transcribe a stored recording again with a model the person picks. The price and who handles the audio are shown first. */
function TranscribeAgain({ meetingId, status, recordings, used, onDone, onReload }: { meetingId: string; status: TranscriptionStatus; recordings: Recording[]; used: number; onDone: (runId: string) => void; onReload: () => void }) {
  const [open, setOpen] = useState(false);
  const [recordingId, setRecordingId] = useState(recordings[0]!.id);
  const [modelKey, setModelKey] = useState(status.models[0]!.key);
  const [language, setLanguage] = useState('sv');
  const [diarize, setDiarize] = useState(false);
  const [consent, setConsent] = useState(false);
  const act = useAction();
  const model = status.models.find((m) => m.key === modelKey)!;
  const recording = recordings.find((r) => r.id === recordingId) ?? recordings[0]!;
  const tooLong = recording.size > model.maxBytes;
  const minutes = minutesOf(recording.size);
  if (!open) {
    return <div className="actions"><button onClick={() => setOpen(true)} disabled={!status.available}>Transcribe again…</button>{!status.available && <span className="muted"> {status.reason}</span>}</div>;
  }
  const run = () => act.run(async () => {
    let created: TranscriptRun;
    try {
      created = await post<TranscriptRun>(`/meetings/${meetingId}/transcribe-again`, { recordingId, model: modelKey, language, ...(diarize && model.speakers ? { diarize: true } : {}), consent });
    } catch (e) {
      // A run that failed is still a run: it counts toward the limit and is listed, so the page reads it again.
      onReload();
      throw e;
    }
    setOpen(false);
    setConsent(false);
    onDone(created.id);
  });
  return (
    <form className="form again" onSubmit={(e) => { e.preventDefault(); void run(); }}>
      <h3>Transcribe again</h3>
      {recordings.length > 1 && (
        <Field label="Recording">
          <select value={recordingId} onChange={(e) => setRecordingId(e.target.value)}>
            {recordings.map((r) => <option key={r.id} value={r.id}>{fmtLocal(r.createdAt)} · about {minutesOf(r.size)} min</option>)}
          </select>
        </Field>
      )}
      <Field label="Model">
        <select value={modelKey} onChange={(e) => { setModelKey(e.target.value); setDiarize(false); }}>
          {status.models.map((m) => <option key={m.key} value={m.key}>{m.label}</option>)}
        </select>
      </Field>
      <p className="muted">{model.description} Audio is handled by {processorsText(model)}.</p>
      <Field label="Language">
        <select value={language} onChange={(e) => setLanguage(e.target.value)}>
          <option value="sv">Swedish</option>
          <option value="en">English</option>
        </select>
      </Field>
      {model.speakers && <label className="check"><input type="checkbox" checked={diarize} onChange={(e) => setDiarize(e.target.checked)} /> Label who is speaking</label>}
      <p className="muted">About {minutes} min of audio · {usd(minutes * model.usdPerMinute)} · {used} of {MAX_RUNS} transcripts used for this meeting’s recordings</p>
      {tooLong && <p className="note">{model.label} takes recordings up to about {minutesOf(model.maxBytes)} minutes; this one is about {minutes}. Pick another model.</p>}
      <label className="check"><input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} /> Everyone on this recording has agreed to it being transcribed by {processorsText(model)}</label>
      <div className="actions">
        <button className="primary" disabled={act.busy || !consent || tooLong}>{act.busy ? 'Transcribing… this can take a minute' : 'Transcribe'}</button>
        <button type="button" disabled={act.busy} onClick={() => setOpen(false)}>Cancel</button>
      </div>
      <ErrorBox error={act.error} />
    </form>
  );
}

function Recordings({ meeting, onSaved }: { meeting: Meeting; onSaved: () => void }) {
  const q = useLoad(async (): Promise<Recording[] | 'unavailable'> => {
    try {
      return await get<Recording[]>(`/meetings/${meeting.id}/recordings`);
    } catch (e) {
      if (e instanceof ApiError && e.status === 503) return 'unavailable';
      throw e;
    }
  }, [meeting.id]);
  const del = useAction(q.reload);
  if (!q.data) return <Loading state={q} />;
  if (q.data === 'unavailable') {
    return <Section title="Recordings"><p className="muted">Recording is not available on this deployment yet.</p></Section>;
  }
  return (
    <Section title={`Recordings (${q.data.length})`}>
      {q.data.length ? (
        <ul className="rows">
          {q.data.map((r) => (
            <li key={r.id}>
              <div>
                <audio controls preload="none" src={`/api/recordings/${r.id}`} />
                <div className="muted">{fmtLocal(r.createdAt)} · {fmtSize(r.size)} · recorded by <Who id={r.createdBy} /></div>
              </div>
              <button disabled={del.busy} onClick={() => { if (window.confirm('Delete this recording? This cannot be undone.')) void del.run(async () => { const res = await fetch(`/api/recordings/${r.id}`, { method: 'DELETE', credentials: 'same-origin' }); if (!res.ok) throw new ApiError(res.status, 'The recording could not be deleted.'); }); }}>Delete</button>
            </li>
          ))}
        </ul>
      ) : <p className="muted">Nothing recorded yet.</p>}
      <ErrorBox error={del.error} />
      {meeting.status !== 'cancelled' && <Recorder meetingId={meeting.id} onSaved={() => { q.reload(); onSaved(); }} />}
    </Section>
  );
}

type Phase = 'idle' | 'recording' | 'saving';

/**
 * Records this computer's microphone and uploads it when stopped. Recording cannot start until the person confirms
 * everyone agreed; that confirmation is what `sales/start-recording` stores before it hands out the upload link.
 */
function Recorder({ meetingId, onSaved }: { meetingId: string; onSaved: () => void }) {
  const [consent, setConsent] = useState(false);
  const [phase, setPhase] = useState<Phase>('idle');
  const [seconds, setSeconds] = useState(0);
  const [error, setError] = useState<Error | null>(null);
  const [language, setLanguage] = useState('sv');
  const [transcribe, setTranscribe] = useState(true);
  const [model, setModel] = useState('whisper');
  const [passages, setPassages] = useState<Passage[]>([]);
  const [notice, setNotice] = useState<string | null>(null);
  const rec = useRef<{ recorder: MediaRecorder; stream: MediaStream; chunks: Blob[]; bytes: number; link: RecordingLink; live: { stop: () => Promise<Passage[]> } | null } | null>(null);
  // Whether this host can make a transcript, so it is offered only where one can be made.
  const status = useLoad(() => get<TranscriptionStatus>('/transcription/status').catch(() => ({ available: false, models: [] as TranscriptionModel[] }) as TranscriptionStatus), []);
  const liveModels = (status.data?.models ?? []).filter((m) => m.live);
  const chosen = liveModels.find((m) => m.key === model) ?? liveModels[0];
  const canTranscribe = !!status.data?.available;
  const wantTranscript = canTranscribe && transcribe;
  const supported = typeof MediaRecorder !== 'undefined' && !!navigator.mediaDevices?.getUserMedia;

  useEffect(() => {
    if (phase !== 'recording') return;
    const t = window.setInterval(() => setSeconds((s) => s + 1), 1000);
    return () => window.clearInterval(t);
  }, [phase]);
  // Leaving the page must not leave the microphone on.
  useEffect(() => () => { rec.current?.stream.getTracks().forEach((t) => t.stop()); }, []);

  const start = async () => {
    setError(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      // Speech needs little: 32 kbit/s keeps an hour near 15 MB, well inside the upload limit.
      const mimeType = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus'].find((t) => MediaRecorder.isTypeSupported(t));
      let link: RecordingLink;
      try {
        link = await post<RecordingLink>(`/meetings/${meetingId}/recordings`, { meetingId, consent: true });
      } catch (e) {
        stream.getTracks().forEach((t) => t.stop());
        throw e;
      }
      const recorder = new MediaRecorder(stream, { audioBitsPerSecond: 32000, ...(mimeType ? { mimeType } : {}) });
      let live: { stop: () => Promise<Passage[]> } | null = null;
      setPassages([]);
      setNotice(null);
      if (wantTranscript) {
        try {
          live = await startLive(stream, { meetingId, language, model: chosen?.key ?? 'whisper', onPassages: setPassages, onError: (e) => setNotice(`Part of the transcript is missing: ${e.message}`) });
        } catch {
          setNotice('Live text could not start in this browser. The meeting is still being recorded.');
        }
      }
      const state = { recorder, stream, chunks: [] as Blob[], bytes: 0, link, live };
      rec.current = state;
      recorder.ondataavailable = (ev) => {
        if (!ev.data.size) return;
        state.chunks.push(ev.data);
        state.bytes += ev.data.size;
        // Stop just before the upload limit rather than lose the whole recording to a refusal.
        if (state.bytes > state.link.maxBytes * 0.95 && recorder.state === 'recording') recorder.stop();
      };
      recorder.onstop = () => void finish(state);
      recorder.start(5000);
      setSeconds(0);
      setPhase('recording');
    } catch (e) {
      setError(e instanceof DOMException && e.name === 'NotAllowedError' ? new Error('The browser was not allowed to use the microphone.') : (e as Error));
    }
  };

  const finish = async (state: NonNullable<typeof rec.current>) => {
    state.stream.getTracks().forEach((t) => t.stop());
    setPhase('saving');
    let recordingId: string | undefined;
    try {
      const type = state.recorder.mimeType || 'audio/webm';
      const ext = type.includes('mp4') ? 'm4a' : type.includes('ogg') ? 'ogg' : 'webm';
      recordingId = (await uploadAudio(state.link.url, new Blob(state.chunks, { type }), `meeting-${meetingId}.${ext}`)).id;
      setConsent(false);
    } catch (e) {
      setError(e as Error);
    }
    try {
      // The transcript is kept even if the audio could not be (it is still what was said).
      const spoken = (await state.live?.stop()) ?? [];
      if (spoken.length) {
        await post(`/meetings/${meetingId}/transcript`, { meetingId, ...(recordingId && { recordingId }), language, model: chosen?.key ?? 'whisper', segments: spoken });
      }
      onSaved();
    } catch (e) {
      setError(e as Error);
    } finally {
      rec.current = null;
      setPhase('idle');
    }
  };

  if (!supported) return <p className="muted">This browser cannot record audio.</p>;
  return (
    <div className="recorder">
      <h3>Record this meeting</h3>
      {phase === 'idle' && (
        <>
          {canTranscribe && (
            <div className="inline">
              <label className="check"><input type="checkbox" checked={transcribe} onChange={(e) => setTranscribe(e.target.checked)} /> Transcribe</label>
              <select aria-label="Language" value={language} disabled={!transcribe} onChange={(e) => setLanguage(e.target.value)}>
                <option value="sv">Swedish</option>
                <option value="en">English</option>
              </select>
              <select aria-label="Model" value={chosen?.key ?? ''} disabled={!transcribe} onChange={(e) => setModel(e.target.value)}>
                {liveModels.map((m) => <option key={m.key} value={m.key}>{m.label}</option>)}
              </select>
            </div>
          )}
          {canTranscribe && transcribe && chosen && <p className="muted ask-note">{chosen.description} Speaker labels come from “Transcribe again” after the recording.</p>}
          <label className="check">
            <input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} />
            {wantTranscript
              ? `Everyone on this call has agreed to be recorded and transcribed by ${processorsText(chosen)}`
              : 'Everyone on this call has agreed to be recorded'}
          </label>
          {status.data && !canTranscribe && (
            <p className="muted ask-note">{(status.data as { reason?: string }).reason ?? 'Transcription is not available here.'}</p>
          )}
          <p className="muted ask-note">Records this computer’s microphone. To capture a video call, share that call’s browser tab with sound.</p>
          <button className="primary" disabled={!consent} onClick={() => void start()}>● Record</button>
        </>
      )}
      {phase === 'recording' && (
        <div className="inline">
          <span className="rec-dot" aria-hidden /> <strong>Recording {fmtClock(seconds)}</strong>
          <button onClick={() => rec.current?.recorder.stop()}>■ Stop and save</button>
        </div>
      )}
      {phase !== 'idle' && wantTranscript && (
        <div className="live" aria-live="polite">
          {passages.length ? passages.slice(-6).map((p, i) => <p key={i}><span className="muted stamp">{fmtOffset(p.startMs)}</span> {p.text}</p>) : <p className="muted">Text appears here a few seconds behind the speakers.</p>}
        </div>
      )}
      {notice && <p className="note">{notice}</p>}
      {phase === 'saving' && <p className="muted">Saving the recording…</p>}
      <ErrorBox error={error} />
    </div>
  );
}
