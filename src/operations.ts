import { defineEngineRoutes, defineOperations, historyEntry, timelineEntry, z } from '@substrat-run/contracts';
import { assistantOperations } from '@substrat-run/engine-assistant';
import {
  CLAIM_LABELS,
  INTERACTION_KINDS,
  KNOWLEDGE_CATEGORIES,
  MEETING_STATUSES,
  STAGES,
  salesEntities,
} from './entities.js';

// ============================================================================
// The Sales OS DECLARED OPERATION SURFACE — what each operation accepts, what it
// answers with, which permission gates it, and where it lives in the HTTP API.
//
// `src/module.ts` binds its handlers to this object with `operationsFor`, so a
// handler that disagrees with its declaration, an operation declared and not
// implemented, and one implemented and not declared are all compile errors.
// ============================================================================

/**
 * The permission keys an operation here may name. The same array is handed to
 * `definePermissions` in `src/provision.ts`, which throws at module load if it
 * and the manifest disagree in either direction.
 */
export const SALES_PERMISSIONS = [
  'crm:read', // read companies, contacts, opportunities, interactions, tasks, the queue
  'crm:write', // create and edit them, log interactions, move stages
  'import:run', // upload a CSV and read the raw uploaded rows
  'duplicate:resolve', // see and decide duplicate candidates (keep both / merge)
  'knowledge:read', // read the knowledge base
  'knowledge:manage', // write, approve and retire knowledge entries
  'exclusion:add', // add an exclusion
  'exclusion:lift', // lift an exclusion or an opt-out
  'audit:read', // the full audit trail with payloads and authorization chains
  'member:manage', // record who a person is (display name)
  // @substrat-run/engine-assistant
  'assistant:use', // start and read your own conversations
  'assistant:audit', // read other people's conversations (held by nobody in v1)
  'assistant:run', // write the assistant's side; the assistant's system identity only
] as const;

const optText = z.string().min(1).optional();
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'expected YYYY-MM-DD');
const id = z.string().min(1);

/** A raw uploaded CSV row: a TABLE, not an entity (nothing points at one). */
export const importRow = z.object({
  id: z.string(),
  batch_id: z.string(),
  row_number: z.number(),
  raw: z.string(),
  outcome: z.string(),
  note: z.string().nullable(),
  company_id: z.string().nullable(),
  contact_id: z.string().nullable(),
});

const E = salesEntities;

// What the assistant's tools may return. The model provider is a subprocessor of everything it is sent,
// so these shapes are the whole of what leaves: NO contact names, emails or phones, NO interaction
// summaries or customer quotes, NO relationship context (free text that names people), NO owner ids.
const aiCompany = z.object({
  id: z.string(), name: z.string(), domain: z.string().nullable(), segment: z.string().nullable(),
  fit_score: z.number().nullable(), fit_reason: z.string().nullable(), source: z.string().nullable(),
});
const aiOpportunity = z.object({
  id: z.string(), company_id: z.string(), title: z.string(), stage: z.string(), fit_rationale: z.string().nullable(),
  value_low: z.string().nullable(), value_high: z.string().nullable(), currency: z.string(),
  next_step: z.string().nullable(), target_date: z.string().nullable(), lost_reason: z.string().nullable(),
});
const aiKnowledge = z.object({
  id: z.string(), title: z.string(), body: z.string(), category: z.string(),
  claim_label: z.string().nullable(), source: z.string(), source_date: z.string().nullable(),
});

