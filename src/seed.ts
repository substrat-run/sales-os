import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  platformActorId,
  principalId,
  scopeId,
  tenantId,
  type PrincipalId,
  type ScopeId,
  type TenantId,
} from '@substrat-run/contracts';
import { ulid } from '@substrat-run/kernel';
import { assistantModule, ASSISTANT_PERM } from '@substrat-run/engine-assistant';
import { SqliteScopeHost } from '@substrat-run/adapter-sqlite';
import { defaultAttachmentExtractors } from '@substrat-run/attachment-extractors';
import { ENTITLEMENT_KEYS, MODULES, OWNER_ROLE_KEY, permissions, ROLES } from './provision.js';

// The provisioning surface (modules, roles, grant shapes) lives in provision.ts —
// node-free so the worker bundles it and `substrat push` reads it.
export { ENTITY_GRANTS, MODULES, permissions, ROLES } from './provision.js';
import { DEV_PROVIDER, PERSONAS } from './personas.js';

// ============================================================================
// The seeded world. TWO tenants on purpose: the first is the Substrat workspace
// the scenario exercises; the second exists only so the scenario can watch the
// tenant boundary turn its admin away when he reaches across.
// ============================================================================

export interface SalesWorld {
  t1: TenantId; // Substrat's workspace
  s1: ScopeId; //   its scope
  t2: TenantId; // a second, unrelated workspace
  s2: ScopeId; //   its scope
  markus: PrincipalId; // sales-admin @ t1 (the owner)
  martin: PrincipalId; // sales-admin @ t1
  nora: PrincipalId; // sales-member @ t1
  rex: PrincipalId; // sales-admin @ t2 — the cross-tenant attacker
}

export interface SalesHostOptions {
  /** A frozen or manual clock, for a scenario that tests elapsed time. */
  clock?: ConstructorParameters<typeof SqliteScopeHost>[0]['clock'];
}

export function buildSalesHost(dir: string, opts: SalesHostOptions = {}): SqliteScopeHost {
  const host = new SqliteScopeHost({
    dir,
    attachmentExtractors: defaultAttachmentExtractors(),
    permissions,
    ...(opts.clock ? { clock: opts.clock } : {}),
  });
  for (const m of MODULES) host.registerModule(m);
  return host;
}

/** Provision ONE tenant of this vertical: tenant, entitlements, an active scope, roles, and the owner. */
async function provisionWorkspace(
  host: SqliteScopeHost,
  input: { tenantId: TenantId; scopeId: ScopeId; owner: PrincipalId; slug: string; name: string },
): Promise<void> {
  const staff = platformActorId.parse(ulid());
  await host.admin.createTenant(staff, { id: input.tenantId, slug: input.slug, name: input.name });
  for (const key of ENTITLEMENT_KEYS) {
    await host.admin.grantEntitlement(staff, input.tenantId, key);
  }
  await host.provisionScope(staff, { tenantId: input.tenantId, scopeId: input.scopeId, jurisdiction: 'global' });
  await host.admin.activateScope(staff, input.tenantId, input.scopeId);
  for (const role of ROLES) await host.admin.defineRole(staff, input.tenantId, role);
  await host.admin.assignRole(staff, {
    principalId: input.owner,
    roleKey: OWNER_ROLE_KEY,
    node: { tenantId: input.tenantId, scopeId: null },
  });
}

/**
 * Make a world ready for the assistant, and keep it so. Idempotent, and run on EVERY boot, so a data
 * directory seeded before the assistant existed is upgraded in place: the `assistant` entitlement, the
 * role table as it is now (a role keeps the permissions it was born with until it is defined again), and
 * the one grant the assistant's SYSTEM identity needs: `assistant:run`, which no person's role can hold.
 */
export async function ensureAssistant(host: SqliteScopeHost, world: SalesWorld): Promise<void> {
  const staff = platformActorId.parse(ulid());
  for (const [tenant, scope] of [
    [world.t1, world.s1],
    [world.t2, world.s2],
  ] as const) {
    await host.admin.grantEntitlement(staff, tenant, 'assistant');
    for (const role of ROLES) await host.admin.defineRole(staff, tenant, role);
    await host.admin.grantToSystem(staff, {
      moduleId: assistantModule.manifest.id,
      permission: ASSISTANT_PERM.run,
      node: { tenantId: tenant, scopeId: scope },
      grantedBy: staff,
    });
  }
}

