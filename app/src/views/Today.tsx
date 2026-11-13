import { get, getAll, post, qs, useLoad, stageLabel, type Company, type Meeting, type Opportunity, type Task, type TodayData } from '../api';
import { Badge, CompanyLink, ErrorBox, Loading, Section, Who, fmtDate, fmtLocal, useAction } from '../ui';

/** The daily work queue: what is overdue, what is due, what has stalled, what has no next step. */
export function Today() {
  const q = useLoad(async () => {
    const from = new Date().toISOString();
    const to = new Date(Date.now() + 7 * 86_400_000).toISOString();
    const [today, companies, opps, meetings] = await Promise.all([
      get<TodayData>('/today'),
      getAll<Company>('/companies', 4),
      getAll<Opportunity>('/opportunities', 4),
      getAll<Meeting>('/meetings' + qs({ from, to }), 2),
    ]);
    return { today, names: new Map(companies.map((c) => [c.id, c.name])), opps: new Map(opps.map((o) => [o.id, o])),
      meetings: meetings.filter((m) => m.status === 'scheduled').sort((a, b) => a.starts_at.localeCompare(b.starts_at)) };
  }, []);
  const done = useAction(q.reload);
  if (!q.data) return <Loading state={q} />;
  const { today, names, opps, meetings } = q.data;

  const taskRow = (t: Task) => {
    const opp = t.opportunity_id ? opps.get(t.opportunity_id) : undefined;
    const companyId = t.company_id ?? opp?.company_id ?? null;
    return (
      <li key={t.id}>
        <div>
          <strong>{t.title}</strong>
          <div className="muted">
            due {fmtDate(t.due_date)} · <Who id={t.owner_id} />
            {companyId ? <> · <CompanyLink id={companyId} name={names.get(companyId)} /></> : null}
            {opp ? <> · {opp.title}</> : null}
          </div>
        </div>
        <button disabled={done.busy} onClick={() => done.run(() => post(`/tasks/${t.id}/complete`))}>Done</button>
      </li>
    );
  };
  const oppRow = (o: Opportunity, why: string) => (
    <li key={o.id}>
      <div>
        <strong>{o.title}</strong> <Badge>{stageLabel(o.stage)}</Badge>
        <div className="muted">
          <CompanyLink id={o.company_id} name={names.get(o.company_id)} /> · <Who id={o.owner_id} /> · {why}
        </div>
      </div>
    </li>
  );

  return (
    <>
      <h1>Today <small className="muted">{today.today}</small></h1>
      <ErrorBox error={done.error} />
      <div className="grid2">
        <Section title={`Meetings, next 7 days (${meetings.length})`} aside={<a href="#/meetings">All meetings</a>}>
          {meetings.length ? (
            <ul className="rows">
              {meetings.map((m) => (
                <li key={m.id}>
                  <div>
                    <a href={`#/meetings/${m.id}`}><strong>{m.title}</strong></a>
                    <div className="muted">{fmtLocal(m.starts_at)} · <CompanyLink id={m.company_id} name={names.get(m.company_id)} /></div>
                  </div>
                </li>
              ))}
            </ul>
          ) : <p className="muted">No meetings this week.</p>}
        </Section>
        <Section title={`Overdue tasks (${today.overdueTasks.length})`}>
          {today.overdueTasks.length ? <ul className="rows">{today.overdueTasks.map(taskRow)}</ul> : <p className="muted">Nothing overdue.</p>}
        </Section>
        <Section title={`Due today (${today.dueToday.length})`}>
          {today.dueToday.length ? <ul className="rows">{today.dueToday.map(taskRow)}</ul> : <p className="muted">Nothing due today.</p>}
        </Section>
        <Section title={`Stalled (${today.stalledOpportunities.length})`} aside={<span className="muted">no activity for {today.stalledAfterDays}+ days</span>}>
          {today.stalledOpportunities.length ? (
            <ul className="rows">{today.stalledOpportunities.map((o) => oppRow(o, `last activity ${fmtDate(o.updated_at)}`))}</ul>
          ) : (
            <p className="muted">No stalled opportunities.</p>
          )}
        </Section>
        <Section title={`No next step (${today.opportunitiesWithoutNextStep.length})`}>
          {today.opportunitiesWithoutNextStep.length ? (
            <ul className="rows">{today.opportunitiesWithoutNextStep.map((o) => oppRow(o, 'needs a next step'))}</ul>
          ) : (
            <p className="muted">Every open opportunity has a next step.</p>
          )}
        </Section>
      </div>
      <p className="muted">New replies and meeting briefings appear here once outreach and calendar arrive (later phases).</p>
    </>
  );
}
