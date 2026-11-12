import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { Hono } from 'hono';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { Page, TimelineEntry } from '@substrat-run/contracts';
import { manualClock, type ScopeStub } from '@substrat-run/kernel';
import type { SqliteScopeHost } from '@substrat-run/adapter-sqlite';
import { buildSalesHost, seedSales, type SalesWorld } from '../src/seed.js';
import { mountApi } from '../src/routes.js';
import type {
  BatchRow,
  CompanyRow,
  ContactRow,
  DuplicateRow,
  ExclusionRow,
  ImportRowRow,
  InteractionRow,
  KnowledgeRow,
  OpportunityRow,
  TaskRow,
} from '../src/module.js';

// ============================================================================
// The Sales OS scenario, replayed headlessly against a temp dir: import a CSV,
// review the duplicates, keep the knowledge base honest, work an opportunity
// through its stages, read the daily queue — then prove every door that should
// be shut IS shut. Each denial is pinned to its message and paired with a
// control showing a neighbouring door is open, so a green test can never be a
// silently-broken one.
// ============================================================================

const CSV = [
  'company,domain,segment,contact_name,contact_email,contact_role,source',
  'Acme AB,acme.se,saas,Anna,anna@acme.se,CTO,list-a',
  'Beta Oy,https://www.beta.fi/about,fintech,Bo,bo@beta.fi,CEO,list-a',
  'ACME AB,acme-group.com,saas,Ann,ann@acme-group.com,Head of IT,list-a',
  ',x.com,,,,,list-a',
  'Evil Corp,evil.com,,Eve,eve@evil.com,,list-a',
  'Gamma Ltd,gamma.io,,Gus,,,list-a',
  'Beta Oy,beta.fi,fintech,Cia,cia@beta.fi,CFO,list-a',
  'Delta Co,delta.se,,Dan,anna@acme.se,,list-a',
  'Beta Oy,beta.fi,fintech,Bo,bo@beta.fi,CEO,list-a',
].join('\n');

