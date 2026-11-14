import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { manualClock, type ScopeStub } from '@substrat-run/kernel';
import type { Page, PrincipalId } from '@substrat-run/contracts';
import type { SqliteScopeHost } from '@substrat-run/adapter-sqlite';
import { mountUploadLinkRedeem } from '@substrat-run/vertical-host';
import { buildSalesHost, seedSales, type SalesWorld } from '../src/seed.js';
import type { CompanyRow, MeetingRow, TranscriptRunRow, TranscriptSegmentRow, TranscriptSpeakerRow } from '../src/module.js';
import { mountApi } from '../src/routes.js';
import { TRANSCRIPTION_MODELS, grokClipOf, type Transcribe } from '../src/transcribe.js';

// ============================================================================
// Transcript versions: a stored recording transcribed again with a model the person picks. What is ours: that every run is
// kept as a version, that the earlier one is never touched, who may switch the current one, the limit on runs, that a model
// is refused when it cannot take the file or cannot label speakers, that a failure closes the run with a plain sentence, that
// the other workspace sees nothing, and that the words and the names stay out of every event. The models are scripted stand-ins.
// ============================================================================

describe('transcript versions', () => {
  let dir: string;
  let host: SqliteScopeHost;
  let w: SalesWorld;
  let markus: ScopeStub;
  let nora: ScopeStub;
  let rex: ScopeStub;
  const clock = manualClock('2026-11-10T09:00:00.000Z');
  let meeting: MeetingRow;
  let recordingId: string;
  const WORDS = 'Vi behöver ett nytt bokningssystem';
  const SECRET = 'Hemligt kundnamn Berglund';

  const calls: { model: string; diarize?: boolean | undefined; mime?: string | undefined }[] = [];
  const scripted: Transcribe = async (model, _audio, options) => {
    calls.push({ model, diarize: options?.diarize, mime: options?.mime });
    return {
      text: WORDS,
      language: 'sv',
      segments: options?.diarize
        ? [
            { start: 0, end: 2, text: WORDS, speaker: 1 },
            { start: 2, end: 4, text: SECRET, speaker: 2 },
            { start: 4, end: 6, text: 'Tack', speaker: 1 },
          ]
        : [{ start: 0, end: 4, text: WORDS }],
    };
  };
  let model: { transcribe: Transcribe } | { reason: string } = { transcribe: scripted };
  let who: 'markus' | 'nora' | 'rex' = 'nora';
  const principals = (): [ScopeStub, PrincipalId, string, string] =>
    who === 'rex' ? [rex, w.rex, w.t2, w.s2] : who === 'markus' ? [markus, w.markus, w.t1, w.s1] : [nora, w.nora, w.t1, w.s1];
  const app = new Hono();
  const again = (body: unknown, id = meeting.id) =>
    app.request(`/api/meetings/${id}/transcribe-again`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const runs = async () => (await markus.invoke<Page<TranscriptRunRow>>('sales/list-transcript-runs', { meetingId: meeting.id })).entries;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'substrat-sales-os-runs-'));
    host = buildSalesHost(dir, { clock: clock.read });
    w = await seedSales(host, dir);
    markus = await host.getScope(w.markus, w.t1, w.s1);
    nora = await host.getScope(w.nora, w.t1, w.s1);
    rex = await host.getScope(w.rex, w.t2, w.s2);
    mountUploadLinkRedeem(app, { host: () => host, node: async () => ({ tenantId: w.t1, scopeId: w.s1 }) });
    mountApi(
      app,
      async () => principals()[0],
      undefined,
      async () => {
        const [, principal, t, s] = principals();
        return host.attachments(principal, t as never, s as never);
      },
      () => model,
    );
    const company = await markus.invoke<CompanyRow>('sales/create-company', { companyName: 'Acme AB', source: 'test' });
    meeting = await nora.invoke<MeetingRow>('sales/create-meeting', { companyId: company.id, title: 'Intro', startsAt: '2026-11-12T10:00:00.000Z' });
    const { url } = await nora.invoke<{ url: string }>('sales/start-recording', { meetingId: meeting.id, consent: true });
    const res = await app.request(url + '?filename=intro.webm', { method: 'PUT', headers: { 'content-type': 'audio/webm' }, body: new Uint8Array(4096).fill(3) });
    recordingId = ((await res.json()) as { id: string }).id;
  });
  afterAll(async () => {
    await host.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('1. a live transcript is a version: the first is current, and the default read returns it', async () => {
    const saved = await nora.invoke<{ saved: number; runId: string }>('sales/save-transcript', {
      meetingId: meeting.id,
      recordingId,
      language: 'sv',
      model: 'whisper',
      segments: [{ startMs: 0, endMs: 3000, text: WORDS }],
    });
    expect(saved.saved).toBe(1);
    const [run] = await runs();
    expect(run).toMatchObject({ id: saved.runId, model: 'whisper', source: 'live', status: 'done', is_current: 1, segment_count: 1, recording_id: recordingId });
    const read = await markus.invoke<Page<TranscriptSegmentRow>>('sales/list-transcript', { meetingId: meeting.id });
    expect(read.entries).toHaveLength(1);
    expect(read.entries[0]).toMatchObject({ run_id: saved.runId, speaker: null });
  });

  it('2. transcribing again needs the tick, keeps the first version untouched, and the new one is not shown until chosen', async () => {
    const bare = await again({ recordingId, model: 'grok-stt', diarize: true, consent: false });
    expect(bare.status).toBeGreaterThanOrEqual(400);
    expect(await runs()).toHaveLength(1); // the refusal started nothing
    who = 'markus';
    const res = await again({ recordingId, model: 'grok-stt', language: 'sv', diarize: true, consent: true });
    expect(res.status).toBe(200);
    expect(calls.at(-1)).toMatchObject({ model: 'grok-stt', diarize: true, mime: 'audio/webm' });
    const all = await runs();
    expect(all.map((r) => [r.model, r.source, r.status, r.is_current])).toEqual([
      ['whisper', 'live', 'done', 1],
      ['grok-stt', 'again', 'done', 0],
    ]);
    // The default read is still the first version.
    const current = await markus.invoke<Page<TranscriptSegmentRow>>('sales/list-transcript', { meetingId: meeting.id });
    expect(current.entries.map((s) => s.text)).toEqual([WORDS]);
    // The new one, asked for by id, carries the speakers the model gave.
    const second = await markus.invoke<Page<TranscriptSegmentRow>>('sales/list-transcript', { meetingId: meeting.id, runId: all[1]!.id });
    expect(second.entries.map((s) => [s.speaker, s.start_ms, s.end_ms])).toEqual([[1, 0, 2000], [2, 2000, 4000], [1, 4000, 6000]]);
  });

  it('3. a colleague switches which version is current; only a finished one can be', async () => {
    const [first, second] = await runs();
    who = 'nora';
    const switched = await nora.invoke<TranscriptRunRow>('sales/set-current-transcript-run', { runId: second!.id });
    expect(switched.is_current).toBe(1);
    expect((await runs()).map((r) => r.is_current)).toEqual([0, 1]);
    const read = await markus.invoke<Page<TranscriptSegmentRow>>('sales/list-transcript', { meetingId: meeting.id });
    expect(read.entries.map((s) => s.text)).toEqual([WORDS, SECRET, 'Tack']);
    await nora.invoke('sales/set-current-transcript-run', { runId: first!.id });
    expect((await runs()).map((r) => r.is_current)).toEqual([1, 0]);
  });

  it('4. a speaker is named once for one version only; the event names the number and never the name', async () => {
    const [, second] = await runs();
    const named = await nora.invoke<TranscriptSpeakerRow>('sales/rename-transcript-speaker', { runId: second!.id, number: 2, name: 'Anna Berglund' });
    expect(named).toMatchObject({ run_id: second!.id, number: 2, name: 'Anna Berglund' });
    await nora.invoke('sales/rename-transcript-speaker', { runId: second!.id, number: 2, name: 'Anna B' }); // a rename, not a second row
    expect((await markus.invoke<Page<TranscriptSpeakerRow>>('sales/list-transcript-speakers', { runId: second!.id })).entries.map((s) => [s.number, s.name])).toEqual([[2, 'Anna B']]);
    expect((await markus.invoke<Page<TranscriptSpeakerRow>>('sales/list-transcript-speakers', { runId: (await runs())[0]!.id })).entries).toEqual([]);
    // The words and the names stay out of every event, on the meeting and on each run and speaker.
    const events: string[] = [];
    for (const [entityType, entityId] of [['meeting', meeting.id], ...(await runs()).map((r) => ['transcript_run', r.id])] as const) {
      const h = await markus.invoke<Page<{ type: string; payload: unknown }>>('sales/audit', { entityType, entityId });
      events.push(JSON.stringify(h.entries));
    }
    const all = events.join('\n');
    expect(all).toContain('sales.transcript-run-finished');
    for (const secret of [WORDS, SECRET, 'Anna']) expect(all).not.toContain(secret);
  });

  it('5. a model that cannot label speakers is refused for it, one that cannot take the file is not tried, and an unknown model is refused', async () => {
    who = 'markus';
    const noLabels = await again({ recordingId, model: 'whisper', diarize: true, consent: true });
    expect(noLabels.status).toBe(400);
    expect(((await noLabels.json()) as { error: string }).error).toMatch(/does not label who is speaking/);
    expect((await again({ recordingId, model: 'nova-9', consent: true })).status).toBe(400);
    // A recording longer than the model takes: the person is told why, and nothing is started.
    who = 'nora';
    const { url } = await nora.invoke<{ url: string }>('sales/start-recording', { meetingId: meeting.id, consent: true });
    const big = await app.request(url + '?filename=long.webm', { method: 'PUT', headers: { 'content-type': 'audio/webm' }, body: new Uint8Array(5 * 1024 * 1024).fill(1) });
    const bigId = ((await big.json()) as { id: string }).id;
    const before = (await runs()).length;
    const refused = await again({ recordingId: bigId, model: 'whisper', consent: true });
    expect(refused.status).toBe(400);
    expect(((await refused.json()) as { error: string }).error).toMatch(/takes recordings up to about \d+ minutes/);
    expect((await runs()).length).toBe(before);
    expect(TRANSCRIPTION_MODELS.find((m) => m.key === 'grok-stt')).toMatchObject({ speakers: true, processors: ['Cloudflare', 'xAI'] });
  });

  it('6. a failing model closes the run with a plain sentence, leaves the earlier version current, and still counts toward the limit', async () => {
    who = 'markus';
    model = { transcribe: async () => { throw new Error('upstream said: secret internal detail'); } };
    const res = await again({ recordingId, model: 'whisper', consent: true });
    expect(res.status).toBeGreaterThanOrEqual(500);
    const body = JSON.stringify(await res.json());
    expect(body).not.toContain('secret internal detail');
    const failed = (await runs()).at(-1)!;
    expect(failed).toMatchObject({ status: 'failed', is_current: 0, failure: 'The transcription service did not answer. Try again.' });
    expect((await runs()).find((r) => r.is_current)!.model).toBe('whisper');
    // No speech at all is its own sentence.
    model = { transcribe: async () => ({ text: '', segments: [], language: null }) };
    const none = await again({ recordingId, model: 'whisper', consent: true });
    expect(none.status).toBeGreaterThanOrEqual(500);
    expect((await runs()).at(-1)!.failure).toBe('No speech was found in this recording.');
    // Five runs for this recording now exist (live, again, two failures, and one more would be the sixth).
    model = { transcribe: scripted };
    expect((await again({ recordingId, model: 'whisper', consent: true })).status).toBe(200); // the fifth
    const sixth = await again({ recordingId, model: 'whisper', consent: true });
    expect(sixth.status).toBe(409);
    expect(((await sixth.json()) as { error: string }).error).toMatch(/reached 5 transcripts/);
  });

  it('7. a run left "running" by a host that stopped does not block a retry once it is stale; a fresh one does', async () => {
    const meeting2 = await nora.invoke<MeetingRow>('sales/create-meeting', { companyId: meeting.company_id, title: 'Second', startsAt: '2026-11-13T10:00:00.000Z' });
    const start = () => nora.invoke<TranscriptRunRow>('sales/start-transcript-run', { meetingId: meeting2.id, recordingId: 'rec-x', model: 'whisper', consent: true });
    await start();
    await expect(start()).rejects.toThrow(/already being transcribed/);
    clock.advance(20 * 60_000);
    await expect(start()).resolves.toMatchObject({ status: 'running' });
  });

  it('8. the other workspace sees no versions, cannot transcribe the recording, and cannot name a speaker', async () => {
    who = 'rex';
    expect((await rex.invoke<Page<TranscriptRunRow>>('sales/list-transcript-runs', { meetingId: meeting.id })).entries).toEqual([]);
    expect((await again({ recordingId, model: 'whisper', consent: true })).status).toBe(404);
    const [first] = await runs();
    await expect(rex.invoke('sales/rename-transcript-speaker', { runId: first!.id, number: 1, name: 'X' })).rejects.toThrow(/not found/);
    await expect(rex.invoke('sales/set-current-transcript-run', { runId: first!.id })).rejects.toThrow(/not found/);
  });

  it('9. Grok’s words become passages: split on speaker, pause and sentence, with speakers numbered from 1 in order of appearance', () => {
    const w = (text: string, start: number, end: number, speaker?: number) => ({ text, start, end, ...(speaker === undefined ? {} : { speaker }) });
    const clip = grokClipOf({
      state: 'Completed',
      result: {
        text: 'Hej Anna. Hej då',
        language: 'Swedish',
        words: [w('Hej', 0, 0.4, 3), w('Anna.', 0.5, 0.9, 3), w('Hej', 1.0, 1.2, 7), w('då', 1.3, 1.6, 7), w('Sen', 5.0, 5.4, 7)],
      },
    });
    expect(clip.language).toBe('sv');
    expect(clip.segments).toEqual([
      { start: 0, end: 0.9, text: 'Hej Anna.', speaker: 1 },
      { start: 1.0, end: 1.6, text: 'Hej då', speaker: 2 },
      { start: 5.0, end: 5.4, text: 'Sen', speaker: 2 },
    ]);
    // Without speakers there are none, and an empty answer is an empty clip.
    expect(grokClipOf({ result: { text: 'hej', words: [w('hej', 0, 1)] } }).segments).toEqual([{ start: 0, end: 1, text: 'hej' }]);
    expect(grokClipOf({})).toEqual({ text: '', segments: [], language: null });
  });
});
