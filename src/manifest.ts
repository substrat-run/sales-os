import {
  eventsEmittedBy,
  moduleManifest,
  permissionKey,
  type EnvVarSpec,
} from '@substrat-run/contracts';
import { salesOperations } from './operations.js';

// ============================================================================
// The vertical's MANIFEST — the reviewable contract the kernel reads at
// registration. Sales OS composes no engine: its nouns (companies, contacts,
// opportunities, interactions, knowledge) are not something a published engine
// owns, so the vertical owns them outright. Tenancy, permissions and the audit
// spine are the kernel's.
// ============================================================================

/** The most one recording may hold. The platform's own ceiling for an upload link is 25 MiB. */
export const RECORDING_MAX_BYTES = 25 * 1024 * 1024 - 1;

/** The vertical's own permission keys. */
export const SALES_PERM = {
  crmRead: permissionKey.parse('crm:read'),
  crmWrite: permissionKey.parse('crm:write'),
  importRun: permissionKey.parse('import:run'),
  duplicateResolve: permissionKey.parse('duplicate:resolve'),
  knowledgeRead: permissionKey.parse('knowledge:read'),
  knowledgeManage: permissionKey.parse('knowledge:manage'),
  exclusionAdd: permissionKey.parse('exclusion:add'),
  exclusionLift: permissionKey.parse('exclusion:lift'),
  auditRead: permissionKey.parse('audit:read'),
  memberManage: permissionKey.parse('member:manage'),
};

/**
 * The vertical's DECLARED per-instance settings. Read them with
 * `resolveScopedEnvSpec(SALES_ENV, env, delivered)`, never `env.FOO` directly.
 * `src/provision.ts` re-exports this as `envSpec`, which `substrat push` uploads.
 */
export const SALES_ENV: EnvVarSpec[] = [
  {
    key: 'WORKSPACE_NAME',
    label: 'Workspace name',
    description: 'The name shown at the top of the workspace. Set per install.',
    placeholder: 'Substrat Sales OS',
    default: 'Substrat Sales OS',
    required: false,
    secret: false,
    group: 'General',
  },
];

export const salesManifest = moduleManifest.parse({
  id: 'salesos',
  version: '0.0.1',
  kernelContract: '^0.0.1',
  permissions: [
    { key: 'crm:read', description: 'Read companies, contacts, opportunities, interactions, tasks and the daily queue' },
    { key: 'crm:write', description: 'Create and edit companies, contacts, opportunities and tasks; log interactions; move stages; opt a contact out' },
    { key: 'import:run', description: 'Upload a CSV and read the raw uploaded rows' },
    { key: 'duplicate:resolve', description: 'See duplicate candidates and decide them: keep both, or merge' },
    { key: 'knowledge:read', description: 'Read the knowledge base' },
    { key: 'knowledge:manage', description: 'Write, approve and retire knowledge entries' },
    { key: 'exclusion:add', description: 'Add a company or domain we must not contact' },
    { key: 'exclusion:lift', description: 'Lift an exclusion or an opt-out' },
    { key: 'audit:read', description: 'Read the full audit trail: payloads, authorizing permission and grant' },
    { key: 'member:manage', description: 'Record who a person is (display name) in this workspace' },
  ],
  // Derived from the operations' own `emits`, so the list cannot drift from them.
  // `sales.duplicate-flagged` is emitted by the import, which declares one `emits` of its own.
  events: {
    emits: [
      ...eventsEmittedBy(salesOperations),
      { type: 'sales.duplicate-flagged', schemaVersion: 1 },
      // Emitted by `sales/join` when a person arrives on an open invitation.
      { type: 'sales.invite-arrived', schemaVersion: 1 },
      // Emitted by `sales/start-recording`: who confirmed everyone agreed to be recorded, and when.
      { type: 'sales.recording-started', schemaVersion: 1 },
    ],
    consumes: [],
  },
  migrations: { journalDir: './migrations', compatibleFrom: '0.0.1' },
  // A meeting's recordings: audio hung on the meeting, read and written with the CRM keys. Uploaded through a
  // single-use link (`sales/start-recording` mints it), which the platform caps at 25 MiB and speech-sized audio.
  attachmentTargets: [
    {
      entityType: 'meeting',
      readPermission: 'crm:read',
      writePermission: 'crm:write',
      uploadLinks: { maxBytes: RECORDING_MAX_BYTES, contentTypes: ['audio/*'] },
    },
  ],
  entityRelations: [],
  envSpec: SALES_ENV,
  entitlementKey: 'sales-os',
});
