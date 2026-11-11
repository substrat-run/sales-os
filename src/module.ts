import {
  listLimitOf,
  pageOf,
  substratError,
  z,
  type HandlerInput,
  type HandlerOutput,
  type Page,
} from '@substrat-run/contracts';
import {
  assertAllowed,
  readHistory,
  readTimeline,
  ulid,
  type ModuleRegistration,
  type OperationContext,
  type OperationHandler,
  operationsFor,
} from '@substrat-run/kernel';
import { ASSISTANT_PERM } from '@substrat-run/engine-assistant';
import { STAGES, salesEntities } from './entities.js';
import { importRow, salesOperations } from './operations.js';
import { salesManifest, SALES_PERM } from './manifest.js';
import { salesMigrations } from './migrations.js';

// ============================================================================
// The Sales OS HANDLERS. Every operation's FIRST line is the permission check.
// Data access is `ctx.sql` only; time is `ctx.now()`; ids are ULIDs. No fetch,
// no node:*, no other module's tables.
//
// WHAT EACH OPERATION IS is declared in `src/operations.ts`; this file holds only
// the bodies, bound by `operationsFor(salesOperations)` so a handler that
// disagrees with its declaration is a compile error at the exact method.
// ============================================================================

type Row<K extends keyof typeof salesEntities> = z.infer<(typeof salesEntities)[K]['fields']>;
export type CompanyRow = Row<'company'>;
export type ContactRow = Row<'contact'>;
export type OpportunityRow = Row<'opportunity'>;
export type InteractionRow = Row<'interaction'>;
export type TaskRow = Row<'task'>;
export type KnowledgeRow = Row<'knowledge'>;
export type ExclusionRow = Row<'exclusion'>;
export type MemberRow = Row<'member'>;
export type BatchRow = Row<'import_batch'>;
export type DuplicateRow = Row<'duplicate'>;
export type InviteRow = Row<'invite'>;
export type ImportRowRow = z.infer<typeof importRow>;

type Op<K extends keyof typeof salesOperations> = OperationHandler<
  HandlerInput<(typeof salesOperations)[K]>,
  HandlerOutput<(typeof salesOperations)[K]>
>;

type Param = string | number | null;
type Ctx = OperationContext;

/** An opportunity with no activity for this many days is flagged as stalled in the daily queue. */
export const STALLED_AFTER_DAYS = 14;

// ---------------------------------------------------------------- helpers

/**
 * Announce a mutation. The event's type, entity, schema version and payload fields are read off the
 * operation's own `emits` declaration, so what the handler emits and what `src/operations.ts` (and
 * the manifest) promise cannot drift. Returns the row, so a handler can `return announce(...)`.
 */
function announce<T extends { id: string }>(ctx: Ctx, op: keyof typeof salesOperations, row: T): T {
  const decl = (salesOperations[op] as { emits?: { type: string; entity: string; schemaVersion: number; payload?: readonly string[] } }).emits;
  if (!decl) throw new Error(`${op} declares no emits`);
  const payload: Record<string, unknown> = {};
  for (const f of decl.payload ?? []) payload[f] = (row as Record<string, unknown>)[f];
  ctx.emit({
    type: decl.type,
    schemaVersion: decl.schemaVersion,
    entity: { entityType: decl.entity, entityId: row.id },
    piiClass: 'none',
    payload,
  } as Parameters<Ctx['emit']>[0]);
  return row;
}

function getRow<T>(ctx: Ctx, table: string, rowId: string, label: string): T {
  const row = ctx.sql.query<T>(`SELECT * FROM ${table} WHERE id = ?`, [rowId])[0];
  if (!row) throw substratError('not_found', `${label} not found: ${rowId}`);
  return row;
}

/** Keyset page over `id`, with equality/LIKE filters supplied by the caller. */
function pageRows<T extends { id: string }>(
  ctx: Ctx,
  table: string,
  where: string[],
  params: Param[],
  input: { limit?: number | undefined; cursor?: string | undefined } | undefined,
): Page<T> {
  const limit = listLimitOf(input?.limit);
  const clauses = [...where];
  const args = [...params];
  if (input?.cursor) {
    clauses.push('id > ?');
    args.push(input.cursor);
  }
  const rows = ctx.sql.query<T>(
    `SELECT * FROM ${table}${clauses.length ? ' WHERE ' + clauses.join(' AND ') : ''} ORDER BY id LIMIT ?`,
    [...args, limit],
  );
  return pageOf(rows, limit, (r) => r.id);
}

