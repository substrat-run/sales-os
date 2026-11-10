import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { assistantModule } from '@substrat-run/engine-assistant';
import type { SqliteScopeHost } from '@substrat-run/adapter-sqlite';
import type { ScopeStub } from '@substrat-run/kernel';
import { buildSalesHost, ensureAssistant, seedSales, type SalesWorld } from '../src/seed.js';

// ============================================================================
// The assistant engine, composed: a conversation is a person's own record, only the assistant's system
// identity writes its side, and nobody else can read it. No model here: the engine records and fences,
// the host (src/assistant-host.ts) runs the model, and its tests are in test/assistant-host.test.ts.
// ============================================================================

describe('assistant engine, composed', () => {
  let dir: string;
  let host: SqliteScopeHost;
  let w: SalesWorld;
  let nora: ScopeStub;
  let markus: ScopeStub;
  let system: ScopeStub;
  let threadId: string;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'substrat-sales-os-assistant-'));
    host = buildSalesHost(dir);
    w = await seedSales(host, dir);
    nora = await host.getScope(w.nora, w.t1, w.s1);
    markus = await host.getScope(w.markus, w.t1, w.s1);
    system = await host.getSystemScope(assistantModule.manifest.id, w.t1, w.s1);
  });
  afterAll(async () => {
    await host.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('provisioning the assistant can be repeated: a world seeded before it existed is upgraded in place', async () => {
    await expect(ensureAssistant(host, w)).resolves.toBeUndefined();
    await expect(ensureAssistant(host, w)).resolves.toBeUndefined();
  });

  it('a colleague opens a thread and asks; the question is on the record and a turn is open', async () => {
    const t = await nora.invoke<{ id: string; subject: string }>('assistant/create-thread', { title: 'Pricing' });
    threadId = t.id;
    expect(t.subject).toBe(w.nora);
    await nora.invoke('assistant/send-message', { threadId, text: 'What do we say about pilot pricing?' });
    const page = await nora.invoke<{ events: { t: string }[] }>('assistant/read-events', { threadId, after: 0 });
    expect(page.events.map((e) => e.t)).toEqual(['user-message', 'turn-start']);
    // A second question while the turn is open is refused, not queued behind it.
    await expect(nora.invoke('assistant/send-message', { threadId, text: 'again' })).rejects.toThrow(/still answering the last message/);
  });

  it('only the assistant’s system identity writes its side, and one run at a time', async () => {
    // No person writes the assistant's side, whatever their role: an admin included.
    await expect(markus.invoke('assistant/acquire-run', { threadId, runId: 'r-person' })).rejects.toThrow(/permission denied/);
    await expect(nora.invoke('assistant/append-events', { threadId, runId: 'r-person', events: [{ t: 'text-start', pid: 'x' }] })).rejects.toThrow(/permission denied/);
    // …the control: the system identity takes the lease and writes.
    await system.invoke('assistant/acquire-run', { threadId, runId: 'run-1' });
    await system.invoke('assistant/append-events', {
      threadId,
      runId: 'run-1',
      events: [
        { t: 'text-start', pid: 'a' },
        { t: 'text-delta', pid: 'a', delta: 'Pilots are discussed case by case.' },
        { t: 'text-end', pid: 'a' },
        { t: 'turn-finish', reason: 'done' },
      ],
    });
    await system.invoke('assistant/release-run', { threadId, runId: 'run-1' });
    const page = await nora.invoke<{ events: { t: string }[] }>('assistant/read-events', { threadId, after: 0 });
    expect(page.events.map((e) => e.t)).toEqual(['user-message', 'turn-start', 'text-start', 'text-delta', 'text-end', 'turn-finish']);
    // With the turn finished, the thread rests and the person may ask again.
    await expect(nora.invoke('assistant/send-message', { threadId, text: 'Thanks' })).resolves.toBeTruthy();
  });

  it('a conversation is its owner’s alone: an admin and another workspace are told it does not exist', async () => {
    await expect(markus.invoke('assistant/read-events', { threadId, after: 0 })).rejects.toThrow(/not.found|not found/i);
    await expect(markus.invoke('assistant/get-thread', { threadId })).rejects.toThrow(/not.found|not found/i);
    // The control: the owner reads it, and an admin's own list does not contain it.
    expect((await nora.invoke<{ id: string }>('assistant/get-thread', { threadId })).id).toBe(threadId);
    const adminList = await markus.invoke<{ entries: { id: string }[] }>('assistant/list-threads');
    expect(adminList.entries.map((t) => t.id)).not.toContain(threadId);
    const rex = await host.getScope(w.rex, w.t1, w.s1);
    await expect(rex.invoke('assistant/create-thread', {})).rejects.toThrow(/permission denied/);
  });

  describe("the assistant's tools", () => {
    let acmeId: string;
    beforeAll(async () => {
      const acme = await markus.invoke<{ id: string }>('sales/create-company', {
        companyName: 'Acme AB', domain: 'acme.se', source: 'manual', segment: 'saas',
        relationshipContext: 'Met Anna Lindqvist at a dinner',
      });
      acmeId = acme.id;
      await markus.invoke('sales/create-contact', { companyId: acmeId, name: 'Anna Lindqvist', email: 'anna@acme.se', phone: '070-1' });
      await markus.invoke('sales/log-interaction', { companyId: acmeId, kind: 'call', summary: 'Anna said the budget is tight', customerQuote: 'We have no money until Q3' });
      await markus.invoke('sales/create-opportunity', { companyId: acmeId, title: 'Pilot booking system' });
      const kb = async (title: string, body: string, approve: boolean) => {
        const k = await markus.invoke<{ id: string }>('sales/create-knowledge', { title, body, category: 'pricing', source: 'test' });
        if (approve) await markus.invoke('sales/approve-knowledge', { knowledgeId: k.id });
        return k.id;
      };
      await kb('Pilot pricing', 'A pilot is priced per site for three months.', true);
      await kb('Secret pilot discount', 'A pilot discount of 50 percent, not yet agreed.', false); // a draft
      const old = await kb('Old pilot terms', 'A pilot used to be free.', true);
      await markus.invoke('sales/retire-knowledge', { knowledgeId: old });
    });

    it('answers only from APPROVED knowledge: a draft and a retired entry are never returned', async () => {
      const r = await nora.invoke<{ entries: { title: string; claim_label: string | null; source: string }[] }>(
        'sales/assistant-find-knowledge', { query: 'what do we say about pilot pricing' });
      expect(r.entries.map((e) => e.title)).toEqual(['Pilot pricing']);
      expect(r.entries[0]).toMatchObject({ source: 'test' });
      // Nothing supports this: the answer is an empty list, which the assistant must say out loud.
      expect((await nora.invoke<{ entries: unknown[] }>('sales/assistant-find-knowledge', { query: 'quantum teleportation' })).entries).toEqual([]);
    });

    it('returns NO personal data: no contact, no interaction text, no relationship context, no owner', async () => {
      const everything = JSON.stringify([
        await nora.invoke('sales/assistant-find-companies', { query: 'acme' }),
        await nora.invoke('sales/assistant-company', { companyId: acmeId }),
        await nora.invoke('sales/assistant-today'),
      ]);
      expect(everything).toContain('Acme AB');
      expect(everything).toContain('Pilot booking system');
      for (const leaked of ['Anna', 'Lindqvist', 'anna@acme.se', '070-1', 'budget is tight', 'no money until', 'Met ', 'owner_id', 'relationship_context']) {
        expect(everything, `leaked: ${leaked}`).not.toContain(leaked);
      }
    });

    it('runs as the person asking: another workspace gets a denial, never another tenant’s rows', async () => {
      const rex = await host.getScope(w.rex, w.t1, w.s1);
      for (const [op, input] of [
        ['sales/assistant-find-knowledge', { query: 'pilot' }],
        ['sales/assistant-find-companies', { query: 'acme' }],
        ['sales/assistant-company', { companyId: acmeId }],
        ['sales/assistant-today', undefined],
      ] as const) {
        await expect(rex.invoke(op, input)).rejects.toThrow(/permission denied/);
      }
      // …the control: his own workspace answers, empty.
      const own = await host.getScope(w.rex, w.t2, w.s2);
      expect((await own.invoke<{ entries: unknown[] }>('sales/assistant-find-companies', { query: 'acme' })).entries).toEqual([]);
    });
  });
});
