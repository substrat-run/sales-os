import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { platformActorId, principalId, type Page } from '@substrat-run/contracts';
import { manualClock, ulid, type ScopeStub } from '@substrat-run/kernel';
import type { SqliteScopeHost } from '@substrat-run/adapter-sqlite';
import { buildSalesHost, seedSales, type SalesWorld } from '../src/seed.js';
import type { InviteRow } from '../src/module.js';

// ============================================================================
// Team invitations. The sign-in door makes the invitation (it mints the invited person, enforces that an
// inviter can never confer more than they hold, and admits them by their verified address) and calls these
// operations as the inviter to RECORD it. So what is tested here is what is ours: who may record, list and
// withdraw one, what is refused, how expiry reads, and what happens when the person arrives.
// ============================================================================

describe('team invitations', () => {
  let dir: string;
  let host: SqliteScopeHost;
  let w: SalesWorld;
  let markus: ScopeStub;
  let nora: ScopeStub;
  const clock = manualClock('2026-11-10T09:00:00.000Z');
  const staff = platformActorId.parse(ulid());
  const ida = principalId.parse(ulid());
  const idaExpires = '2026-11-24T09:00:00.000Z';
  const invite = (stub: ScopeStub, principal: string, email: string, roleKey = 'sales-member', expiresAt = idaExpires) =>
    stub.invoke<InviteRow>('sales/invite-member', { principal, email, roleKey, expiresAt });

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'substrat-sales-os-team-'));
    host = buildSalesHost(dir, { clock: clock.read });
    w = await seedSales(host, dir);
    markus = await host.getScope(w.markus, w.t1, w.s1);
    nora = await host.getScope(w.nora, w.t1, w.s1);
  });
  afterAll(async () => {
    await host.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('an admin records an invitation: the role, who invited, when it expires; the address is stored lower-cased', async () => {
    const row = await invite(markus, ida, 'Ida@Substrat.Test');
    expect(row).toMatchObject({ id: ida, email: 'ida@substrat.test', role_key: 'sales-member', invited_by: w.markus, status: 'open', expires_at: idaExpires });
    const listed = (await markus.invoke<Page<InviteRow>>('sales/list-invites')).entries;
    expect(listed.map((i) => i.id)).toEqual([ida]);
  });

  it('only an admin may record, list or withdraw: a colleague is denied each, and a stranger too', async () => {
    await expect(invite(nora, ulid(), 'x@y.test')).rejects.toThrow(/permission denied/);
    await expect(nora.invoke('sales/list-invites')).rejects.toThrow(/permission denied/);
    await expect(nora.invoke('sales/cancel-invite', { principal: ida })).rejects.toThrow(/permission denied/);
    const rex = await host.getScope(w.rex, w.t1, w.s1);
    await expect(rex.invoke('sales/list-invites')).rejects.toThrow(/permission denied/);
    // …the control: the colleague CAN read the team list (names only), which Settings shows everyone.
    expect((await nora.invoke<Page<{ id: string }>>('sales/list-members')).entries.length).toBeGreaterThan(0);
  });

  it('refuses a second open invitation to the same address, and an address already on the team', async () => {
    await expect(invite(markus, ulid(), 'IDA@substrat.test')).rejects.toThrow(/already has an open invitation/);
    await expect(invite(markus, ulid(), 'nora@substrat.test')).rejects.toThrow(/already on the team/);
    // Only the two roles this app offers, and never anything else (the owner is made by the platform, not invited).
    await expect(invite(markus, ulid(), 'new@substrat.test', 'owner')).rejects.toThrow();
  });

  it('withdrawing settles it, can be repeated, and frees the address to be invited again', async () => {
    const withdrawn = await markus.invoke<InviteRow>('sales/cancel-invite', { principal: ida });
    expect(withdrawn.status).toBe('withdrawn');
    expect((await markus.invoke<InviteRow>('sales/cancel-invite', { principal: ida })).status).toBe('withdrawn'); // a retry
    const again = ulid();
    expect((await invite(markus, again, 'ida@substrat.test')).status).toBe('open');
    await markus.invoke('sales/cancel-invite', { principal: again });
  });

  it('an invitation past its expiry reads as expired, the row is untouched, and the address can be invited again', async () => {
    const p = ulid();
    await invite(markus, p, 'late@substrat.test');
    clock.advance(15 * 24 * 3600_000); // past the 14 days
    const row = (await markus.invoke<Page<InviteRow>>('sales/list-invites')).entries.find((i) => i.id === p)!;
    expect(row.status).toBe('expired');
    const second = ulid();
    // A new invitation to the same address is allowed once the old one has lapsed.
    expect((await invite(markus, second, 'late@substrat.test', 'sales-member', '2026-12-30T00:00:00.000Z')).status).toBe('open');
  });

  it('arriving settles the invitation: the first time the person reaches the workspace they are joined, and cannot be un-invited', async () => {
    const p = principalId.parse(ulid());
    await invite(markus, p, 'arrives@substrat.test', 'sales-member', '2026-12-30T00:00:00.000Z');
    // The door would have bound them to the role by now; do the same with the platform's verb, then they reach the workspace.
    await host.admin.assignRole(staff, { principalId: p, roleKey: 'sales-member', node: { tenantId: w.t1, scopeId: w.s1 } });
    const arrived = await host.getScope(p, w.t1, w.s1, { verifiedEmail: 'arrives@substrat.test' });
    const me = await arrived.invoke<{ id: string; email: string | null }>('sales/join', { displayName: 'Anna Ankomst' });
    expect(me).toMatchObject({ id: p, email: 'arrives@substrat.test' });
    const row = (await markus.invoke<Page<InviteRow>>('sales/list-invites')).entries.find((i) => i.id === p)!;
    expect(row).toMatchObject({ status: 'arrived' });
    expect(row.settled_at).not.toBeNull();
    await expect(markus.invoke('sales/cancel-invite', { principal: p })).rejects.toThrow(/already arrived/);
    // They arrive with the MEMBER's permissions only: they read the pipeline but cannot invite anyone.
    await expect(invite(arrived, ulid(), 'z@substrat.test')).rejects.toThrow(/permission denied/);
    expect((await arrived.invoke<Page<unknown>>('sales/list-companies')).entries).toBeDefined();
  });
});