/** `https://www.Acme.com/path` → `acme.com`. Null for empty. */
export function normDomain(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const d = raw
    .trim()
    .toLowerCase()
    .replace(/^[a-z]+:\/\//, '')
    .replace(/^www\./, '')
    .split(/[/?#]/)[0]!
    .trim();
  return d || null;
}

/** An escaped LIKE pattern, kept well under the 50-byte limit a Durable Object enforces. */
function likeOf(q: string): string {
  return `%${q.toLowerCase().slice(0, 20).replace(/[\\%_]/g, (c) => '\\' + c)}%`;
}

function exclusionFor(ctx: Ctx, domain: string | null, name: string | null): ExclusionRow | undefined {
  if (domain) {
    const hit = ctx.sql.query<ExclusionRow>(
      `SELECT * FROM sales_exclusions WHERE kind = 'domain' AND value = ?`,
      [domain],
    )[0];
    if (hit) return hit;
  }
  if (name) {
    return ctx.sql.query<ExclusionRow>(
      `SELECT * FROM sales_exclusions WHERE kind = 'company' AND lower(value) = ?`,
      [name.toLowerCase()],
    )[0];
  }
  return undefined;
}

// ------------------------------------------------------- the assistant's tools

const AI_COMPANY_COLS = 'id, name, domain, segment, fit_score, fit_reason, source';
const AI_OPP_COLS =
  'id, company_id, title, stage, fit_rationale, value_low, value_high, currency, next_step, target_date, lost_reason';

/** Words worth matching on: three letters or more, a few of them, short enough for a LIKE pattern. */
function termsOf(query: string): string[] {
  return [...new Set(query.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((t) => t.length >= 3))].slice(0, 6).map((t) => t.slice(0, 20));
}

const assistantFindKnowledgeOp: Op<'sales/assistant-find-knowledge'> = async (ctx, input) => {
  assertAllowed(await ctx.check(SALES_PERM.knowledgeRead));
  const terms = termsOf(input.query);
  if (!terms.length) return { entries: [] };
  // The category's placeholder comes first in the statement, so its value goes first.
  const params: Param[] = input.category ? [input.category] : [];
  const clauses = terms.map((t) => {
    params.push(likeOf(t), likeOf(t));
    return `(lower(title) LIKE ? ESCAPE '\\' OR lower(body) LIKE ? ESCAPE '\\')`;
  });
  // Only APPROVED entries are facts. A draft or a retired entry is not something to answer from.
  const rows = ctx.sql.query<KnowledgeRow>(
    `SELECT * FROM sales_knowledge WHERE status = 'approved'${input.category ? ' AND category = ?' : ''} AND (${clauses.join(' OR ')}) LIMIT 40`,
    params,
  );
  const score = (r: KnowledgeRow) => terms.filter((t) => (r.title + ' ' + r.body).toLowerCase().includes(t)).length;
  const ranked = rows.sort((a, b) => score(b) - score(a) || a.id.localeCompare(b.id)).slice(0, 8);
  return {
    entries: ranked.map((r) => ({
      id: r.id, title: r.title, body: r.body.slice(0, 2000), category: r.category,
      claim_label: r.claim_label, source: r.source, source_date: r.source_date,
    })),
  };
};

const assistantFindCompaniesOp: Op<'sales/assistant-find-companies'> = async (ctx, input) => {
  assertAllowed(await ctx.check(SALES_PERM.crmRead));
  const like = likeOf(input.query);
  return {
    entries: ctx.sql.query<z.infer<(typeof salesOperations)['sales/assistant-find-companies']['output']>['entries'][number]>(
      `SELECT ${AI_COMPANY_COLS} FROM sales_companies WHERE merged_into IS NULL
         AND (lower(name) LIKE ? ESCAPE '\\' OR lower(coalesce(domain, '')) LIKE ? ESCAPE '\\' OR lower(coalesce(segment, '')) LIKE ? ESCAPE '\\')
         ORDER BY name LIMIT 8`,
      [like, like, like],
    ),
  };
};

const assistantCompanyOp: Op<'sales/assistant-company'> = async (ctx, input) => {
  assertAllowed(await ctx.check(SALES_PERM.crmRead));
  const c = ctx.sql.query<CompanyRow>(`SELECT ${AI_COMPANY_COLS} FROM sales_companies WHERE id = ?`, [input.companyId])[0];
  if (!c) throw substratError('not_found', `company not found: ${input.companyId}`);
  return {
    company: c,
    opportunities: ctx.sql.query<OpportunityRow>(
      `SELECT ${AI_OPP_COLS} FROM sales_opportunities WHERE company_id = ? ORDER BY id LIMIT 50`,
      [c.id],
    ),
  };
};

const assistantTodayOp: Op<'sales/assistant-today'> = async (ctx) => {
  assertAllowed(await ctx.check(SALES_PERM.crmRead));
  const now = ctx.now();
  const today = now.slice(0, 10);
  const open = `stage NOT IN ('won', 'lost')`;
  const count = (sql: string, p: Param[]) => ctx.sql.query<{ n: number }>(sql, p)[0]?.n ?? 0;
  return {
    today,
    stalledAfterDays: STALLED_AFTER_DAYS,
    stalledOpportunities: ctx.sql.query<OpportunityRow>(
      `SELECT ${AI_OPP_COLS} FROM sales_opportunities WHERE ${open}
         AND updated_at < strftime('%Y-%m-%dT%H:%M:%fZ', ?, '-${STALLED_AFTER_DAYS} days') ORDER BY updated_at LIMIT 20`,
      [now],
    ),
    opportunitiesWithoutNextStep: ctx.sql.query<OpportunityRow>(
      `SELECT ${AI_OPP_COLS} FROM sales_opportunities WHERE ${open} AND next_step IS NULL ORDER BY id LIMIT 20`,
    ),
    overdueTaskCount: count('SELECT count(*) AS n FROM sales_tasks WHERE done_at IS NULL AND due_date < ?', [today]),
    dueTodayTaskCount: count('SELECT count(*) AS n FROM sales_tasks WHERE done_at IS NULL AND due_date = ?', [today]),
  };
};

// ------------------------------------------------------------------- self

const myPermissionsOp: Op<'sales/my-permissions'> = async (ctx) => {
  const held: string[] = [];
  for (const key of [...Object.values(SALES_PERM), ASSISTANT_PERM.use]) {
    if ((await ctx.check(key)).allowed) held.push(key);
  }
  return { permissions: held };
};

// ---------------------------------------------------------------- members

const registerMemberOp: Op<'sales/register-member'> = async (ctx, input) => {
  assertAllowed(await ctx.check(SALES_PERM.memberManage));
  ctx.sql.exec(
    `INSERT INTO sales_members (id, display_name, email, created_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET display_name = excluded.display_name, email = excluded.email`,
    [input.principalId, input.displayName, input.email ?? null, ctx.now()],
  );
  return announce(ctx, 'sales/register-member', getRow<MemberRow>(ctx, 'sales_members', input.principalId, 'member'));
};

const joinOp: Op<'sales/join'> = async (ctx, input) => {
  assertAllowed(await ctx.check(SALES_PERM.crmRead));
  // Arriving on an open invitation (its id IS this person's principal) settles it.
  const now = ctx.now();
  const arrived = ctx.sql.exec(
    `UPDATE sales_invites SET status = 'arrived', settled_at = ? WHERE id = ? AND status = 'open'`,
    [now, ctx.principal],
  ).changes;
  if (arrived) {
    ctx.emit({
      type: 'sales.invite-arrived',
      schemaVersion: 1,
      entity: { entityType: 'invite', entityId: ctx.principal },
      piiClass: 'none',
      payload: { id: ctx.principal, status: 'arrived' },
    } as Parameters<Ctx['emit']>[0]);
  }
  // Only ever the caller's own row, and the email is the one the issuer verified, never one they typed.
  ctx.sql.exec(
    `INSERT INTO sales_members (id, display_name, email, created_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET display_name = excluded.display_name, email = coalesce(excluded.email, sales_members.email)`,
    [ctx.principal, input.displayName, ctx.verifiedEmail, ctx.now()],
  );
  return announce(ctx, 'sales/join', getRow<MemberRow>(ctx, 'sales_members', ctx.principal, 'member'));
};

// --------------------------------------------------------- team invitations

/** An open invitation past its expiry reads as `expired`; the row is untouched (a read settles nothing). */
function effective(row: InviteRow, now: string): InviteRow {
  return row.status === 'open' && row.expires_at <= now ? { ...row, status: 'expired' } : row;
}

const inviteMemberOp: Op<'sales/invite-member'> = async (ctx, input) => {
  assertAllowed(await ctx.check(SALES_PERM.memberManage));
  const email = input.email.trim().toLowerCase();
  const now = ctx.now();
  // The admin may be told "already on the team": it comes from OUR member list, which they can already read.
  if (ctx.sql.query('SELECT 1 FROM sales_members WHERE lower(email) = ?', [email])[0]) {
    throw substratError('conflict', 'that address is already on the team');
  }
  const open = ctx.sql.query<InviteRow>(`SELECT * FROM sales_invites WHERE email = ? AND status = 'open' AND expires_at > ?`, [email, now])[0];
  if (open) throw substratError('conflict', 'that address already has an open invitation');
  ctx.sql.exec(
    `INSERT INTO sales_invites (id, email, role_key, invited_by, status, expires_at, created_at, settled_at)
     VALUES (?, ?, ?, ?, 'open', ?, ?, NULL)`,
    [input.principal, email, input.roleKey, ctx.principal, input.expiresAt, now],
  );
  return announce(ctx, 'sales/invite-member', getRow<InviteRow>(ctx, 'sales_invites', input.principal, 'invitation'));
};

const cancelInviteOp: Op<'sales/cancel-invite'> = async (ctx, input) => {
  assertAllowed(await ctx.check(SALES_PERM.memberManage));
  const inv = getRow<InviteRow>(ctx, 'sales_invites', input.principal, 'invitation');
  if (inv.status === 'withdrawn') return inv; // a retry
  if (inv.status === 'arrived') throw substratError('conflict', 'that person has already arrived; an invitation cannot be withdrawn');
  ctx.sql.exec(`UPDATE sales_invites SET status = 'withdrawn', settled_at = ? WHERE id = ?`, [ctx.now(), inv.id]);
  return announce(ctx, 'sales/cancel-invite', getRow<InviteRow>(ctx, 'sales_invites', inv.id, 'invitation'));
};

const listInvitesOp: Op<'sales/list-invites'> = async (ctx, input) => {
  assertAllowed(await ctx.check(SALES_PERM.memberManage));
  const now = ctx.now();
  const page = pageRows<InviteRow>(ctx, 'sales_invites', [], [], input);
  return { ...page, entries: page.entries.map((r) => effective(r, now)) };
};

const listMembersOp: Op<'sales/list-members'> = async (ctx, input) => {
  assertAllowed(await ctx.check(SALES_PERM.crmRead));
  return pageRows<MemberRow>(ctx, 'sales_members', [], [], input);
};

// -------------------------------------------------------------- companies

const createCompanyOp: Op<'sales/create-company'> = async (ctx, input) => {
  assertAllowed(await ctx.check(SALES_PERM.crmWrite));
  const domain = normDomain(input.domain);
  const excluded = exclusionFor(ctx, domain, input.companyName);
  if (excluded) throw substratError('conflict', `excluded: ${excluded.reason}`);
  const rowId = ulid();
  const now = ctx.now();
  ctx.sql.exec(
    `INSERT INTO sales_companies
       (id, name, domain, segment, fit_score, fit_reason, owner_id, source, relationship_context, merged_into, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)`,
    [
      rowId,
      input.companyName,
      domain,
      input.segment ?? null,
      input.fitScore ?? null,
      input.fitReason ?? null,
      ctx.principal,
      input.source ?? null,
      input.relationshipContext ?? null,
      now,
      now,
    ],
  );
  return announce(ctx, 'sales/create-company', getRow<CompanyRow>(ctx, 'sales_companies', rowId, 'company'));
};

const updateCompanyOp: Op<'sales/update-company'> = async (ctx, input) => {
  assertAllowed(await ctx.check(SALES_PERM.crmWrite));
  const c = getRow<CompanyRow>(ctx, 'sales_companies', input.companyId, 'company');
  ctx.sql.exec(
    `UPDATE sales_companies SET name = ?, domain = ?, segment = ?, owner_id = ?, relationship_context = ?,
       fit_score = ?, fit_reason = ?, updated_at = ? WHERE id = ?`,
    [
      input.name ?? c.name,
      input.domain !== undefined ? normDomain(input.domain) : c.domain,
      input.segment ?? c.segment,
      input.ownerId ?? c.owner_id,
      input.relationshipContext ?? c.relationship_context,
      input.fitScore ?? c.fit_score,
      input.fitReason ?? c.fit_reason,
      ctx.now(),
      c.id,
    ],
  );
  return announce(ctx, 'sales/update-company', getRow<CompanyRow>(ctx, 'sales_companies', c.id, 'company'));
};

const listCompaniesOp: Op<'sales/list-companies'> = async (ctx, input) => {
  assertAllowed(await ctx.check(SALES_PERM.crmRead));
  const where = ['merged_into IS NULL'];
  const params: Param[] = [];
  if (input?.q) {
    where.push(`(lower(name) LIKE ? ESCAPE '\\' OR lower(coalesce(domain, '')) LIKE ? ESCAPE '\\')`);
    params.push(likeOf(input.q), likeOf(input.q));
  }
  if (input?.ownerId) {
    where.push('owner_id = ?');
    params.push(input.ownerId);
  }
  return pageRows<CompanyRow>(ctx, 'sales_companies', where, params, input);
};

const getCompanyOp: Op<'sales/get-company'> = async (ctx, input) => {
  assertAllowed(await ctx.check(SALES_PERM.crmRead));
  const company = getRow<CompanyRow>(ctx, 'sales_companies', input.companyId, 'company');
  return {
    company,
    contacts: ctx.sql.query<ContactRow>(
      'SELECT * FROM sales_contacts WHERE company_id = ? ORDER BY id LIMIT 200',
      [company.id],
    ),
    opportunities: ctx.sql.query<OpportunityRow>(
      'SELECT * FROM sales_opportunities WHERE company_id = ? ORDER BY id LIMIT 200',
      [company.id],
    ),
  };
};

// --------------------------------------------------------------- contacts

function insertContact(
  ctx: Ctx,
  c: { companyId: string; name: string; role?: string | undefined; email?: string | undefined; phone?: string | undefined; source?: string | undefined },
): ContactRow {
  const rowId = ulid();
  ctx.sql.exec(
    `INSERT INTO sales_contacts (id, company_id, name, role, email, phone, source, owner_id, opted_out, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?)`,
    [
      rowId,
      c.companyId,
      c.name,
      c.role ?? null,
      c.email ? c.email.toLowerCase() : null,
      c.phone ?? null,
      c.source ?? null,
      ctx.principal,
      ctx.now(),
    ],
  );
  return getRow<ContactRow>(ctx, 'sales_contacts', rowId, 'contact');
}

const createContactOp: Op<'sales/create-contact'> = async (ctx, input) => {
  assertAllowed(await ctx.check(SALES_PERM.crmWrite));
  getRow<CompanyRow>(ctx, 'sales_companies', input.companyId, 'company');
  if (input.email) {
    const taken = ctx.sql.query<ContactRow>('SELECT id FROM sales_contacts WHERE email = ?', [
      input.email.toLowerCase(),
    ])[0];
    if (taken) throw substratError('conflict', `a contact with that email already exists: ${taken.id}`);
  }
  return announce(ctx, 'sales/create-contact', insertContact(ctx, input));
};

const setOptOutOp: Op<'sales/set-opt-out'> = async (ctx, input) => {
  assertAllowed(await ctx.check(SALES_PERM.crmWrite));
  // Opting someone out is open to everyone who writes; lifting it is not.
  if (!input.optedOut) assertAllowed(await ctx.check(SALES_PERM.exclusionLift));
  const c = getRow<ContactRow>(ctx, 'sales_contacts', input.contactId, 'contact');
  ctx.sql.exec('UPDATE sales_contacts SET opted_out = ? WHERE id = ?', [input.optedOut ? 1 : 0, c.id]);
  return announce(ctx, 'sales/set-opt-out', getRow<ContactRow>(ctx, 'sales_contacts', c.id, 'contact'));
};

const listContactsOp: Op<'sales/list-contacts'> = async (ctx, input) => {
  assertAllowed(await ctx.check(SALES_PERM.crmRead));
  const where: string[] = [];
  const params: Param[] = [];
  if (input?.companyId) {
    where.push('company_id = ?');
    params.push(input.companyId);
  }
  return pageRows<ContactRow>(ctx, 'sales_contacts', where, params, input);
};

// ---------------------------------------------------------- opportunities

const createOpportunityOp: Op<'sales/create-opportunity'> = async (ctx, input) => {
  assertAllowed(await ctx.check(SALES_PERM.crmWrite));
  getRow<CompanyRow>(ctx, 'sales_companies', input.companyId, 'company');
  const rowId = ulid();
  const now = ctx.now();
  ctx.sql.exec(
    `INSERT INTO sales_opportunities
       (id, company_id, title, stage, fit_rationale, value_low, value_high, currency, owner_id, next_step, target_date, lost_reason, created_at, updated_at)
     VALUES (?, ?, ?, 'new', ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)`,
    [
      rowId,
      input.companyId,
      input.title,
      input.fitRationale ?? null,
      input.valueLow ?? null,
      input.valueHigh ?? null,
      (input.currency ?? 'EUR').toUpperCase(),
      ctx.principal,
      input.nextStep ?? null,
      input.targetDate ?? null,
      now,
      now,
    ],
  );
  return announce(ctx, 'sales/create-opportunity', getRow<OpportunityRow>(ctx, 'sales_opportunities', rowId, 'opportunity'));
};

const updateOpportunityOp: Op<'sales/update-opportunity'> = async (ctx, input) => {
  assertAllowed(await ctx.check(SALES_PERM.crmWrite));
  const o = getRow<OpportunityRow>(ctx, 'sales_opportunities', input.opportunityId, 'opportunity');
  ctx.sql.exec(
    `UPDATE sales_opportunities SET title = ?, fit_rationale = ?, value_low = ?, value_high = ?, owner_id = ?,
       next_step = ?, target_date = ?, updated_at = ? WHERE id = ?`,
    [
      input.title ?? o.title,
      input.fitRationale ?? o.fit_rationale,
      input.valueLow ?? o.value_low,
      input.valueHigh ?? o.value_high,
      input.ownerId ?? o.owner_id,
      input.nextStep ?? o.next_step,
      input.targetDate ?? o.target_date,
      ctx.now(),
      o.id,
    ],
  );
  return announce(ctx, 'sales/update-opportunity', getRow<OpportunityRow>(ctx, 'sales_opportunities', o.id, 'opportunity'));
};

/** The forward path. `lost` is reachable from any open stage and `won` is the end of it. */
const FORWARD = STAGES.filter((s) => s !== 'lost');

const moveOpportunityOp: Op<'sales/move-opportunity'> = async (ctx, input) => {
  assertAllowed(await ctx.check(SALES_PERM.crmWrite));
  const o = getRow<OpportunityRow>(ctx, 'sales_opportunities', input.opportunityId, 'opportunity');
  if (o.stage === 'won' || o.stage === 'lost') {
    throw substratError('conflict', `opportunity is ${o.stage}; it cannot move`);
  }
  if (input.stage === 'lost') {
    if (!input.lostReason) throw substratError('validation_failed', 'a lost opportunity needs a reason');
  } else {
    const from = FORWARD.indexOf(o.stage as (typeof FORWARD)[number]);
    if (FORWARD[from + 1] !== input.stage) {
      throw substratError('conflict', `cannot move from ${o.stage} to ${input.stage}: stages cannot be skipped`);
    }
  }
  ctx.sql.exec('UPDATE sales_opportunities SET stage = ?, lost_reason = ?, updated_at = ? WHERE id = ?', [
    input.stage,
    input.stage === 'lost' ? (input.lostReason ?? null) : null,
    ctx.now(),
    o.id,
  ]);
  return announce(ctx, 'sales/move-opportunity', getRow<OpportunityRow>(ctx, 'sales_opportunities', o.id, 'opportunity'));
};

const listOpportunitiesOp: Op<'sales/list-opportunities'> = async (ctx, input) => {
  assertAllowed(await ctx.check(SALES_PERM.crmRead));
  const where: string[] = [];
  const params: Param[] = [];
  if (input?.stage) {
    where.push('stage = ?');
    params.push(input.stage);
  }
  if (input?.companyId) {
    where.push('company_id = ?');
    params.push(input.companyId);
  }
  if (input?.ownerId) {
    where.push('owner_id = ?');
    params.push(input.ownerId);
  }
  return pageRows<OpportunityRow>(ctx, 'sales_opportunities', where, params, input);
};

// ----------------------------------------------------------- interactions

const logInteractionOp: Op<'sales/log-interaction'> = async (ctx, input) => {
  assertAllowed(await ctx.check(SALES_PERM.crmWrite));
  getRow<CompanyRow>(ctx, 'sales_companies', input.companyId, 'company');
  if (input.contactId) getRow<ContactRow>(ctx, 'sales_contacts', input.contactId, 'contact');
  if (input.opportunityId) getRow<OpportunityRow>(ctx, 'sales_opportunities', input.opportunityId, 'opportunity');
  const rowId = ulid();
  const now = ctx.now();
  ctx.sql.exec(
    `INSERT INTO sales_interactions
       (id, company_id, contact_id, opportunity_id, kind, direction, summary, customer_quote, generated,
        performed_by_kind, performed_by, occurred_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      rowId,
      input.companyId,
      input.contactId ?? null,
      input.opportunityId ?? null,
      input.kind,
      input.direction ?? null,
      input.summary,
      input.customerQuote ?? null,
      input.generated ? 1 : 0,
      input.generated ? 'agent' : 'person',
      ctx.principal,
      input.occurredAt ?? now,
      now,
    ],
  );
  // Activity keeps a deal from reading as stalled.
  ctx.sql.exec('UPDATE sales_companies SET updated_at = ? WHERE id = ?', [now, input.companyId]);
  if (input.opportunityId) {
    ctx.sql.exec('UPDATE sales_opportunities SET updated_at = ? WHERE id = ?', [now, input.opportunityId]);
  }
  return announce(ctx, 'sales/log-interaction', getRow<InteractionRow>(ctx, 'sales_interactions', rowId, 'interaction'));
};

const listInteractionsOp: Op<'sales/list-interactions'> = async (ctx, input) => {
  assertAllowed(await ctx.check(SALES_PERM.crmRead));
  const where: string[] = [];
  const params: Param[] = [];
  for (const [col, v] of [
    ['company_id', input?.companyId],
    ['contact_id', input?.contactId],
    ['opportunity_id', input?.opportunityId],
  ] as const) {
    if (v) {
      where.push(`${col} = ?`);
      params.push(v);
    }
  }
  return pageRows<InteractionRow>(ctx, 'sales_interactions', where, params, input);
};

// ------------------------------------------------------------------ tasks

const createTaskOp: Op<'sales/create-task'> = async (ctx, input) => {
  assertAllowed(await ctx.check(SALES_PERM.crmWrite));
  if (input.companyId) getRow<CompanyRow>(ctx, 'sales_companies', input.companyId, 'company');
  if (input.opportunityId) getRow<OpportunityRow>(ctx, 'sales_opportunities', input.opportunityId, 'opportunity');
  const rowId = ulid();
  ctx.sql.exec(
    `INSERT INTO sales_tasks (id, company_id, opportunity_id, title, due_date, owner_id, done_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, NULL, ?)`,
    [
      rowId,
      input.companyId ?? null,
      input.opportunityId ?? null,
      input.title,
      input.dueDate,
      input.ownerId ?? ctx.principal,
      ctx.now(),
    ],
  );
  return announce(ctx, 'sales/create-task', getRow<TaskRow>(ctx, 'sales_tasks', rowId, 'task'));
};

const completeTaskOp: Op<'sales/complete-task'> = async (ctx, input) => {
  assertAllowed(await ctx.check(SALES_PERM.crmWrite));
  const t = getRow<TaskRow>(ctx, 'sales_tasks', input.taskId, 'task');
  if (t.done_at) throw substratError('conflict', 'task is already done');
  ctx.sql.exec('UPDATE sales_tasks SET done_at = ? WHERE id = ?', [ctx.now(), t.id]);
  return announce(ctx, 'sales/complete-task', getRow<TaskRow>(ctx, 'sales_tasks', t.id, 'task'));
};

const listTasksOp: Op<'sales/list-tasks'> = async (ctx, input) => {
  assertAllowed(await ctx.check(SALES_PERM.crmRead));
  const where: string[] = [];
  const params: Param[] = [];
  if (input?.open) where.push('done_at IS NULL');
  if (input?.ownerId) {
    where.push('owner_id = ?');
    params.push(input.ownerId);
  }
  return pageRows<TaskRow>(ctx, 'sales_tasks', where, params, input);
};

// ------------------------------------------------------------------ today

const todayOp: Op<'sales/today'> = async (ctx) => {
  assertAllowed(await ctx.check(SALES_PERM.crmRead));
  const now = ctx.now();
  const today = now.slice(0, 10);
  const open = `stage NOT IN ('won', 'lost')`;
  return {
    today,
    stalledAfterDays: STALLED_AFTER_DAYS,
    overdueTasks: ctx.sql.query<TaskRow>(
      'SELECT * FROM sales_tasks WHERE done_at IS NULL AND due_date < ? ORDER BY due_date, id LIMIT 50',
      [today],
    ),
    dueToday: ctx.sql.query<TaskRow>(
      'SELECT * FROM sales_tasks WHERE done_at IS NULL AND due_date = ? ORDER BY id LIMIT 50',
      [today],
    ),
    stalledOpportunities: ctx.sql.query<OpportunityRow>(
      `SELECT * FROM sales_opportunities WHERE ${open}
         AND updated_at < strftime('%Y-%m-%dT%H:%M:%fZ', ?, '-${STALLED_AFTER_DAYS} days')
         ORDER BY updated_at, id LIMIT 50`,
      [now],
    ),
    opportunitiesWithoutNextStep: ctx.sql.query<OpportunityRow>(
      `SELECT * FROM sales_opportunities WHERE ${open} AND next_step IS NULL ORDER BY id LIMIT 50`,
    ),
  };
};

// -------------------------------------------------------------- knowledge

const createKnowledgeOp: Op<'sales/create-knowledge'> = async (ctx, input) => {
  assertAllowed(await ctx.check(SALES_PERM.knowledgeManage));
  if ((input.category === 'positioning' || input.category === 'capability') && !input.claimLabel) {
    throw substratError('validation_failed', `a ${input.category} entry needs a claim label`);
  }
  const rowId = ulid();
  const now = ctx.now();
  ctx.sql.exec(
    `INSERT INTO sales_knowledge
       (id, title, body, category, claim_label, source, source_date, status, created_by, approved_by, approved_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'draft', ?, NULL, NULL, ?, ?)`,
    [
      rowId,
      input.title,
      input.body,
      input.category,
      input.claimLabel ?? null,
      input.source,
      input.sourceDate ?? null,
      ctx.principal,
      now,
      now,
    ],
  );
  return announce(ctx, 'sales/create-knowledge', getRow<KnowledgeRow>(ctx, 'sales_knowledge', rowId, 'knowledge entry'));
};

const updateKnowledgeOp: Op<'sales/update-knowledge'> = async (ctx, input) => {
  assertAllowed(await ctx.check(SALES_PERM.knowledgeManage));
  const k = getRow<KnowledgeRow>(ctx, 'sales_knowledge', input.knowledgeId, 'knowledge entry');
  if (k.status === 'retired') throw substratError('conflict', 'a retired entry cannot be edited');
  ctx.sql.exec(
    `UPDATE sales_knowledge SET title = ?, body = ?, claim_label = ?, source = ?, source_date = ?,
       status = 'draft', approved_by = NULL, approved_at = NULL, updated_at = ? WHERE id = ?`,
    [
      input.title ?? k.title,
      input.body ?? k.body,
      input.claimLabel ?? k.claim_label,
      input.source ?? k.source,
      input.sourceDate ?? k.source_date,
      ctx.now(),
      k.id,
    ],
  );
  return announce(ctx, 'sales/update-knowledge', getRow<KnowledgeRow>(ctx, 'sales_knowledge', k.id, 'knowledge entry'));
};

const approveKnowledgeOp: Op<'sales/approve-knowledge'> = async (ctx, input) => {
  assertAllowed(await ctx.check(SALES_PERM.knowledgeManage));
  const k = getRow<KnowledgeRow>(ctx, 'sales_knowledge', input.knowledgeId, 'knowledge entry');
  if (k.status !== 'draft') throw substratError('conflict', `only a draft can be approved; this one is ${k.status}`);
  const now = ctx.now();
  ctx.sql.exec(
    `UPDATE sales_knowledge SET status = 'approved', approved_by = ?, approved_at = ?, updated_at = ? WHERE id = ?`,
    [ctx.principal, now, now, k.id],
  );
  return announce(ctx, 'sales/approve-knowledge', getRow<KnowledgeRow>(ctx, 'sales_knowledge', k.id, 'knowledge entry'));
};

const retireKnowledgeOp: Op<'sales/retire-knowledge'> = async (ctx, input) => {
  assertAllowed(await ctx.check(SALES_PERM.knowledgeManage));
  const k = getRow<KnowledgeRow>(ctx, 'sales_knowledge', input.knowledgeId, 'knowledge entry');
  ctx.sql.exec(`UPDATE sales_knowledge SET status = 'retired', updated_at = ? WHERE id = ?`, [ctx.now(), k.id]);
  return announce(ctx, 'sales/retire-knowledge', getRow<KnowledgeRow>(ctx, 'sales_knowledge', k.id, 'knowledge entry'));
};

const listKnowledgeOp: Op<'sales/list-knowledge'> = async (ctx, input) => {
  assertAllowed(await ctx.check(SALES_PERM.knowledgeRead));
  const where: string[] = [];
  const params: Param[] = [];
  if (input?.category) {
    where.push('category = ?');
    params.push(input.category);
  }
  if (input?.status) {
    where.push('status = ?');
    params.push(input.status);
  }
  return pageRows<KnowledgeRow>(ctx, 'sales_knowledge', where, params, input);
};

// ------------------------------------------------------------- exclusions

const addExclusionOp: Op<'sales/add-exclusion'> = async (ctx, input) => {
  assertAllowed(await ctx.check(SALES_PERM.exclusionAdd));
  const value = input.kind === 'domain' ? normDomain(input.value) : input.value.trim();
  if (!value) throw substratError('validation_failed', 'the exclusion value is empty');
  const rowId = ulid();
  ctx.sql.exec(
    `INSERT INTO sales_exclusions (id, kind, value, reason, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
    [rowId, input.kind, value, input.reason, ctx.principal, ctx.now()],
  );
  return announce(ctx, 'sales/add-exclusion', getRow<ExclusionRow>(ctx, 'sales_exclusions', rowId, 'exclusion'));
};

const liftExclusionOp: Op<'sales/lift-exclusion'> = async (ctx, input) => {
  assertAllowed(await ctx.check(SALES_PERM.exclusionLift));
  const e = getRow<ExclusionRow>(ctx, 'sales_exclusions', input.exclusionId, 'exclusion');
  ctx.sql.exec('DELETE FROM sales_exclusions WHERE id = ?', [e.id]);
  return announce(ctx, 'sales/lift-exclusion', e);
};

const listExclusionsOp: Op<'sales/list-exclusions'> = async (ctx, input) => {
  assertAllowed(await ctx.check(SALES_PERM.crmRead));
  return pageRows<ExclusionRow>(ctx, 'sales_exclusions', [], [], input);
};

// ----------------------------------------------------------------- import

/** RFC 4180-ish: quoted cells, doubled quotes, CRLF, a leading BOM. Returns rows of cells. */
export function parseCsv(text: string): string[][] {
  const src = text.replace(/^﻿/, '');
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i]!;
    if (quoted) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          cell += '"';
          i++;
        } else quoted = false;
      } else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') {
      row.push(cell);
      cell = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && src[i + 1] === '\n') i++;
      row.push(cell);
      cell = '';
      if (row.some((c) => c.trim() !== '')) rows.push(row);
      row = [];
    } else cell += ch;
  }
  row.push(cell);
  if (row.some((c) => c.trim() !== '')) rows.push(row);
  return rows;
}