/**
 * Idempotent seed. Everything that mutates the control plane runs only on a FRESH
 * data dir (guarded by cast.json); on restart the tenants, roles and entities are
 * already in the SQLite files, so we just rebuild the handle object.
 */
export async function seedSales(host: SqliteScopeHost, dir: string): Promise<SalesWorld> {
  const castPath = join(dir, 'cast.json');
  if (existsSync(castPath)) {
    const raw = JSON.parse(readFileSync(castPath, 'utf8')) as Record<string, string>;
    const existing: SalesWorld = {
      t1: tenantId.parse(raw.t1),
      s1: scopeId.parse(raw.s1),
      t2: tenantId.parse(raw.t2),
      s2: scopeId.parse(raw.s2),
      markus: principalId.parse(raw.markus),
      martin: principalId.parse(raw.martin),
      nora: principalId.parse(raw.nora),
      rex: principalId.parse(raw.rex),
    };
    await ensureAssistant(host, existing);
    return existing;
  }

  const staff = platformActorId.parse(ulid());
  const world: SalesWorld = {
    t1: tenantId.parse(ulid()),
    s1: scopeId.parse(ulid()),
    t2: tenantId.parse(ulid()),
    s2: scopeId.parse(ulid()),
    markus: principalId.parse(ulid()),
    martin: principalId.parse(ulid()),
    nora: principalId.parse(ulid()),
    rex: principalId.parse(ulid()),
  };

  await provisionWorkspace(host, {
    tenantId: world.t1,
    scopeId: world.s1,
    owner: world.markus,
    slug: 'substrat',
    name: 'Substrat',
  });
  await provisionWorkspace(host, {
    tenantId: world.t2,
    scopeId: world.s2,
    owner: world.rex,
    slug: 'rival',
    name: 'Rival Co',
  });

  // The rest of t1's cast.
  for (const [principal, roleKey] of [
    [world.martin, 'sales-admin'],
    [world.nora, 'sales-member'],
  ] as const) {
    await host.admin.assignRole(staff, {
      principalId: principal,
      roleKey,
      node: { tenantId: world.t1, scopeId: world.s1 },
    });
  }

  // Seed entities go through the operations (NEVER raw SQL): the seed exercises
  // the same permission checks and event spine the app does.
  const markus = await host.getScope(world.markus, world.t1, world.s1);
  for (const [p, name, email] of [
    [world.markus, 'Markus', 'markus@substrat.test'],
    [world.martin, 'Martin', 'martin@substrat.test'],
    [world.nora, 'Nora', 'nora@substrat.test'],
  ] as const) {
    await markus.invoke('sales/register-member', { principalId: p, displayName: name, email });
  }
  const kb = await markus.invoke<{ id: string }>('sales/create-knowledge', {
    title: 'Substrat in one paragraph',
    body: 'Substrat is a multi-tenant kernel with headless engines; verticals own everything a user touches.',
    category: 'positioning',
    claimLabel: 'shipped',
    source: 'Product brief',
    sourceDate: '2026-11-10',
  });
  await markus.invoke('sales/approve-knowledge', { knowledgeId: kb.id });

  await ensureAssistant(host, world);
  writeFileSync(castPath, JSON.stringify(world, null, 2));
  return world;
}

/**
 * Bind each dev persona's OIDC `sub` to its principal in the identity directory.
 * The ordinary production seam, not a dev one. Run on EVERY boot: `linkIdentity`
 * is idempotent for an unchanged binding, so a wiped `.data` heals itself.
 */
export async function linkDevPersonas(host: SqliteScopeHost, world: SalesWorld): Promise<void> {
  const staff = platformActorId.parse(ulid());
  await host.admin.registerIdentityPool(staff, { provider: DEV_PROVIDER, topology: 'central', tenantId: null });
  const homes: Record<string, { principal: PrincipalId; tenantId: TenantId; scopeId: ScopeId }> = {
    'dev|markus': { principal: world.markus, tenantId: world.t1, scopeId: world.s1 },
    'dev|martin': { principal: world.martin, tenantId: world.t1, scopeId: world.s1 },
    'dev|nora': { principal: world.nora, tenantId: world.t1, scopeId: world.s1 },
    'dev|rex': { principal: world.rex, tenantId: world.t2, scopeId: world.s2 },
  };
  for (const persona of PERSONAS) {
    const home = homes[persona.sub];
    if (!home) continue;
    await host.admin.linkIdentity(staff, {
      provider: DEV_PROVIDER,
      externalId: persona.sub,
      principal: home.principal,
      tenantId: home.tenantId,
      scopeId: home.scopeId,
    });
  }
}