describe('sales-os scenario', () => {
  let dir: string;
  let host: SqliteScopeHost;
  let w: SalesWorld;
  let markus: ScopeStub;
  let nora: ScopeStub;
  const clock = manualClock('2026-11-10T09:00:00.000Z');

  let acmeId: string;
  let batch: BatchRow;
  let opportunityId: string;
  let knowledgeId: string;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'substrat-sales-os-'));
    host = buildSalesHost(dir, { clock: clock.read });
    w = await seedSales(host, dir);
    markus = await host.getScope(w.markus, w.t1, w.s1);
    nora = await host.getScope(w.nora, w.t1, w.s1);
  });

  afterAll(async () => {
    await host.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('1. provisions and applies the vertical’s journal in both workspaces', () => {
    const db = new Database(join(dir, `${w.t1}__${w.s1}.sqlite`), { readonly: true });
    const rows = db.prepare('SELECT DISTINCT module_id FROM _substrat_migrations ORDER BY module_id').all() as { module_id: string }[];
    db.close();
    // The assistant engine's journal (its own four tables) and ours.
    expect(rows.map((r) => r.module_id)).toEqual(['@substrat-run/engine-assistant', 'salesos']);
  });

  it('2. an exclusion stops a company being added, and a person adds it by hand otherwise', async () => {
    await nora.invoke<ExclusionRow>('sales/add-exclusion', {
      kind: 'domain',
      value: 'https://www.evil.com/',
      reason: 'asked not to be contacted',
    });
    await expect(nora.invoke('sales/create-company', { companyName: 'Evil Corp', domain: 'evil.com', source: 'test' })).rejects.toThrow(
      /excluded: asked not to be contacted/,
    );
    const acme = await markus.invoke<CompanyRow>('sales/create-company', {
      companyName: 'Acme AB',
      domain: 'https://www.Acme.se/',
      source: 'founder network',
    });
    acmeId = acme.id;
    expect(acme.domain).toBe('acme.se');
    expect(acme.owner_id).toBe(w.markus);
    await markus.invoke('sales/create-contact', { companyId: acmeId, name: 'Anna', email: 'Anna@Acme.se' });
    // The same email twice is refused, not silently merged.
    await expect(
      markus.invoke('sales/create-contact', { companyId: acmeId, name: 'Anna again', email: 'anna@acme.se' }),
    ).rejects.toThrow(/already exists/);
  });

  it('3. a CSV import matches, flags and creates — and merges NOTHING on its own', async () => {
    batch = await markus.invoke<BatchRow>('sales/import-csv', { filename: 'list-a.csv', csv: CSV });
    expect(batch.row_count).toBe(9);
    // created: Beta Oy, and Cia (a new contact at the already-matched Beta). matched: Acme (same domain,
    // Anna already exists) and the repeated Bo row. flagged: probable duplicate, missing company, excluded,
    // contact with no email, and an email that already belongs to another company.
    expect({ c: batch.created_count, m: batch.matched_count, f: batch.flagged_count }).toEqual({ c: 2, m: 2, f: 5 });

    const rows = (await markus.invoke<Page<ImportRowRow>>('sales/list-import-rows', { batchId: batch.id })).entries;
    expect(rows).toHaveLength(9);
    // The raw row survives exactly as uploaded.
    expect(JSON.parse(rows[1]!.raw)).toMatchObject({ company: 'Beta Oy', domain: 'https://www.beta.fi/about' });
    const notes = rows.map((r) => r.note ?? '');
    expect(notes[2]).toMatch(/probable duplicate/);
    expect(notes[3]).toMatch(/missing company name/);
    expect(notes[4]).toMatch(/excluded: asked not to be contacted/);
    expect(notes[5]).toMatch(/contact has no email/);
    expect(notes[7]).toMatch(/already a contact at another company/);
    const flagged = await markus.invoke<Page<ImportRowRow>>('sales/list-import-rows', {
      batchId: batch.id,
      outcome: 'flagged',
    });
    expect(flagged.entries).toHaveLength(5);

    // No two companies were merged; the probable duplicate is a candidate awaiting a person.
    const companies = (await markus.invoke<Page<CompanyRow>>('sales/list-companies')).entries;
    expect(companies.filter((c) => c.merged_into !== null)).toEqual([]);
    expect(companies.filter((c) => c.name.toLowerCase() === 'acme ab')).toHaveLength(2);
    const open = (await markus.invoke<Page<DuplicateRow>>('sales/list-duplicates', { status: 'open' })).entries;
    expect(open).toHaveLength(1);
    expect(open[0]).toMatchObject({ kind: 'company', left_id: acmeId });
  });

  it('4. resolving the duplicate: a merge keeps everything, nothing is deleted', async () => {
    const [dup] = (await markus.invoke<Page<DuplicateRow>>('sales/list-duplicates', { status: 'open' })).entries;
    const loserId = dup!.right_id;
    await markus.invoke('sales/create-task', { title: 'Call Ann', dueDate: '2026-11-12', companyId: loserId });
    // A survivor outside the pair is refused.
    await expect(
      markus.invoke('sales/resolve-duplicate', { duplicateId: dup!.id, decision: 'merge', survivorId: 'nope' }),
    ).rejects.toThrow(/survivorId/);
    const done = await markus.invoke<DuplicateRow>('sales/resolve-duplicate', {
      duplicateId: dup!.id,
      decision: 'merge',
      survivorId: acmeId,
    });
    expect(done.status).toBe('merged');
    expect(done.decided_by).toBe(w.markus);
    expect(JSON.parse(done.snapshot!)).toMatchObject({ survivorId: acmeId, moved: { contacts: 1, tasks: 1 } });

    const detail = await markus.invoke<{ company: CompanyRow; contacts: ContactRow[] }>('sales/get-company', {
      companyId: acmeId,
    });
    expect(detail.contacts.map((c) => c.email).sort()).toEqual(['ann@acme-group.com', 'anna@acme.se']);
    expect(detail.company.domain).toBe('acme.se');
    // The loser is hidden from the list but still on record, pointing at the survivor.
    const gone = await markus.invoke<{ company: CompanyRow }>('sales/get-company', { companyId: loserId });
    expect(gone.company.merged_into).toBe(acmeId);
    const listed = (await markus.invoke<Page<CompanyRow>>('sales/list-companies', { q: 'acme' })).entries;
    expect(listed.map((c) => c.id)).toEqual([acmeId]);
    // A decided candidate cannot be decided twice.
    await expect(
      markus.invoke('sales/resolve-duplicate', { duplicateId: dup!.id, decision: 'keep_both' }),
    ).rejects.toThrow(/already decided/);
  });

  it('5. the knowledge base: claims are labelled, approval is an admin’s act', async () => {
    await expect(
      markus.invoke('sales/create-knowledge', {
        title: 'Booking engine',
        body: 'Prevents overbooking.',
        category: 'capability',
        source: 'docs',
      }),
    ).rejects.toThrow(/needs a claim label/);
    const entry = await markus.invoke<KnowledgeRow>('sales/create-knowledge', {
      title: 'Booking engine',
      body: 'Prevents overbooking.',
      category: 'capability',
      claimLabel: 'built_unproven',
      source: 'docs',
    });
    knowledgeId = entry.id;
    expect(entry.status).toBe('draft');
    // A colleague can READ the knowledge base but cannot write or approve it…
    await expect(nora.invoke('sales/approve-knowledge', { knowledgeId })).rejects.toThrow(/permission denied/);
    await expect(
      nora.invoke('sales/create-knowledge', { title: 't', body: 'b', category: 'faq', source: 's' }),
    ).rejects.toThrow(/permission denied/);
    // …the control: the neighbouring door is open.
    const seen = await nora.invoke<Page<KnowledgeRow>>('sales/list-knowledge', { category: 'capability' });
    expect(seen.entries.map((e) => e.id)).toContain(knowledgeId);

    const approved = await markus.invoke<KnowledgeRow>('sales/approve-knowledge', { knowledgeId });
    expect(approved).toMatchObject({ status: 'approved', approved_by: w.markus });
    // Editing approved knowledge withdraws the approval.
    const edited = await markus.invoke<KnowledgeRow>('sales/update-knowledge', { knowledgeId, body: 'Never overbooks.' });
    expect(edited).toMatchObject({ status: 'draft', approved_by: null });
  });

  it('6. work an opportunity: a call is logged, any move is allowed, lost needs a reason', async () => {
    const opp = await nora.invoke<OpportunityRow>('sales/create-opportunity', {
      companyId: acmeId,
      title: 'Replace their booking system',
      valueLow: '20000',
      valueHigh: '40000',
      targetDate: '2026-12-15',
    });
    opportunityId = opp.id;
    expect(opp).toMatchObject({ stage: 'new', owner_id: w.nora, value_low: '20000', currency: 'EUR' });
    // Several opportunities can belong to one company.
    await nora.invoke('sales/create-opportunity', { companyId: acmeId, title: 'Second use case' });

    const call = await nora.invoke<InteractionRow>('sales/log-interaction', {
      companyId: acmeId,
      opportunityId,
      kind: 'call',
      direction: 'outbound',
      summary: 'Intro call; they run a home-grown booking tool.',
      customerQuote: 'We spend half our week on double bookings.',
    });
    // The quote is stored apart from the summary, and this one is a person's, not generated.
    expect(call).toMatchObject({ performed_by_kind: 'person', performed_by: w.nora, generated: 0 });
    expect(call.customer_quote).toBe('We spend half our week on double bookings.');
    expect(call.summary).not.toContain('double bookings');
    const generated = await nora.invoke<InteractionRow>('sales/log-interaction', {
      companyId: acmeId,
      kind: 'note',
      summary: 'AI summary of the call.',
      generated: true,
    });
    expect(generated).toMatchObject({ generated: 1, performed_by_kind: 'agent' });

    // Any stage to any other: skip ahead, step back, and the same stage is refused.
    const skipped = await nora.invoke<OpportunityRow>('sales/move-opportunity', { opportunityId, stage: 'proposal' });
    expect(skipped.stage).toBe('proposal');
    const back = await nora.invoke<OpportunityRow>('sales/move-opportunity', { opportunityId, stage: 'contacted' });
    expect(back.stage).toBe('contacted');
    await expect(nora.invoke('sales/move-opportunity', { opportunityId, stage: 'contacted' })).rejects.toThrow(
      /already contacted/,
    );
    await expect(nora.invoke('sales/move-opportunity', { opportunityId, stage: 'lost' })).rejects.toThrow(
      /needs a reason/,
    );
    const lost = await nora.invoke<OpportunityRow>('sales/move-opportunity', {
      opportunityId: (await nora.invoke<Page<OpportunityRow>>('sales/list-opportunities', { companyId: acmeId })).entries.find(
        (o) => o.title === 'Second use case',
      )!.id,
      stage: 'lost',
      lostReason: 'no budget',
    });
    expect(lost).toMatchObject({ stage: 'lost', lost_reason: 'no budget' });
    // A lost opportunity can be reopened, and the reason goes with it.
    const reopened = await nora.invoke<OpportunityRow>('sales/move-opportunity', { opportunityId: lost.id, stage: 'contacted' });
    expect(reopened).toMatchObject({ stage: 'contacted', lost_reason: null });
  });

  it('7. opting out: anyone can opt a contact out, only an admin can lift it', async () => {
    const contacts = (await markus.invoke<Page<ContactRow>>('sales/list-contacts', { companyId: acmeId })).entries;
    const anna = contacts.find((c) => c.email === 'anna@acme.se')!;
    expect((await nora.invoke<ContactRow>('sales/set-opt-out', { contactId: anna.id, optedOut: true })).opted_out).toBe(1);
    await expect(nora.invoke('sales/set-opt-out', { contactId: anna.id, optedOut: false })).rejects.toThrow(
      /permission denied/,
    );
    expect((await markus.invoke<ContactRow>('sales/set-opt-out', { contactId: anna.id, optedOut: false })).opted_out).toBe(0);
  });

  it('8. today: time passes, and the queue shows what is overdue and what has stalled', async () => {
    await nora.invoke('sales/create-task', { title: 'Send the follow-up', dueDate: '2026-11-12', opportunityId });
    let today = await nora.invoke<{ today: string; overdueTasks: TaskRow[]; stalledOpportunities: OpportunityRow[] }>(
      'sales/today',
    );
    expect(today.today).toBe('2026-11-10');
    expect(today.overdueTasks).toEqual([]);
    expect(today.stalledOpportunities).toEqual([]);

    clock.advance(15 * 24 * 3600_000); // 25 Nov: tasks due the 12th are overdue, untouched deals have stalled
    today = await nora.invoke('sales/today');
    expect(today.today).toBe('2026-11-25');
    expect(today.overdueTasks.map((t) => t.title).sort()).toEqual(['Call Ann', 'Send the follow-up']);
    expect(today.stalledOpportunities.map((o) => o.id)).toContain(opportunityId);

    // Logging activity un-stalls it; completing the task clears the queue.
    await nora.invoke('sales/log-interaction', { companyId: acmeId, opportunityId, kind: 'email', summary: 'Followed up.' });
    for (const t of today.overdueTasks) await nora.invoke('sales/complete-task', { taskId: t.id });
    await expect(nora.invoke('sales/complete-task', { taskId: today.overdueTasks[0]!.id })).rejects.toThrow(/already done/);
    today = await nora.invoke('sales/today');
    expect(today.overdueTasks).toEqual([]);
    expect(today.stalledOpportunities.map((o) => o.id)).not.toContain(opportunityId);
  });

  it('9. every change is on the timeline, stamped with who made it', async () => {
    const timeline = await nora.invoke<Page<TimelineEntry>>('sales/timeline', { entityType: 'opportunity', entityId: opportunityId });
    const types = timeline.entries.map((e) => e.type);
    expect(types).toContain('sales.opportunity-created');
    expect(types).toContain('sales.opportunity-stage-changed');
    const created = timeline.entries.find((e) => e.type === 'sales.opportunity-created')!;
    expect(JSON.stringify(created.actor)).toContain(w.nora);
  });

  it('10. every shut door is shut — pinned messages, each paired with an open one', async () => {
    // A colleague cannot import, resolve duplicates, lift an exclusion, or read the audit trail…
    await expect(nora.invoke('sales/import-csv', { filename: 'x.csv', csv: 'company\nZed' })).rejects.toThrow(/permission denied/);
    await expect(nora.invoke('sales/list-duplicates')).rejects.toThrow(/permission denied/);
    await expect(nora.invoke('sales/list-import-rows', { batchId: batch.id })).rejects.toThrow(/permission denied/);
    const [ex] = (await nora.invoke<Page<ExclusionRow>>('sales/list-exclusions')).entries;
    await expect(nora.invoke('sales/lift-exclusion', { exclusionId: ex!.id })).rejects.toThrow(/permission denied/);
    await expect(
      nora.invoke('sales/audit', { entityType: 'opportunity', entityId: opportunityId }),
    ).rejects.toThrow(/permission denied/);
    // …the controls: the same colleague can read the exclusions and the timeline, and the admin can audit.
    expect(ex!.value).toBe('evil.com');
    const audit = await markus.invoke<Page<{ type: string; authorization: unknown }>>('sales/audit', {
      entityType: 'opportunity',
      entityId: opportunityId,
    });
    expect(audit.entries.length).toBeGreaterThan(0);

    // The cross-tenant attacker: claiming t1's scope under his OWN tenant fails the pair check…
    await expect(host.getScope(w.rex, w.t2, w.s1)).rejects.toThrow(/unknown scope/);
    // …the control: his own (t2, s2) pair resolves, and is empty.
    const own = await host.getScope(w.rex, w.t2, w.s2);
    expect((await own.invoke<Page<CompanyRow>>('sales/list-companies')).entries).toEqual([]);
    // With the correct pair he can mint a stub but holds no tuples in t1: every operation is denied.
    const rex = await host.getScope(w.rex, w.t1, w.s1);
    for (const op of ['sales/list-companies', 'sales/list-knowledge', 'sales/today', 'sales/list-duplicates']) {
      await expect(rex.invoke(op)).rejects.toThrow(/permission denied/);
    }
    await expect(rex.invoke('sales/get-company', { companyId: acmeId })).rejects.toThrow(/permission denied/);
    await expect(rex.invoke('sales/import-csv', { filename: 'x.csv', csv: 'company\nZed' })).rejects.toThrow(/permission denied/);
  });

  it('10b. a screen can ask what the caller may do, and the answers differ by role', async () => {
    const admin = (await markus.invoke<{ permissions: string[] }>('sales/my-permissions')).permissions;
    const member = (await nora.invoke<{ permissions: string[] }>('sales/my-permissions')).permissions;
    expect(admin).toContain('audit:read');
    expect(admin).toContain('knowledge:manage');
    expect(member.sort()).toEqual(['assistant:use', 'crm:read', 'crm:write', 'exclusion:add', 'knowledge:read']);
    // A caller with no role in this workspace holds nothing: the answer is empty, not a denial.
    const rex = await host.getScope(w.rex, w.t1, w.s1);
    expect((await rex.invoke<{ permissions: string[] }>('sales/my-permissions')).permissions).toEqual([]);
  });

  it('10c. join records a person as themselves, can repeat, and nobody can join as someone else', async () => {
    const first = await nora.invoke<{ id: string; display_name: string }>('sales/join', { displayName: 'Nora Nilsson' });
    expect(first).toMatchObject({ id: w.nora, display_name: 'Nora Nilsson' });
    // Again (a new isolate, or two first requests at once): the same row, not a failure.
    const again = await nora.invoke<{ id: string }>('sales/join', { displayName: 'Nora Nilsson' });
    expect(again.id).toBe(w.nora);
    const members = (await markus.invoke<Page<{ id: string; display_name: string }>>('sales/list-members')).entries;
    expect(members.filter((m) => m.id === w.nora)).toHaveLength(1);
    // The row is always the CALLER'S: there is no input that names another person.
    expect(members.find((m) => m.id === w.markus)?.display_name).toBe('Markus');
    // A person with no role in this workspace cannot join it.
    const rex = await host.getScope(w.rex, w.t1, w.s1);
    await expect(rex.invoke('sales/join', { displayName: 'Rex' })).rejects.toThrow(/permission denied/);
  });

  it('11. the exclusion can be lifted by an admin, and then the company can be added', async () => {
    const [ex] = (await markus.invoke<Page<ExclusionRow>>('sales/list-exclusions')).entries;
    await markus.invoke('sales/lift-exclusion', { exclusionId: ex!.id });
    await expect(markus.invoke('sales/create-company', { companyName: 'Evil Corp', domain: 'evil.com', source: 'test' })).resolves.toBeTruthy();
  });

  it('12. two people editing one record: the second, stale save is refused, never silently applied', async () => {
    // The real route table, as the UI calls it: the ETag rides a read, `If-Match` rides the edit.
    const app = new Hono();
    mountApi(app, async (c) => (c.req.header('x-as') === 'nora' ? nora : markus));
    const call = (as: 'markus' | 'nora', method: string, path: string, body?: unknown, ifMatch?: string | null) =>
      app.request('/api' + path, {
        method,
        headers: { 'x-as': as, ...(body ? { 'content-type': 'application/json' } : {}), ...(ifMatch ? { 'if-match': ifMatch } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });

    for (const [label, readPath, editPath, edit, field] of [
      ['company', `/companies/${acmeId}`, `/companies/${acmeId}/update`, { companyId: acmeId }, 'segment'],
      ['opportunity', `/opportunities/${opportunityId}`, `/opportunities/${opportunityId}/update`, { opportunityId }, 'nextStep'],
      ['knowledge', `/knowledge/${knowledgeId}`, `/knowledge/${knowledgeId}/update`, { knowledgeId }, 'title'],
    ] as const) {
      // Both people open the record and hold the same version.
      const a = await call('markus', 'GET', readPath);
      const b = await call('nora', 'GET', readPath);
      expect(a.status, `${label}: read`).toBe(200);
      const tag = a.headers.get('etag');
      expect(tag, `${label}: a read hands back an ETag`).toBeTruthy();
      expect(b.headers.get('etag')).toBe(tag);

      // Markus saves first, with the version he read.
      const first = await call('markus', 'POST', editPath, { ...edit, [field]: `${label} by Markus` }, tag);
      expect(first.status, `${label}: the first save`).toBe(200);
      expect(first.headers.get('etag')).not.toBe(tag);

      // Nora saves second, still holding the old version: refused, and Markus's change is intact.
      // (Nora cannot edit knowledge at all, so that one is refused for a different reason: use Markus twice.)
      const as = label === 'knowledge' ? 'markus' : 'nora';
      const stale = await call(as, 'POST', editPath, { ...edit, [field]: `${label} by Nora` }, tag);
      expect(stale.status, `${label}: a stale save`).toBe(412);
      const now = (await (await call('markus', 'GET', readPath)).json()) as Record<string, unknown>;
      const shown = (label === 'company' ? (now.company as Record<string, unknown>) : now)[
        field === 'nextStep' ? 'next_step' : field
      ];
      expect(shown, `${label}: the first save survives`).toBe(`${label} by Markus`);

      // The control: with the CURRENT version the same edit goes through.
      const fresh = (await call(as, 'GET', readPath)).headers.get('etag');
      const retry = await call(as, 'POST', editPath, { ...edit, [field]: `${label} by ${as}` }, fresh);
      expect(retry.status, `${label}: a save with the current version`).toBe(200);
    }
  });
});