const MAX_IMPORT_ROWS = 1000;

const importCsvOp: Op<'sales/import-csv'> = async (ctx, input) => {
  assertAllowed(await ctx.check(SALES_PERM.importRun));
  const table = parseCsv(input.csv);
  if (table.length < 2) throw substratError('validation_failed', 'the CSV needs a header row and at least one row');
  if (table.length - 1 > MAX_IMPORT_ROWS) {
    throw substratError('validation_failed', `at most ${MAX_IMPORT_ROWS} rows per import`);
  }
  const header = table[0]!.map((h) => h.trim().toLowerCase());
  if (!header.includes('company')) throw substratError('validation_failed', 'the CSV needs a "company" column');

  const batchId = ulid();
  const now = ctx.now();
  let created = 0;
  let matched = 0;
  let flagged = 0;
  // The batch row is written first so rows and candidates can reference it; counts are filled in below.
  ctx.sql.exec(
    `INSERT INTO sales_import_batches (id, filename, uploaded_by, row_count, created_count, matched_count, flagged_count, created_at)
     VALUES (?, ?, ?, ?, 0, 0, 0, ?)`,
    [batchId, input.filename, ctx.principal, table.length - 1, now],
  );

  for (let r = 1; r < table.length; r++) {
    const cells = table[r]!;
    const raw: Record<string, string> = {};
    table[0]!.forEach((h, i) => (raw[h.trim()] = cells[i] ?? ''));
    const get = (k: string) => {
      const v = cells[header.indexOf(k)]?.trim();
      return v ? v : undefined;
    };
    const name = get('company');
    const domain = normDomain(get('domain'));
    const email = get('contact_email')?.toLowerCase();
    const contactName = get('contact_name');
    const notes: string[] = [];
    let outcome: 'created' | 'matched' | 'flagged' = 'matched';
    let companyId: string | null = null;
    let contactId: string | null = null;

    if (!name) {
      outcome = 'flagged';
      notes.push('missing company name');
    } else if (exclusionFor(ctx, domain, name)) {
      outcome = 'flagged';
      notes.push(`excluded: ${exclusionFor(ctx, domain, name)!.reason}`);
    } else {
      const byDomain = domain
        ? ctx.sql.query<CompanyRow>('SELECT * FROM sales_companies WHERE domain = ? AND merged_into IS NULL ORDER BY id LIMIT 1', [domain])[0]
        : undefined;
      if (byDomain) {
        companyId = byDomain.id;
        outcome = 'matched';
      } else {
        const byName = ctx.sql.query<CompanyRow>(
          'SELECT * FROM sales_companies WHERE lower(name) = ? AND merged_into IS NULL ORDER BY id LIMIT 1',
          [name.toLowerCase()],
        )[0];
        companyId = ulid();
        const newCompanyId = companyId;
        ctx.sql.exec(
          `INSERT INTO sales_companies
             (id, name, domain, segment, fit_score, fit_reason, owner_id, source, relationship_context, merged_into, created_at, updated_at)
           VALUES (?, ?, ?, ?, NULL, NULL, ?, ?, ?, NULL, ?, ?)`,
          [
            companyId,
            name,
            domain,
            get('segment') ?? null,
            ctx.principal,
            get('source') ?? `import ${input.filename}`,
            get('notes') ?? null,
            now,
            now,
          ],
        );
        announce(ctx, 'sales/create-company', getRow<CompanyRow>(ctx, 'sales_companies', newCompanyId, 'company'));
        outcome = 'created';
        if (byName) {
          // A probable duplicate: both records exist, a person decides. Nothing is merged here.
          const dupId = ulid();
          ctx.sql.exec(
            `INSERT INTO sales_duplicates (id, kind, left_id, right_id, reason, status, batch_id, decided_by, decided_at, snapshot, created_at)
             VALUES (?, 'company', ?, ?, ?, 'open', ?, NULL, NULL, NULL, ?)`,
            [dupId, byName.id, companyId, 'same name, different or missing domain', batchId, now],
          );
          ctx.emit({
            type: 'sales.duplicate-flagged',
            schemaVersion: 1,
            entity: { entityType: 'duplicate', entityId: dupId },
            piiClass: 'none',
            payload: { id: dupId, kind: 'company', left_id: byName.id, right_id: companyId, batch_id: batchId },
          } as Parameters<Ctx['emit']>[0]);
          outcome = 'flagged';
          notes.push('probable duplicate of an existing company');
        }
      }

      if (email || contactName) {
        const existing = email
          ? ctx.sql.query<ContactRow>('SELECT * FROM sales_contacts WHERE email = ?', [email])[0]
          : undefined;
        if (existing) {
          contactId = existing.id;
          if (existing.company_id !== companyId) {
            outcome = 'flagged';
            notes.push('this email is already a contact at another company; left as is');
          }
        } else {
          const c = insertContact(ctx, {
            companyId,
            name: contactName ?? email!,
            role: get('contact_role'),
            email,
            phone: get('contact_phone'),
            source: get('source') ?? `import ${input.filename}`,
          });
          announce(ctx, 'sales/create-contact', c);
          contactId = c.id;
          if (outcome === 'matched') outcome = 'created';
          if (!email) {
            outcome = 'flagged';
            notes.push('contact has no email');
          }
        }
      }
    }

    if (outcome === 'created') created++;
    else if (outcome === 'matched') matched++;
    else flagged++;
    ctx.sql.exec(
      `INSERT INTO sales_import_rows (id, batch_id, row_number, raw, outcome, note, company_id, contact_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [ulid(), batchId, r, JSON.stringify(raw), outcome, notes.join('; ') || null, companyId, contactId],
    );
  }

  ctx.sql.exec('UPDATE sales_import_batches SET created_count = ?, matched_count = ?, flagged_count = ? WHERE id = ?', [
    created,
    matched,
    flagged,
    batchId,
  ]);
  return announce(ctx, 'sales/import-csv', getRow<BatchRow>(ctx, 'sales_import_batches', batchId, 'import'));
};

const listImportRowsOp: Op<'sales/list-import-rows'> = async (ctx, input) => {
  assertAllowed(await ctx.check(SALES_PERM.importRun));
  getRow<BatchRow>(ctx, 'sales_import_batches', input.batchId, 'import');
  const where = ['batch_id = ?'];
  const params: Param[] = [input.batchId];
  if (input.outcome) {
    where.push('outcome = ?');
    params.push(input.outcome);
  }
  return pageRows<ImportRowRow>(ctx, 'sales_import_rows', where, params, input);
};

const listDuplicatesOp: Op<'sales/list-duplicates'> = async (ctx, input) => {
  assertAllowed(await ctx.check(SALES_PERM.duplicateResolve));
  const where: string[] = [];
  const params: Param[] = [];
  if (input?.status) {
    where.push('status = ?');
    params.push(input.status);
  }
  return pageRows<DuplicateRow>(ctx, 'sales_duplicates', where, params, input);
};

const resolveDuplicateOp: Op<'sales/resolve-duplicate'> = async (ctx, input) => {
  assertAllowed(await ctx.check(SALES_PERM.duplicateResolve));
  const d = getRow<DuplicateRow>(ctx, 'sales_duplicates', input.duplicateId, 'duplicate candidate');
  if (d.status !== 'open') throw substratError('conflict', `already decided: ${d.status}`);
  const now = ctx.now();
  if (input.decision === 'keep_both') {
    ctx.sql.exec(`UPDATE sales_duplicates SET status = 'kept_both', decided_by = ?, decided_at = ? WHERE id = ?`, [
      ctx.principal,
      now,
      d.id,
    ]);
    return announce(ctx, 'sales/resolve-duplicate', getRow<DuplicateRow>(ctx, 'sales_duplicates', d.id, 'duplicate candidate'));
  }
  if (!input.survivorId || (input.survivorId !== d.left_id && input.survivorId !== d.right_id)) {
    throw substratError('validation_failed', 'a merge needs survivorId: one of the two records');
  }
  const loserId = input.survivorId === d.left_id ? d.right_id : d.left_id;
  const survivor = getRow<CompanyRow>(ctx, 'sales_companies', input.survivorId, 'company');
  const loser = getRow<CompanyRow>(ctx, 'sales_companies', loserId, 'company');
  if (survivor.merged_into || loser.merged_into) throw substratError('conflict', 'one of the records is already merged');

  const moved = {
    contacts: ctx.sql.exec('UPDATE sales_contacts SET company_id = ? WHERE company_id = ?', [survivor.id, loser.id]).changes,
    opportunities: ctx.sql.exec('UPDATE sales_opportunities SET company_id = ? WHERE company_id = ?', [survivor.id, loser.id]).changes,
    interactions: ctx.sql.exec('UPDATE sales_interactions SET company_id = ? WHERE company_id = ?', [survivor.id, loser.id]).changes,
    tasks: ctx.sql.exec('UPDATE sales_tasks SET company_id = ? WHERE company_id = ?', [survivor.id, loser.id]).changes,
  };
  // The survivor keeps what it has; the loser only fills blanks, and its context is appended, never dropped.
  ctx.sql.exec(
    `UPDATE sales_companies SET domain = ?, segment = ?, fit_score = ?, fit_reason = ?, relationship_context = ?, updated_at = ? WHERE id = ?`,
    [
      survivor.domain ?? loser.domain,
      survivor.segment ?? loser.segment,
      survivor.fit_score ?? loser.fit_score,
      survivor.fit_reason ?? loser.fit_reason,
      [survivor.relationship_context, loser.relationship_context].filter(Boolean).join('\n---\n') || null,
      now,
      survivor.id,
    ],
  );
  ctx.sql.exec('UPDATE sales_companies SET merged_into = ?, updated_at = ? WHERE id = ?', [survivor.id, now, loser.id]);
  // Both companies' timelines show it: the survivor absorbed, the loser merged away.
  announce(ctx, 'sales/update-company', getRow<CompanyRow>(ctx, 'sales_companies', survivor.id, 'company'));
  announce(ctx, 'sales/update-company', getRow<CompanyRow>(ctx, 'sales_companies', loser.id, 'company'));
  ctx.sql.exec(
    `UPDATE sales_duplicates SET status = 'merged', decided_by = ?, decided_at = ?, snapshot = ? WHERE id = ?`,
    [ctx.principal, now, JSON.stringify({ survivorId: survivor.id, loser, moved }), d.id],
  );
  return announce(ctx, 'sales/resolve-duplicate', getRow<DuplicateRow>(ctx, 'sales_duplicates', d.id, 'duplicate candidate'));
};

// ------------------------------------------------------- timeline / audit

const timelineOp: Op<'sales/timeline'> = async (ctx, input) => {
  assertAllowed(await ctx.check(SALES_PERM.crmRead));
  return readTimeline(ctx, { entityType: input.entityType, entityId: input.entityId }, input);
};

const auditOp: Op<'sales/audit'> = async (ctx, input) => {
  assertAllowed(await ctx.check(SALES_PERM.auditRead));
  return readHistory(ctx, { entityType: input.entityType, entityId: input.entityId }, input);
};

// ---------------------------------------------------------------- binding

const bound = operationsFor(salesOperations)({
  'sales/my-permissions': myPermissionsOp,
  'sales/assistant-find-knowledge': assistantFindKnowledgeOp,
  'sales/assistant-find-companies': assistantFindCompaniesOp,
  'sales/assistant-company': assistantCompanyOp,
  'sales/assistant-today': assistantTodayOp,
  'sales/join': joinOp,
  'sales/invite-member': inviteMemberOp,
  'sales/cancel-invite': cancelInviteOp,
  'sales/list-invites': listInvitesOp,
  'sales/register-member': registerMemberOp,
  'sales/list-members': listMembersOp,
  'sales/create-company': createCompanyOp,
  'sales/update-company': updateCompanyOp,
  'sales/list-companies': listCompaniesOp,
  'sales/get-company': getCompanyOp,
  'sales/create-contact': createContactOp,
  'sales/set-opt-out': setOptOutOp,
  'sales/list-contacts': listContactsOp,
  'sales/create-opportunity': createOpportunityOp,
  'sales/update-opportunity': updateOpportunityOp,
  'sales/move-opportunity': moveOpportunityOp,
  'sales/list-opportunities': listOpportunitiesOp,
  'sales/log-interaction': logInteractionOp,
  'sales/list-interactions': listInteractionsOp,
  'sales/create-task': createTaskOp,
  'sales/complete-task': completeTaskOp,
  'sales/list-tasks': listTasksOp,
  'sales/today': todayOp,
  'sales/create-knowledge': createKnowledgeOp,
  'sales/update-knowledge': updateKnowledgeOp,
  'sales/approve-knowledge': approveKnowledgeOp,
  'sales/retire-knowledge': retireKnowledgeOp,
  'sales/list-knowledge': listKnowledgeOp,
  'sales/add-exclusion': addExclusionOp,
  'sales/lift-exclusion': liftExclusionOp,
  'sales/list-exclusions': listExclusionsOp,
  'sales/import-csv': importCsvOp,
  'sales/list-import-rows': listImportRowsOp,
  'sales/list-duplicates': listDuplicatesOp,
  'sales/resolve-duplicate': resolveDuplicateOp,
  'sales/timeline': timelineOp,
  'sales/audit': auditOp,
});

export const salesModule: ModuleRegistration = {
  manifest: salesManifest,
  migrations: salesMigrations,
  ...bound,
};
