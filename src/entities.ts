import { defineEntities, z } from '@substrat-run/contracts';

// ============================================================================
// The Sales OS ENTITY REGISTRY — what this vertical declares exists.
//
// Field names mirror the SQL columns verbatim, snake_case included. They are the
// row shape as `ctx.sql` returns it, and `test/entities.test.ts` holds each one
// to the table that `src/migrations.ts` creates.
//
// NOT every table is an entity. `sales_import_rows` (the raw uploaded rows,
// preserved exactly as they arrived) is a table: nothing points AT one, so it
// is absent here and its shape lives beside the operation that returns it.
//
// Every free-text column a person typed that may be personal data is `erasable`,
// which is what keeps it out of an event payload: an immutable event is the one
// place in a scope an erasure cannot reach.
// ============================================================================

export const STAGES = ['new', 'contacted', 'in_conversation', 'meeting_held', 'proposal', 'won', 'lost'] as const;
export const CLAIM_LABELS = ['shipped', 'built_unproven', 'bet'] as const;
export const KNOWLEDGE_CATEGORIES = [
  'positioning',
  'capability',
  'icp',
  'pricing',
  'collateral',
  'security',
  'faq',
  'case',
  'relationship',
] as const;
export const MEETING_STATUSES = ['scheduled', 'held', 'cancelled'] as const;
export const INTERACTION_KINDS = ['email', 'call', 'meeting', 'note'] as const;

export const salesEntities = defineEntities({
  company: {
    table: 'sales_companies',
    fields: z.object({
      id: z.string(),
      name: z.string(),
      domain: z.string().nullable(),
      segment: z.string().nullable(),
      fit_score: z.number().nullable(),
      fit_reason: z.string().nullable(),
      owner_id: z.string().nullable(),
      source: z.string().nullable(),
      relationship_context: z.string().nullable(),
      merged_into: z.string().nullable(),
      created_at: z.string(),
      updated_at: z.string(),
    }),
    key: ['id'],
  },
  contact: {
    table: 'sales_contacts',
    fields: z.object({
      id: z.string(),
      company_id: z.string(),
      name: z.string(),
      role: z.string().nullable(),
      email: z.string().nullable(),
      phone: z.string().nullable(),
      source: z.string().nullable(),
      owner_id: z.string().nullable(),
      opted_out: z.number(),
      created_at: z.string(),
    }),
    key: ['id'],
    erasable: ['name', 'email', 'phone'],
  },
  opportunity: {
    table: 'sales_opportunities',
    fields: z.object({
      id: z.string(),
      company_id: z.string(),
      title: z.string(),
      stage: z.string(),
      fit_rationale: z.string().nullable(),
      value_low: z.string().nullable(),
      value_high: z.string().nullable(),
      currency: z.string(),
      owner_id: z.string().nullable(),
      next_step: z.string().nullable(),
      target_date: z.string().nullable(),
      lost_reason: z.string().nullable(),
      created_at: z.string(),
      updated_at: z.string(),
    }),
    key: ['id'],
  },
  meeting: {
    table: 'sales_meetings',
    fields: z.object({
      id: z.string(),
      company_id: z.string(),
      opportunity_id: z.string().nullable(),
      title: z.string(),
      starts_at: z.string(),
      duration_min: z.number(),
      location: z.string().nullable(),
      attendees: z.string().nullable(),
      agenda: z.string().nullable(),
      status: z.string(),
      owner_id: z.string().nullable(),
      // Who confirmed that everyone on the call agreed to be recorded, and when (the latest recording).
      recording_consent_by: z.string().nullable(),
      recording_consent_at: z.string().nullable(),
      created_at: z.string(),
      updated_at: z.string(),
    }),
    key: ['id'],
    // Who was there is typed by a person and names people.
    erasable: ['attendees'],
  },
  interaction: {
    table: 'sales_interactions',
    fields: z.object({
      id: z.string(),
      company_id: z.string(),
      contact_id: z.string().nullable(),
      opportunity_id: z.string().nullable(),
      kind: z.string(),
      direction: z.string().nullable(),
      summary: z.string(),
      customer_quote: z.string().nullable(),
      generated: z.number(),
      performed_by_kind: z.string(),
      performed_by: z.string(),
      occurred_at: z.string(),
      created_at: z.string(),
    }),
    key: ['id'],
    // What a customer said, and what was written about it, can both be personal.
    erasable: ['summary', 'customer_quote'],
  },
  task: {
    table: 'sales_tasks',
    fields: z.object({
      id: z.string(),
      company_id: z.string().nullable(),
      opportunity_id: z.string().nullable(),
      title: z.string(),
      due_date: z.string(),
      owner_id: z.string().nullable(),
      done_at: z.string().nullable(),
      created_at: z.string(),
    }),
    key: ['id'],
  },
  knowledge: {
    table: 'sales_knowledge',
    fields: z.object({
      id: z.string(),
      title: z.string(),
      body: z.string(),
      category: z.string(),
      claim_label: z.string().nullable(),
      source: z.string(),
      source_date: z.string().nullable(),
      status: z.string(),
      created_by: z.string(),
      approved_by: z.string().nullable(),
      approved_at: z.string().nullable(),
      created_at: z.string(),
      updated_at: z.string(),
    }),
    key: ['id'],
  },
  exclusion: {
    table: 'sales_exclusions',
    fields: z.object({
      id: z.string(),
      kind: z.string(),
      value: z.string(),
      reason: z.string(),
      created_by: z.string(),
      created_at: z.string(),
    }),
    key: ['id'],
  },
  member: {
    table: 'sales_members',
    fields: z.object({
      id: z.string(),
      display_name: z.string(),
      email: z.string().nullable(),
      created_at: z.string(),
    }),
    key: ['id'],
    erasable: ['display_name', 'email'],
  },
  invite: {
    table: 'sales_invites',
    fields: z.object({
      // The invited person's principal id, minted by the platform when the invitation is made. It is who they
      // become on arrival, so an invitation, the member row and every event after it share one id.
      id: z.string(),
      email: z.string(),
      role_key: z.string(),
      invited_by: z.string(),
      status: z.string(),
      expires_at: z.string(),
      created_at: z.string(),
      settled_at: z.string().nullable(),
    }),
    key: ['id'],
    erasable: ['email'],
  },
  import_batch: {
    table: 'sales_import_batches',
    fields: z.object({
      id: z.string(),
      filename: z.string(),
      uploaded_by: z.string(),
      row_count: z.number(),
      created_count: z.number(),
      matched_count: z.number(),
      flagged_count: z.number(),
      created_at: z.string(),
    }),
    key: ['id'],
  },
  duplicate: {
    table: 'sales_duplicates',
    fields: z.object({
      id: z.string(),
      kind: z.string(),
      left_id: z.string(),
      right_id: z.string(),
      reason: z.string(),
      status: z.string(),
      batch_id: z.string().nullable(),
      decided_by: z.string().nullable(),
      decided_at: z.string().nullable(),
      snapshot: z.string().nullable(),
      created_at: z.string(),
    }),
    key: ['id'],
  },
});