export const salesOperations = defineOperations(E, SALES_PERMISSIONS)({
  // ----------------------------------------------------------------- self
  'sales/my-permissions': {
    summary: 'Which of this workspace’s permissions the caller holds, so a screen can hide what they cannot do',
    // No single permission gates this: anyone signed in may ask what THEY may do. Stated, not omitted.
    narrows: {
      reason: 'a caller learns only their own permissions; the answer is each check the caller already passes or fails',
      checks: [],
    },
    output: z.object({ permissions: z.array(z.string()) }),
    http: { method: 'GET', path: '/my-permissions' },
  },
  'sales/whoami': {
    summary: 'The caller’s own principal id, which the worker needs to ask the file store for a recording AS that person',
    // No permission gates this: it returns the caller's own id, which the kernel put on the stub. No http: a route calls it.
    narrows: {
      reason: 'a caller learns only their own id, which the kernel stamped on the stub that asked',
      checks: [],
    },
    output: z.object({ principal: z.string() }),
  },

  // ------------------------------------------------- the assistant's tools
  // Read-only, run AS THE PERSON ASKING (the host calls them on that person's stub), gated by the same
  // permissions as the screens, and returning only the personal-data-free shapes above.
  'sales/assistant-find-knowledge': {
    summary: 'Assistant tool: APPROVED knowledge entries matching a question. Drafts and retired entries are never returned',
    permission: 'knowledge:read',
    input: z.object({ query: z.string().min(1).max(200), category: z.enum(KNOWLEDGE_CATEGORIES).optional() }),
    output: z.object({ entries: z.array(aiKnowledge) }),
  },
  'sales/assistant-find-companies': {
    summary: 'Assistant tool: companies matching a name, domain or segment',
    permission: 'crm:read',
    input: z.object({ query: z.string().min(1).max(100) }),
    output: z.object({ entries: z.array(aiCompany) }),
  },
  'sales/assistant-company': {
    summary: 'Assistant tool: one company and its opportunities (no contacts, no interactions)',
    permission: 'crm:read',
    input: z.object({ companyId: id }),
    output: z.object({ company: aiCompany, opportunities: z.array(aiOpportunity) }),
  },
  'sales/assistant-today': {
    summary: 'Assistant tool: stalled opportunities, opportunities without a next step, and task counts',
    permission: 'crm:read',
    output: z.object({
      today: z.string(), stalledAfterDays: z.number(),
      stalledOpportunities: z.array(aiOpportunity), opportunitiesWithoutNextStep: z.array(aiOpportunity),
      overdueTaskCount: z.number(), dueTodayTaskCount: z.number(),
    }),
  },

  // ------------------------------------------------------------ team invitations
  // The sign-in door calls these AS THE INVITER, around its own routes (`POST /api/member-invites` and its
  // withdrawal). The platform mints the invited principal and enforces that an admin can never invite someone to
  // more than the admin holds; these only record the invitation so Settings can show it. They grant nothing.
  'sales/invite-member': {
    summary: 'Record an invitation to join this workspace with a role. Called by the sign-in door; grants nothing itself',
    permission: 'member:manage',
    input: z.object({
      principal: id,
      email: z.string().min(3).max(254),
      roleKey: z.enum(['sales-admin', 'sales-member']),
      expiresAt: z.string().min(10),
    }),
    output: E.invite.fields,
    emits: {
      entity: 'invite',
      entityIdFrom: 'id',
      type: 'sales.invite-created',
      schemaVersion: 1,
      piiClass: 'none',
      payload: ['id', 'role_key', 'invited_by', 'status', 'expires_at'],
    },
  },
  'sales/cancel-invite': {
    summary: 'Withdraw an open invitation. Called by the sign-in door; withdrawing twice is not an error',
    permission: 'member:manage',
    input: z.object({ principal: id }),
    output: E.invite.fields,
    emits: {
      entity: 'invite',
      entityIdFrom: 'id',
      type: 'sales.invite-withdrawn',
      schemaVersion: 1,
      piiClass: 'none',
      payload: ['id', 'role_key', 'status'],
    },
  },
  'sales/list-invites': {
    summary: 'Invitations to join this workspace, with whether each is still open, expired, withdrawn, or the person has arrived',
    permission: 'member:manage',
    output: E.invite.fields,
    paged: { sortKey: 'id' },
    http: { method: 'GET', path: '/team/invites' },
  },

  // ------------------------------------------------------------ members
  'sales/join': {
    summary: 'Record the caller as a member of this workspace: their own display name, and the address their issuer verified',
    // Run by the sign-in door the first time a person reaches the workspace, and again on a new isolate, so it
    // returns the row it already wrote. Every role holds `crm:read`, so a colleague an admin added is never
    // refused at the door; and a person can only ever write THEIR OWN row (the id is the caller's), so this
    // grants nothing and widens no one's access.
    permission: 'crm:read',
    input: z.object({ displayName: z.string().min(1).max(200) }),
    output: E.member.fields,
    emits: {
      entity: 'member',
      entityIdFrom: 'id',
      type: 'sales.member-registered',
      schemaVersion: 1,
      piiClass: 'none',
      payload: ['id'],
    },
  },
  'sales/register-member': {
    summary: 'Record who a person is: the display name shown wherever they own or change something',
    permission: 'member:manage',
    input: z.object({ principalId: id, displayName: z.string().min(1), email: optText }),
    output: E.member.fields,
    emits: {
      entity: 'member',
      entityIdFrom: 'id',
      type: 'sales.member-registered',
      schemaVersion: 1,
      piiClass: 'none',
      payload: ['id'],
    },
    http: { method: 'POST', path: '/members' },
  },
  'sales/list-members': {
    summary: 'The people in this workspace',
    permission: 'crm:read',
    output: E.member.fields,
    paged: { sortKey: 'id' },
    http: { method: 'GET', path: '/members' },
  },

  // ---------------------------------------------------------- companies
  'sales/create-company': {
    summary: 'Add a company',
    permission: 'crm:write',
    input: z.object({
      companyName: z.string().min(1),
      domain: optText,
      segment: optText,
      // Every company records where it came from: the brief asks for source on every record.
      source: z.string().min(1),
      relationshipContext: optText,
      fitScore: z.number().int().min(0).max(100).optional(),
      fitReason: optText,
    }),
    output: E.company.fields,
    emits: {
      entity: 'company',
      entityIdFrom: 'id',
      type: 'sales.company-created',
      schemaVersion: 1,
      piiClass: 'none',
      payload: ['id', 'name', 'domain', 'segment', 'source', 'owner_id'],
    },
    http: { method: 'POST', path: '/companies' },
  },
  'sales/update-company': {
    summary: 'Change a company’s details, owner, fit score or relationship context',
    permission: 'crm:write',
    input: z.object({
      companyId: id,
      name: optText,
      domain: optText,
      segment: optText,
      ownerId: optText,
      relationshipContext: optText,
      fitScore: z.number().int().min(0).max(100).optional(),
      fitReason: optText,
    }),
    output: E.company.fields,
    concurrency: { over: 'company', idFrom: 'companyId' },
    emits: {
      entity: 'company',
      entityIdFrom: 'id',
      type: 'sales.company-updated',
      schemaVersion: 1,
      piiClass: 'none',
      payload: ['id', 'name', 'domain', 'segment', 'owner_id', 'fit_score'],
    },
    http: { method: 'POST', path: '/companies/{companyId}/update' },
  },
  'sales/list-companies': {
    summary: 'Companies, searchable by name or domain; merged-away records are left out',
    permission: 'crm:read',
    input: z.object({ q: optText, ownerId: optText }),
    inputOptional: true,
    output: E.company.fields,
    paged: { sortKey: 'id' },
    http: { method: 'GET', path: '/companies' },
  },
  'sales/get-company': {
    summary: 'One company with its contacts and opportunities',
    permission: 'crm:read',
    input: z.object({ companyId: id }),
    output: z.object({
      company: E.company.fields,
      contacts: z.array(E.contact.fields),
      opportunities: z.array(E.opportunity.fields),
    }),
    // A read: it hands back the ETag an edit then sends as If-Match.
    concurrency: { over: 'company', idFrom: 'companyId' },
    http: { method: 'GET', path: '/companies/{companyId}' },
  },

  // ----------------------------------------------------------- contacts
  'sales/create-contact': {
    summary: 'Add a contact to a company',
    permission: 'crm:write',
    input: z.object({
      companyId: id,
      name: z.string().min(1),
      role: optText,
      email: optText,
      phone: optText,
      source: optText,
    }),
    output: E.contact.fields,
    emits: {
      entity: 'contact',
      entityIdFrom: 'id',
      type: 'sales.contact-created',
      schemaVersion: 1,
      piiClass: 'none',
      payload: ['id', 'company_id', 'role', 'source', 'owner_id'],
    },
    http: { method: 'POST', path: '/contacts' },
  },
  'sales/set-opt-out': {
    summary: 'Mark a contact as opted out. Lifting an opt-out needs the exclusion:lift permission',
    permission: 'crm:write',
    input: z.object({ contactId: id, optedOut: z.boolean() }),
    output: E.contact.fields,
    emits: {
      entity: 'contact',
      entityIdFrom: 'id',
      type: 'sales.contact-opt-out-changed',
      schemaVersion: 1,
      piiClass: 'none',
      payload: ['id', 'company_id', 'opted_out'],
    },
    http: { method: 'POST', path: '/contacts/{contactId}/opt-out' },
  },
  'sales/list-contacts': {
    summary: 'Contacts, optionally for one company',
    permission: 'crm:read',
    input: z.object({ companyId: optText }),
    inputOptional: true,
    output: E.contact.fields,
    paged: { sortKey: 'id' },
    http: { method: 'GET', path: '/contacts' },
  },

  // ------------------------------------------------------ opportunities
  'sales/create-opportunity': {
    summary: 'Open an opportunity on a company. A company can have several',
    permission: 'crm:write',
    input: z.object({
      companyId: id,
      title: z.string().min(1),
      fitRationale: optText,
      valueLow: z.string().regex(/^\d+(\.\d+)?$/).optional(),
      valueHigh: z.string().regex(/^\d+(\.\d+)?$/).optional(),
      currency: z.string().length(3).optional(),
      nextStep: optText,
      targetDate: isoDate.optional(),
    }),
    output: E.opportunity.fields,
    emits: {
      entity: 'opportunity',
      entityIdFrom: 'id',
      type: 'sales.opportunity-created',
      schemaVersion: 1,
      piiClass: 'none',
      payload: ['id', 'company_id', 'title', 'stage', 'owner_id'],
    },
    http: { method: 'POST', path: '/opportunities' },
  },
  'sales/update-opportunity': {
    summary: 'Change an opportunity’s details: owner, value range, next step, target date',
    permission: 'crm:write',
    input: z.object({
      opportunityId: id,
      title: optText,
      fitRationale: optText,
      valueLow: z.string().regex(/^\d+(\.\d+)?$/).optional(),
      valueHigh: z.string().regex(/^\d+(\.\d+)?$/).optional(),
      ownerId: optText,
      nextStep: optText,
      targetDate: isoDate.optional(),
    }),
    output: E.opportunity.fields,
    concurrency: { over: 'opportunity', idFrom: 'opportunityId' },
    emits: {
      entity: 'opportunity',
      entityIdFrom: 'id',
      type: 'sales.opportunity-updated',
      schemaVersion: 1,
      piiClass: 'none',
      payload: ['id', 'company_id', 'title', 'owner_id', 'next_step', 'target_date'],
    },
    http: { method: 'POST', path: '/opportunities/{opportunityId}/update' },
  },
  'sales/move-opportunity': {
    summary: 'Move an opportunity to any other stage (forward, back or reopened). Lost needs a reason',
    permission: 'crm:write',
    input: z.object({ opportunityId: id, stage: z.enum(STAGES), lostReason: optText }),
    output: E.opportunity.fields,
    emits: {
      entity: 'opportunity',
      entityIdFrom: 'id',
      type: 'sales.opportunity-stage-changed',
      schemaVersion: 1,
      piiClass: 'none',
      payload: ['id', 'company_id', 'stage', 'lost_reason'],
    },
    http: { method: 'POST', path: '/opportunities/{opportunityId}/move' },
  },
  'sales/get-opportunity': {
    summary: 'One opportunity. The ETag it answers with is what an edit sends back as If-Match',
    permission: 'crm:read',
    derive: 'get',
    input: z.object({ opportunityId: id }),
    output: E.opportunity.fields,
    concurrency: { over: 'opportunity', idFrom: 'opportunityId' },
    http: { method: 'GET', path: '/opportunities/{opportunityId}' },
  },
  'sales/list-opportunities': {
    summary: 'The pipeline: opportunities, optionally for one stage or company',
    permission: 'crm:read',
    input: z.object({ stage: z.enum(STAGES).optional(), companyId: optText, ownerId: optText }),
    inputOptional: true,
    output: E.opportunity.fields,
    paged: { sortKey: 'id' },
    http: { method: 'GET', path: '/opportunities' },
  },

  // ----------------------------------------------------------- meetings
  'sales/create-meeting': {
    summary: 'Schedule a meeting with a company, optionally about one opportunity',
    permission: 'crm:write',
    input: z.object({
      companyId: id,
      opportunityId: optText,
      title: z.string().min(1),
      startsAt: z.string().min(16),
      durationMin: z.number().int().min(5).max(600).optional(),
      location: optText,
      attendees: optText,
      agenda: optText,
    }),
    output: E.meeting.fields,
    emits: {
      entity: 'meeting',
      entityIdFrom: 'id',
      type: 'sales.meeting-scheduled',
      schemaVersion: 1,
      piiClass: 'none',
      payload: ['id', 'company_id', 'opportunity_id', 'title', 'starts_at', 'status', 'owner_id'],
    },
    http: { method: 'POST', path: '/meetings' },
  },
  'sales/update-meeting': {
    summary: 'Change a meeting’s details: title, time, length, place, attendees, agenda',
    permission: 'crm:write',
    input: z.object({
      meetingId: id,
      title: optText,
      startsAt: z.string().min(16).optional(),
      durationMin: z.number().int().min(5).max(600).optional(),
      location: optText,
      attendees: optText,
      agenda: optText,
    }),
    output: E.meeting.fields,
    concurrency: { over: 'meeting', idFrom: 'meetingId' },
    emits: {
      entity: 'meeting',
      entityIdFrom: 'id',
      type: 'sales.meeting-updated',
      schemaVersion: 1,
      piiClass: 'none',
      payload: ['id', 'company_id', 'title', 'starts_at', 'status'],
    },
    http: { method: 'POST', path: '/meetings/{meetingId}/update' },
  },
  'sales/set-meeting-status': {
    summary: 'Mark a meeting held or cancelled, or schedule a cancelled one again. A cancelled meeting is not held',
    permission: 'crm:write',
    input: z.object({ meetingId: id, status: z.enum(MEETING_STATUSES) }),
    output: E.meeting.fields,
    emits: {
      entity: 'meeting',
      entityIdFrom: 'id',
      type: 'sales.meeting-status-changed',
      schemaVersion: 1,
      piiClass: 'none',
      payload: ['id', 'company_id', 'status'],
    },
    http: { method: 'POST', path: '/meetings/{meetingId}/status' },
  },
  'sales/get-meeting': {
    summary: 'One meeting. The ETag it answers with is what an edit sends back as If-Match',
    permission: 'crm:read',
    derive: 'get',
    input: z.object({ meetingId: id }),
    output: E.meeting.fields,
    concurrency: { over: 'meeting', idFrom: 'meetingId' },
    http: { method: 'GET', path: '/meetings/{meetingId}' },
  },
  'sales/list-meetings': {
    summary: 'Meetings, optionally for one company or opportunity, or starting within a window',
    permission: 'crm:read',
    input: z.object({ companyId: optText, opportunityId: optText, from: optText, to: optText }),
    inputOptional: true,
    output: E.meeting.fields,
    paged: { sortKey: 'id' },
    http: { method: 'GET', path: '/meetings' },
  },
  'sales/start-recording': {
    summary: 'Confirm everyone agreed to be recorded and get a single-use link the browser uploads the audio to',
    permission: 'crm:write',
    // A boolean the handler insists is true, NOT `z.literal(true)`: the route table pins a literal input itself, which would let
    // a request that never mentioned consent through.
    input: z.object({ meetingId: id, consent: z.boolean() }),
    output: z.object({ url: z.string(), expiresAt: z.string(), maxBytes: z.number() }),
    // Emits `sales.recording-started` itself (its payload is the consent, not the answer), listed in the manifest.
    http: { method: 'POST', path: '/meetings/{meetingId}/recordings' },
  },

  // ---------------------------------------------------------- transcripts
  'sales/open-transcription': {
    summary: 'Check the caller may transcribe this meeting’s audio. The clip route calls it before it sends audio to the model',
    permission: 'crm:write',
    input: z.object({ meetingId: id }),
    output: z.object({ ok: z.literal(true) }),
  },
  'sales/save-transcript': {
    summary: 'Save the transcript of a meeting (or one of its recordings), as timed passages',
    permission: 'crm:write',
    input: z.object({
      meetingId: id,
      recordingId: optText,
      language: z.string().min(2).max(8).optional(),
      segments: z.array(z.object({ startMs: z.number().int().min(0), endMs: z.number().int().min(0), text: z.string().min(1).max(4000) })).min(1).max(5000),
    }),
    output: z.object({ saved: z.number() }),
    // Emits `sales.transcript-saved` itself (the count, never the words), listed in the manifest.
    http: { method: 'POST', path: '/meetings/{meetingId}/transcript' },
  },
  'sales/update-transcript-segment': {
    summary: 'Correct the wording of one passage of a transcript. The passage is marked as corrected by a person',
    permission: 'crm:write',
    input: z.object({ segmentId: id, text: z.string().min(1).max(4000) }),
    output: E.transcript_segment.fields,
    emits: {
      entity: 'transcript_segment',
      entityIdFrom: 'id',
      type: 'sales.transcript-corrected',
      schemaVersion: 1,
      piiClass: 'none',
      payload: ['id', 'meeting_id', 'corrected_by', 'corrected_at'],
    },
    http: { method: 'POST', path: '/transcript/{segmentId}/update' },
  },
  'sales/list-transcript': {
    summary: 'The passages of a meeting’s transcript, in the order spoken',
    permission: 'crm:read',
    input: z.object({ meetingId: id }),
    output: E.transcript_segment.fields,
    paged: { sortKey: 'id' },
    http: { method: 'GET', path: '/meetings/{meetingId}/transcript' },
  },

  // ------------------------------------------------------- interactions
  'sales/log-interaction': {
    summary: 'Log an email, call, meeting or note. A customer quote is stored apart from the summary',
    permission: 'crm:write',
    input: z.object({
      companyId: id,
      contactId: optText,
      opportunityId: optText,
      kind: z.enum(INTERACTION_KINDS),
      direction: z.enum(['inbound', 'outbound']).optional(),
      summary: z.string().min(1),
      customerQuote: optText,
      generated: z.boolean().optional(),
      occurredAt: z.string().min(10).optional(),
    }),
    output: E.interaction.fields,
    emits: {
      entity: 'interaction',
      entityIdFrom: 'id',
      type: 'sales.interaction-logged',
      schemaVersion: 1,
      piiClass: 'none',
      payload: ['id', 'company_id', 'contact_id', 'opportunity_id', 'kind', 'direction', 'generated', 'performed_by'],
    },
    http: { method: 'POST', path: '/interactions' },
  },
  'sales/list-interactions': {
    summary: 'Interactions, optionally for one company, contact or opportunity',
    permission: 'crm:read',
    input: z.object({ companyId: optText, contactId: optText, opportunityId: optText }),
    inputOptional: true,
    output: E.interaction.fields,
    paged: { sortKey: 'id' },
    http: { method: 'GET', path: '/interactions' },
  },

  // -------------------------------------------------------------- tasks
  'sales/create-task': {
    summary: 'Add a follow-up task with a due date',
    permission: 'crm:write',
    input: z.object({
      title: z.string().min(1),
      dueDate: isoDate,
      companyId: optText,
      opportunityId: optText,
      ownerId: optText,
    }),
    output: E.task.fields,
    emits: {
      entity: 'task',
      entityIdFrom: 'id',
      type: 'sales.task-created',
      schemaVersion: 1,
      piiClass: 'none',
      payload: ['id', 'company_id', 'opportunity_id', 'due_date', 'owner_id'],
    },
    http: { method: 'POST', path: '/tasks' },
  },
  'sales/complete-task': {
    summary: 'Mark a task done',
    permission: 'crm:write',
    input: z.object({ taskId: id }),
    output: E.task.fields,
    emits: {
      entity: 'task',
      entityIdFrom: 'id',
      type: 'sales.task-completed',
      schemaVersion: 1,
      piiClass: 'none',
      payload: ['id', 'done_at'],
    },
    http: { method: 'POST', path: '/tasks/{taskId}/complete' },
  },
  'sales/list-tasks': {
    summary: 'Tasks, optionally only the open ones',
    permission: 'crm:read',
    input: z.object({ open: z.boolean().optional(), ownerId: optText }),
    inputOptional: true,
    output: E.task.fields,
    paged: { sortKey: 'id' },
    http: { method: 'GET', path: '/tasks' },
  },

  // -------------------------------------------------------------- today
  'sales/today': {
    summary: 'The daily work queue: overdue tasks, tasks due today, and stalled opportunities',
    permission: 'crm:read',
    output: z.object({
      today: z.string(),
      stalledAfterDays: z.number(),
      overdueTasks: z.array(E.task.fields),
      dueToday: z.array(E.task.fields),
      stalledOpportunities: z.array(E.opportunity.fields),
      opportunitiesWithoutNextStep: z.array(E.opportunity.fields),
    }),
    http: { method: 'GET', path: '/today' },
  },

  // ---------------------------------------------------------- knowledge
  'sales/create-knowledge': {
    summary: 'Write a draft knowledge entry. Positioning and capability entries need a claim label',
    permission: 'knowledge:manage',
    input: z.object({
      title: z.string().min(1),
      body: z.string().min(1),
      category: z.enum(KNOWLEDGE_CATEGORIES),
      claimLabel: z.enum(CLAIM_LABELS).optional(),
      source: z.string().min(1),
      sourceDate: isoDate.optional(),
    }),
    output: E.knowledge.fields,
    emits: {
      entity: 'knowledge',
      entityIdFrom: 'id',
      type: 'sales.knowledge-created',
      schemaVersion: 1,
      piiClass: 'none',
      payload: ['id', 'title', 'category', 'claim_label', 'status', 'created_by'],
    },
    http: { method: 'POST', path: '/knowledge' },
  },
  'sales/update-knowledge': {
    summary: 'Edit a knowledge entry. Editing an approved entry sends it back to draft',
    permission: 'knowledge:manage',
    input: z.object({
      knowledgeId: id,
      title: optText,
      body: optText,
      claimLabel: z.enum(CLAIM_LABELS).optional(),
      source: optText,
      sourceDate: isoDate.optional(),
    }),
    output: E.knowledge.fields,
    concurrency: { over: 'knowledge', idFrom: 'knowledgeId' },
    emits: {
      entity: 'knowledge',
      entityIdFrom: 'id',
      type: 'sales.knowledge-updated',
      schemaVersion: 1,
      piiClass: 'none',
      payload: ['id', 'title', 'category', 'claim_label', 'status'],
    },
    http: { method: 'POST', path: '/knowledge/{knowledgeId}/update' },
  },
  'sales/approve-knowledge': {
    summary: 'Approve a draft entry so the agent may rely on it',
    permission: 'knowledge:manage',
    input: z.object({ knowledgeId: id }),
    output: E.knowledge.fields,
    emits: {
      entity: 'knowledge',
      entityIdFrom: 'id',
      type: 'sales.knowledge-approved',
      schemaVersion: 1,
      piiClass: 'none',
      payload: ['id', 'status', 'approved_by', 'approved_at'],
    },
    http: { method: 'POST', path: '/knowledge/{knowledgeId}/approve' },
  },
  'sales/retire-knowledge': {
    summary: 'Retire an entry: it stays on record but is no longer to be relied on',
    permission: 'knowledge:manage',
    input: z.object({ knowledgeId: id }),
    output: E.knowledge.fields,
    emits: {
      entity: 'knowledge',
      entityIdFrom: 'id',
      type: 'sales.knowledge-retired',
      schemaVersion: 1,
      piiClass: 'none',
      payload: ['id', 'status'],
    },
    http: { method: 'POST', path: '/knowledge/{knowledgeId}/retire' },
  },
  'sales/get-knowledge': {
    summary: 'One knowledge entry. The ETag it answers with is what an edit sends back as If-Match',
    permission: 'knowledge:read',
    derive: 'get',
    input: z.object({ knowledgeId: id }),
    output: E.knowledge.fields,
    concurrency: { over: 'knowledge', idFrom: 'knowledgeId' },
    http: { method: 'GET', path: '/knowledge/{knowledgeId}' },
  },
  'sales/list-knowledge': {
    summary: 'The knowledge base, optionally by category or status',
    permission: 'knowledge:read',
    input: z.object({
      category: z.enum(KNOWLEDGE_CATEGORIES).optional(),
      status: z.enum(['draft', 'approved', 'retired']).optional(),
    }),
    inputOptional: true,
    output: E.knowledge.fields,
    paged: { sortKey: 'id' },
    http: { method: 'GET', path: '/knowledge' },
  },

  // --------------------------------------------------------- exclusions
  'sales/add-exclusion': {
    summary: 'Add a company or domain we must not contact',
    permission: 'exclusion:add',
    input: z.object({ kind: z.enum(['domain', 'company']), value: z.string().min(1), reason: z.string().min(1) }),
    output: E.exclusion.fields,
    emits: {
      entity: 'exclusion',
      entityIdFrom: 'id',
      type: 'sales.exclusion-added',
      schemaVersion: 1,
      piiClass: 'none',
      payload: ['id', 'kind', 'value', 'created_by'],
    },
    http: { method: 'POST', path: '/exclusions' },
  },
  'sales/lift-exclusion': {
    summary: 'Lift an exclusion',
    permission: 'exclusion:lift',
    input: z.object({ exclusionId: id }),
    output: E.exclusion.fields,
    emits: {
      entity: 'exclusion',
      entityIdFrom: 'id',
      type: 'sales.exclusion-lifted',
      schemaVersion: 1,
      piiClass: 'none',
      payload: ['id', 'kind', 'value'],
    },
    http: { method: 'POST', path: '/exclusions/{exclusionId}/lift' },
  },
  'sales/list-exclusions': {
    summary: 'Everything we must not contact',
    permission: 'crm:read',
    output: E.exclusion.fields,
    paged: { sortKey: 'id' },
    http: { method: 'GET', path: '/exclusions' },
  },

  // ------------------------------------------------------------- import
  'sales/import-csv': {
    summary:
      'Import companies and contacts from CSV text. Rows are matched, never silently merged; unclear ones are flagged',
    permission: 'import:run',
    input: z.object({ filename: z.string().min(1), csv: z.string().min(1).max(500_000) }),
    output: E.import_batch.fields,
    emits: {
      entity: 'import_batch',
      entityIdFrom: 'id',
      type: 'sales.import-completed',
      schemaVersion: 1,
      piiClass: 'none',
      payload: ['id', 'filename', 'row_count', 'created_count', 'matched_count', 'flagged_count', 'uploaded_by'],
    },
    http: { method: 'POST', path: '/imports' },
  },
  'sales/list-import-rows': {
    summary: 'The raw rows of one import, exactly as uploaded, with what happened to each',
    permission: 'import:run',
    input: z.object({ batchId: id, outcome: z.enum(['created', 'matched', 'flagged']).optional() }),
    output: importRow,
    paged: { sortKey: 'id' },
    http: { method: 'GET', path: '/imports/{batchId}/rows' },
  },
  'sales/list-duplicates': {
    summary: 'Duplicate candidates awaiting a human decision',
    permission: 'duplicate:resolve',
    input: z.object({ status: z.enum(['open', 'kept_both', 'merged']).optional() }),
    inputOptional: true,
    output: E.duplicate.fields,
    paged: { sortKey: 'id' },
    http: { method: 'GET', path: '/duplicates' },
  },
  'sales/resolve-duplicate': {
    summary:
      'Decide a duplicate candidate: keep both, or merge one company into the other (nothing is deleted)',
    permission: 'duplicate:resolve',
    input: z.object({
      duplicateId: id,
      decision: z.enum(['keep_both', 'merge']),
      survivorId: optText,
    }),
    output: E.duplicate.fields,
    emits: {
      entity: 'duplicate',
      entityIdFrom: 'id',
      type: 'sales.duplicate-resolved',
      schemaVersion: 1,
      piiClass: 'none',
      payload: ['id', 'kind', 'left_id', 'right_id', 'status', 'decided_by'],
    },
    http: { method: 'POST', path: '/duplicates/{duplicateId}/resolve' },
  },

  // ------------------------------------------------------ timeline / audit
  'sales/timeline': {
    summary: 'What changed on one record, and who or what changed it',
    permission: 'crm:read',
    input: z.object({
      entityType: z.enum(['company', 'contact', 'opportunity', 'task', 'knowledge']),
      entityId: id,
    }),
    output: timelineEntry,
    paged: { sortKey: 'id' },
    http: { method: 'GET', path: '/timeline/{entityType}/{entityId}' },
  },
  'sales/audit': {
    summary: 'The full audit trail of one record: payloads, the permission that allowed each change, the grant behind it',
    permission: 'audit:read',
    input: z.object({
      entityType: z.enum(['company', 'contact', 'opportunity', 'interaction', 'task', 'knowledge', 'exclusion', 'duplicate', 'meeting', 'transcript_segment']),
      entityId: id,
    }),
    output: historyEntry,
    paged: { sortKey: 'id' },
    http: { method: 'GET', path: '/audit/{entityType}/{entityId}' },
  },
});


/**
 * Where the assistant engine's person-facing operations live in this vertical's API. An engine declares
 * no `http`: this app decides the paths. The host-only operations (`acquire-run`, `release-run`,
 * `append-events`, `claim-execution`) are deliberately NOT bound: they need `assistant:run`, which no
 * person holds, and are called only by `src/assistant-host.ts` through the system door.
 */
export const assistantRoutes = defineEngineRoutes(assistantOperations)({
  'assistant/create-thread': { method: 'POST', path: '/assistant/threads' },
  'assistant/list-threads': { method: 'GET', path: '/assistant/threads' },
  'assistant/get-thread': { method: 'GET', path: '/assistant/threads/{threadId}' },
  'assistant/read-events': { method: 'GET', path: '/assistant/threads/{threadId}/events' },
  'assistant/send-message': { method: 'POST', path: '/assistant/threads/{threadId}/messages' },
  'assistant/resolve-approval': { method: 'POST', path: '/assistant/threads/{threadId}/approvals' },
  'assistant/close-thread': { method: 'POST', path: '/assistant/threads/{threadId}/close' },
});
