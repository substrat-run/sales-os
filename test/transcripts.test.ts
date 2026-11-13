import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { manualClock, type ScopeStub } from '@substrat-run/kernel';
import type { Page } from '@substrat-run/contracts';
import type { SqliteScopeHost } from '@substrat-run/adapter-sqlite';
import { buildSalesHost, seedSales, type SalesWorld } from '../src/seed.js';
import type { CompanyRow, MeetingRow, TranscriptSegmentRow } from '../src/module.js';
import { CLIP_MAX_BYTES, mountApi } from '../src/routes.js';
import { bindingTranscriber, httpTranscriber, resolveBindingTranscriber, resolveLocalTranscriber, type Transcriber } from '../src/transcribe.js';

// ============================================================================
// Transcripts. What is ours: who may save, read and correct one, that the words stay out of every event, that the clip
// route asks the kernel before it touches a model and says plainly when there is none, and that each way of reaching the
// model reads its answer the same. The model itself is a scripted stand-in: no test needs a network or an account.
// ============================================================================

describe('transcripts', () => {
  let dir: string;
  let host: SqliteScopeHost;
  let w: SalesWorld;
  let markus: ScopeStub;
  let nora: ScopeStub;
  let rex: ScopeStub;
  const clock = manualClock('2026-11-10T09:00:00.000Z');
  let meeting: MeetingRow;
  const WORDS = 'Vi behöver ett nytt bokningssystem';

  const asked: { bytes: number; language?: string | undefined }[] = [];
  const scripted: Transcriber = async (audio, language) => {
    asked.push({ bytes: audio.length, language });
    return { text: WORDS, segments: [{ start: 0, end: 3.2, text: WORDS }], language: 'sv' };
  };
  let who: 'markus' | 'nora' | 'rex' = 'nora';
  let model: { transcribe: Transcriber } | { reason: string } = { transcribe: scripted };
  const app = new Hono();

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'substrat-sales-os-transcripts-'));
    host = buildSalesHost(dir, { clock: clock.read });
    w = await seedSales(host, dir);
    markus = await host.getScope(w.markus, w.t1, w.s1);
    nora = await host.getScope(w.nora, w.t1, w.s1);
    rex = await host.getScope(w.rex, w.t2, w.s2);
    mountApi(app, async () => (who === 'rex' ? rex : who === 'markus' ? markus : nora), undefined, undefined, () => model);
    const company = await markus.invoke<CompanyRow>('sales/create-company', { companyName: 'Acme AB', source: 'test' });
    meeting = await nora.invoke<MeetingRow>('sales/create-meeting', { companyId: company.id, title: 'Intro', startsAt: '2026-11-12T10:00:00.000Z' });
  });
  afterAll(async () => {
    await host.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const clip = (n = 4000) => new Uint8Array(n).fill(7);
  const post = (path: string, body: Uint8Array) => app.request(path, { method: 'POST', headers: { 'content-type': 'audio/wav' }, body });

  it('1. a member saves a transcript, an admin reads it in order, and the other workspace gets nothing', async () => {
    const saved = await nora.invoke<{ saved: number }>('sales/save-transcript', {
      meetingId: meeting.id,
      recordingId: 'rec-1',
      language: 'sv',
      segments: [
        { startMs: 0, endMs: 3200, text: WORDS },
        { startMs: 3200, endMs: 6000, text: 'Hello, and thanks for joining' },
        { startMs: 6000, endMs: 9000, text: 'Tack för att ni kom' },
      ],
    });
    expect(saved.saved).toBe(3);
    const read = await markus.invoke<Page<TranscriptSegmentRow>>('sales/list-transcript', { meetingId: meeting.id });
    expect(read.entries.map((s) => s.seq)).toEqual([0, 1, 2]);
    expect(read.entries[0]).toMatchObject({ text: WORDS, language: 'sv', created_by: w.nora, corrected_at: null });
    // The other workspace sees no passage, for the same meeting id.
    expect((await rex.invoke<Page<TranscriptSegmentRow>>('sales/list-transcript', { meetingId: meeting.id })).entries).toEqual([]);
    await expect(rex.invoke('sales/save-transcript', { meetingId: meeting.id, segments: [{ startMs: 0, endMs: 1, text: 'x' }] })).rejects.toThrow(/not found/);
  });

  it('2. saving a recording’s transcript twice is refused, not duplicated', async () => {
    await expect(
      nora.invoke('sales/save-transcript', { meetingId: meeting.id, recordingId: 'rec-1', segments: [{ startMs: 0, endMs: 1, text: 'again' }] }),
    ).rejects.toThrow(/already has a transcript/);
    // …the control: a different recording is its own transcript.
    await nora.invoke('sales/save-transcript', { meetingId: meeting.id, recordingId: 'rec-2', segments: [{ startMs: 0, endMs: 1, text: 'second' }] });
  });

  it('3. a correction changes the words and says a person made it', async () => {
    const [first] = (await markus.invoke<Page<TranscriptSegmentRow>>('sales/list-transcript', { meetingId: meeting.id })).entries;
    const fixed = await markus.invoke<TranscriptSegmentRow>('sales/update-transcript-segment', { segmentId: first!.id, text: 'Vi behöver ett nytt system' });
    expect(fixed).toMatchObject({ text: 'Vi behöver ett nytt system', corrected_by: w.markus });
    expect(fixed.corrected_at).toBeTruthy();
  });

  it('4. the words are in no event: the trail says a transcript exists, never what was said', async () => {
    const history = await markus.invoke<Page<{ type: string; payload: unknown }>>('sales/audit', { entityType: 'meeting', entityId: meeting.id });
    const types = history.entries.map((e) => e.type);
    expect(types).toContain('sales.transcript-saved');
    const everything = JSON.stringify(history.entries);
    expect(everything).not.toContain('bokningssystem');
    expect(everything).not.toContain('Hello, and thanks');
    const seg = (await markus.invoke<Page<TranscriptSegmentRow>>('sales/list-transcript', { meetingId: meeting.id })).entries[0]!;
    const segHistory = await markus.invoke<Page<{ type: string }>>('sales/audit', { entityType: 'transcript_segment', entityId: seg.id });
    expect(segHistory.entries.map((e) => e.type)).toContain('sales.transcript-corrected');
    expect(JSON.stringify(segHistory.entries)).not.toContain('nytt system');
  });

  it('5. the clip route asks the kernel first, then the model, and returns the text', async () => {
    who = 'nora';
    const ok = await post(`/api/meetings/${meeting.id}/transcribe?language=sv`, clip());
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ text: WORDS, language: 'sv', segments: [{ start: 0, end: 3.2, text: WORDS }] });
    expect(asked.at(-1)).toEqual({ bytes: 4000, language: 'sv' });
    // A language the screen does not offer is not passed on.
    await post(`/api/meetings/${meeting.id}/transcribe?language=xx`, clip());
    expect(asked.at(-1)!.language).toBeUndefined();
  });

  it('6. the clip route refuses what it should, and a refusal never reaches the model', async () => {
    const before = asked.length;
    who = 'rex'; // another workspace: the meeting does not exist there
    expect((await post(`/api/meetings/${meeting.id}/transcribe`, clip())).status).toBe(404);
    who = 'nora';
    expect((await post(`/api/meetings/${meeting.id}/transcribe`, new Uint8Array(0))).status).toBe(400);
    expect((await post(`/api/meetings/${meeting.id}/transcribe`, clip(CLIP_MAX_BYTES + 1))).status).toBe(400);
    expect(asked.length).toBe(before);
  });

  it('7. with no model the route says so in plain words, and the status says why', async () => {
    model = { reason: 'Transcription is not set up on this deployment yet.' };
    const res = await post(`/api/meetings/${meeting.id}/transcribe`, clip());
    expect(res.status).toBe(503);
    expect(JSON.stringify(await res.json())).toContain('not set up');
    const status = (await (await app.request('/api/transcription/status')).json()) as { available: boolean; reason?: string };
    expect(status).toMatchObject({ available: false });
    model = { transcribe: scripted };
    expect(((await (await app.request('/api/transcription/status')).json()) as { available: boolean }).available).toBe(true);
  });

  it('8. a model that fails is a plain sentence, never the provider’s own words', async () => {
    model = { transcribe: async () => { throw new Error('upstream said: secret internal detail'); } };
    const res = await post(`/api/meetings/${meeting.id}/transcribe`, clip());
    expect(res.status).toBe(503);
    expect(JSON.stringify(await res.json())).not.toContain('secret internal detail');
    model = { transcribe: scripted };
  });

  it('9. the binding and the HTTP way read the same answer, and neither repeats a failure’s text', async () => {
    const answer = { text: 'hej', transcription_info: { language: 'sv' }, segments: [{ start: 0, end: 1, text: ' hej ' }] };
    const calls: unknown[] = [];
    const viaBinding = await bindingTranscriber({ run: async (m, i) => { calls.push([m, Object.keys(i)]); return answer; } })(new Uint8Array([1, 2, 3]), 'sv');
    const viaHttp = await httpTranscriber('acct', 'tok', (async () => new Response(JSON.stringify({ result: answer }))) as typeof fetch)(new Uint8Array([1, 2, 3]), 'sv');
    expect(viaBinding).toEqual({ text: 'hej', segments: [{ start: 0, end: 1, text: 'hej' }], language: 'sv' });
    expect(viaHttp).toEqual(viaBinding);
    expect(calls[0]).toEqual(['@cf/openai/whisper-large-v3-turbo', expect.arrayContaining(['audio', 'language'])]);
    await expect(
      httpTranscriber('acct', 'tok', (async () => new Response('token tok is invalid', { status: 401 })) as typeof fetch)(new Uint8Array([1])),
    ).rejects.toThrow(/^transcription failed \(401\)$/);
    // No text and no segments is an empty clip, not an error.
    expect(await bindingTranscriber({ run: async () => ({}) })(new Uint8Array([1]))).toEqual({ text: '', segments: [], language: null });
  });

  it('10. each host says what it lacks', () => {
    expect(resolveLocalTranscriber({})).toMatchObject({ reason: expect.stringContaining('CLOUDFLARE_AI_API_TOKEN') });
    expect(resolveLocalTranscriber({ CLOUDFLARE_ACCOUNT_ID: 'a', CLOUDFLARE_AI_API_TOKEN: 't' })).toHaveProperty('transcribe');
    expect(resolveBindingTranscriber(undefined)).toMatchObject({ reason: expect.stringContaining('not set up') });
    expect(resolveBindingTranscriber({ run: async () => ({}) })).toHaveProperty('transcribe');
  });
});
