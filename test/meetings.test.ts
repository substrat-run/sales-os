import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { manualClock, type ScopeStub } from '@substrat-run/kernel';
import type { Page } from '@substrat-run/contracts';
import type { SqliteScopeHost } from '@substrat-run/adapter-sqlite';
import { mountUploadLinkRedeem } from '@substrat-run/vertical-host';
import { buildSalesHost, seedSales, type SalesWorld } from '../src/seed.js';
import type { CompanyRow, MeetingRow, OpportunityRow } from '../src/module.js';
import { RECORDING_MAX_BYTES } from '../src/manifest.js';
import { mountApi } from '../src/routes.js';

// ============================================================================
// Meetings: scheduled against a company, recorded in the browser. What is tested here is what is ours: who may
// schedule and see, that a recording cannot start without the consent tick, that the audio lands on THAT meeting and
// plays back byte for byte, what the upload refuses, and that another workspace gets nothing.
// ============================================================================

describe('meetings and their recordings', () => {
  let dir: string;
  let host: SqliteScopeHost;
  let w: SalesWorld;
  let markus: ScopeStub;
  let nora: ScopeStub;
  let rex: ScopeStub;
  const clock = manualClock('2026-11-10T09:00:00.000Z');
  let companyId: string;
  let opportunityId: string;
  let meeting: MeetingRow;

  // The upload route, as `server.ts` mounts it: the link is the authority, the route only says which workspace.
  const app = new Hono();
  const put = (path: string, body: Uint8Array, type = 'audio/webm') =>
    app.request(path, { method: 'PUT', headers: { 'content-type': type }, body });
  const audio = new Uint8Array(4096).map((_, i) => (i * 7) % 251);

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'substrat-sales-os-meetings-'));
    host = buildSalesHost(dir, { clock: clock.read });
    w = await seedSales(host, dir);
    markus = await host.getScope(w.markus, w.t1, w.s1);
    nora = await host.getScope(w.nora, w.t1, w.s1);
    rex = await host.getScope(w.rex, w.t2, w.s2);
    mountUploadLinkRedeem(app, { host: () => host, node: () => ({ tenantId: w.t1, scopeId: w.s1 }) });
    companyId = (await markus.invoke<CompanyRow>('sales/create-company', { companyName: 'Acme AB', source: 'test' })).id;
    opportunityId = (await nora.invoke<OpportunityRow>('sales/create-opportunity', { companyId, title: 'Booking system' })).id;
  });
  afterAll(async () => {
    await host.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('1. a member schedules a meeting for a company and an opportunity, and an admin sees it', async () => {
    meeting = await nora.invoke<MeetingRow>('sales/create-meeting', {
      companyId,
      opportunityId,
      title: 'Intro call',
      startsAt: '2026-11-12T10:00:00.000Z',
      durationMin: 45,
      attendees: 'Anna (CTO)',
    });
    expect(meeting).toMatchObject({ status: 'scheduled', owner_id: w.nora, duration_min: 45, company_id: companyId });
    const seen = await markus.invoke<MeetingRow>('sales/get-meeting', { meetingId: meeting.id });
    expect(seen.title).toBe('Intro call');
    // The opportunity must belong to the company the meeting is with.
    const other = await markus.invoke<CompanyRow>('sales/create-company', { companyName: 'Beta Oy', source: 'test' });
    await expect(
      nora.invoke('sales/create-meeting', { companyId: other.id, opportunityId, title: 'Mixed up', startsAt: '2026-11-12T11:00:00.000Z' }),
    ).rejects.toThrow(/another company/);
  });

  it('2. listing narrows by company and by a time window', async () => {
    await nora.invoke('sales/create-meeting', { companyId, title: 'Later', startsAt: '2026-12-20T10:00:00.000Z' });
    const all = await markus.invoke<Page<MeetingRow>>('sales/list-meetings', { companyId });
    expect(all.entries.map((m) => m.title).sort()).toEqual(['Intro call', 'Later']);
    const soon = await markus.invoke<Page<MeetingRow>>('sales/list-meetings', { from: '2026-11-10', to: '2026-11-17' });
    expect(soon.entries.map((m) => m.title)).toEqual(['Intro call']);
  });

  it('3. a cancelled meeting is not held; it has to be scheduled again first', async () => {
    const m = await nora.invoke<MeetingRow>('sales/create-meeting', { companyId, title: 'Maybe', startsAt: '2026-11-13T10:00:00.000Z' });
    await nora.invoke('sales/set-meeting-status', { meetingId: m.id, status: 'cancelled' });
    await expect(nora.invoke('sales/set-meeting-status', { meetingId: m.id, status: 'held' })).rejects.toThrow(/schedule it again first/);
    await expect(nora.invoke('sales/set-meeting-status', { meetingId: m.id, status: 'cancelled' })).rejects.toThrow(/already cancelled/);
    // …the control: scheduled again, it can be held.
    await nora.invoke('sales/set-meeting-status', { meetingId: m.id, status: 'scheduled' });
    const held = await nora.invoke<MeetingRow>('sales/set-meeting-status', { meetingId: m.id, status: 'held' });
    expect(held.status).toBe('held');
    // And a cancelled meeting cannot be recorded.
    await nora.invoke('sales/set-meeting-status', { meetingId: m.id, status: 'cancelled' });
    await expect(nora.invoke('sales/start-recording', { meetingId: m.id, consent: true })).rejects.toThrow(/cancelled meeting cannot be recorded/);
  });

  it('4. no recording starts without the consent tick, and the tick is kept on the meeting', async () => {
    await expect(nora.invoke('sales/start-recording', { meetingId: meeting.id })).rejects.toThrow();
    await expect(nora.invoke('sales/start-recording', { meetingId: meeting.id, consent: false })).rejects.toThrow(/agreed to be recorded/);
    expect((await markus.invoke<MeetingRow>('sales/get-meeting', { meetingId: meeting.id })).recording_consent_by).toBeNull();
    // The same over the real routes: a request that never mentions consent is refused, not filled in.
    const routes = new Hono();
    mountApi(routes, async () => nora);
    const bare = await routes.request(`/api/meetings/${meeting.id}/recordings`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    expect(bare.status).toBeGreaterThanOrEqual(400);
    const ticked = await routes.request(`/api/meetings/${meeting.id}/recordings`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ consent: true }) });
    expect(ticked.status).toBe(200);
    const link = await nora.invoke<{ url: string; maxBytes: number }>('sales/start-recording', { meetingId: meeting.id, consent: true });
    expect(link.url).toMatch(/^\/api\/attachment-uploads\/meeting\//);
    expect(link.maxBytes).toBe(RECORDING_MAX_BYTES);
    const after = await markus.invoke<MeetingRow>('sales/get-meeting', { meetingId: meeting.id });
    expect(after).toMatchObject({ recording_consent_by: w.nora });
    expect(after.recording_consent_at).toBeTruthy();
  });

  it('5. the audio is stored on that meeting and plays back byte for byte; anyone in the workspace can hear it', async () => {
    const { url } = await nora.invoke<{ url: string }>('sales/start-recording', { meetingId: meeting.id, consent: true });
    const res = await put(url + '?filename=intro-call.webm', audio);
    expect(res.status).toBe(201);
    const stored = (await res.json()) as { id: string; contentType: string; size: number };
    expect(stored).toMatchObject({ contentType: 'audio/webm', size: audio.length });
    // Markus (not the recorder) lists and plays it.
    const files = await host.attachments(w.markus, w.t1, w.s1);
    const listed = await files.list({ entityType: 'meeting', entityId: meeting.id });
    expect(listed.map((a) => a.id)).toEqual([stored.id]);
    expect(listed[0]!.createdBy).toContain(w.nora);
    const opened = await files.open(stored.id);
    expect(Array.from(opened!.body)).toEqual(Array.from(audio));
    // The link was single-use.
    expect((await put(url, audio)).status).toBe(410);
  });

  it('6. the upload refuses what is too big or is not audio, and a refusal does not spend the link', async () => {
    const { url } = await nora.invoke<{ url: string }>('sales/start-recording', { meetingId: meeting.id, consent: true });
    const big = await app.request(url, {
      method: 'PUT',
      headers: { 'content-type': 'audio/webm', 'content-length': String(RECORDING_MAX_BYTES + 1) },
      body: new Uint8Array(8),
    });
    expect(big.status).toBe(413);
    expect((await put(url, new Uint8Array([1, 2, 3]), 'text/html')).status).toBe(415);
    // …the control: the same link still takes real audio.
    expect((await put(url, audio)).status).toBe(201);
  });

  it('7. the other workspace is told nothing exists, for the meeting and for the file', async () => {
    await expect(rex.invoke('sales/get-meeting', { meetingId: meeting.id })).rejects.toThrow(/not found/);
    const theirs = await host.attachments(w.rex, w.t2, w.s2);
    expect(await theirs.list({ entityType: 'meeting', entityId: meeting.id }).catch(() => [])).toEqual([]);
    const mine = await host.attachments(w.markus, w.t1, w.s1);
    const [first] = await mine.list({ entityType: 'meeting', entityId: meeting.id });
    expect(await theirs.open(first!.id).catch(() => null)).toBeNull();
  });

  it('8. any member may delete a recording, and the removal is the kernel’s audited event', async () => {
    const mine = await host.attachments(w.nora, w.t1, w.s1);
    const before = await mine.list({ entityType: 'meeting', entityId: meeting.id });
    expect(before.length).toBeGreaterThan(0);
    expect(await mine.remove(before[0]!.id)).toMatchObject({ id: before[0]!.id });
    expect((await mine.list({ entityType: 'meeting', entityId: meeting.id })).map((a) => a.id)).not.toContain(before[0]!.id);
  });
});
