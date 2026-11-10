import {
  definePermissions,
  type EntityGrantShape,
  type PermissionKey,
  type RoleDefinition,
} from '@substrat-run/contracts';
import { assistantModule, ASSISTANT_PERM } from '@substrat-run/engine-assistant';
import { salesModule } from './module.js';
import { SALES_PERM } from './manifest.js';
import { SALES_PERMISSIONS } from './operations.js';

// The manifest's config surface rides the same import `substrat push` already makes for
// `permissions`: this export is what the push uploads, so `src/manifest.ts` is the
// single envSpec declaration and package.json carries no copy.
export { SALES_ENV as envSpec } from './manifest.js';

// ============================================================================
// The vertical's PROVISIONING surface — everything a deployment needs to know
// about modules, roles and grant shapes, with NO node imports. Split from
// seed.ts (which pulls in node:fs + the SQLite adapter) so the Cloudflare
// worker (src/worker.ts) can bundle it, and so `substrat push` can read the
// permission registry from it (package.json `substrat.permissions`).
// ============================================================================

/**
 * The modules this vertical runs. Sales OS owns its own vocabulary (no engine for a CRM), and composes one engine:
 * the assistant's record of a conversation. The engine never talks to a model; `src/assistant-host.ts` does.
 */
export const MODULES = [assistantModule, salesModule];

/** Entitlements are default-deny: one SKU key per module this vertical runs. */
export const ENTITLEMENT_KEYS = ['assistant', 'sales-os'];

const adminPerms: PermissionKey[] = [
  SALES_PERM.crmRead,
  SALES_PERM.crmWrite,
  SALES_PERM.importRun,
  SALES_PERM.duplicateResolve,
  SALES_PERM.knowledgeRead,
  SALES_PERM.knowledgeManage,
  SALES_PERM.exclusionAdd,
  SALES_PERM.exclusionLift,
  SALES_PERM.auditRead,
  SALES_PERM.memberManage,
  // Their OWN conversations only. `assistant:audit` (reading other people's) is held by nobody in v1,
  // and `assistant:run` belongs to the assistant's system identity: no role can hold it.
  ASSISTANT_PERM.use,
];

/** A colleague: works the pipeline and reads the knowledge, but never approves, imports, merges or audits. */
const memberPerms: PermissionKey[] = [
  SALES_PERM.crmRead,
  SALES_PERM.crmWrite,
  SALES_PERM.knowledgeRead,
  SALES_PERM.exclusionAdd,
  ASSISTANT_PERM.use,
];

/** This vertical's role table — identical in every tenant. */
export const ROLES: RoleDefinition[] = [
  { key: 'sales-admin', permissions: adminPerms, source: 'vertical' },
  { key: 'sales-member', permissions: memberPerms, source: 'vertical' },
];

/** Which role the installing owner holds — what /internal/provision assigns. */
export const OWNER_ROLE_KEY = 'sales-admin';

/** No prospect or customer ever signs in, so there are no entity-narrowed grant shapes. */
export const ENTITY_GRANTS: EntityGrantShape[] = [];

export const permissions = definePermissions({
  modules: MODULES,
  roles: ROLES,
  entityGrants: ENTITY_GRANTS,
  keys: SALES_PERMISSIONS,
});
