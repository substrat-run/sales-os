import type { Context, Hono } from 'hono';
import { substratError, z } from '@substrat-run/contracts';
import type { ScopeAttachments, ScopeStub } from '@substrat-run/kernel';
import { externalInput, externalJson, mountOperations, problemResponse, type ResolveStub } from '@substrat-run/vertical-host';
import { assistantRoutes, salesOperations } from './operations.js';
import { TRANSCRIPTION_MODEL_KEYS } from './entities.js';
import { TRANSCRIPTION_MODELS, estimatedMinutes, modelInfo, type TranscriberChoice } from './transcribe.js';

/**
 * The Sales OS HTTP API — derived from the declared operations, adapter- and
 * auth-agnostic.
 *
 * Both entrypoints mount this: `server.ts` (node, pure-SQLite adapter, OIDC against the
 * local dev issuer) and `worker.ts` (Cloudflare, Durable-Object adapter, the auth seam). Each
 * supplies a `resolveStub` that authenticates the caller its own way and returns a
 * capability `ScopeStub`; every route is a thin wrapper over ONE operation, with no
 * business logic — the rules live in an operation or an engine.
 *
 * Sharing the table is the point. A route added to only one entrypoint is a surface
 * that exists in dev and 404s in production (or the reverse), and nothing catches it
 * until deploy: the scenario tests call operations directly and never boot either host.
 * What each entrypoint still owns is only what is genuinely its own: how it builds a
 * host, how it resolves a caller, and its own auth-shaped routes (`/api/auth/*` and
 * `/api/me` in dev, `/api/me` in the worker) — those answer "who am I on THIS host"
 * and cannot be shared.
 *
 * ## Why there is no table here
 *
 * There was one, and every line of it restated something the operations already
 * declare: the method, the path, which input fields the path carries, and — for a
 * paged read — that the page trio must be forwarded in and the entries handed back
 * as the body with the walk in a `Link` header. Two helpers held that last part
 * together by hand, and every route that invoked a paged operation had to remember
 * to call both. `mountOperations` derives all of it from the `http` each operation
 * declares in `src/operations.ts`: it orders static path segments ahead of their
 * parameter siblings, coerces query values per the declared shape, pins a
 * `z.literal` input the caller must not choose, projects a `Page<T>` onto the wire,
 * and turns the kernel's own refusals into their status. A new operation is on
 * both hosts the moment it declares `http`, and there is no second list to drift.
 */
export type { ResolveStub };

/**
 * Runs the assistant for a question a person has asked. A HOST concern (it calls a model, which module code
 * may not), so each entrypoint supplies it; an entrypoint that cannot yet leaves it out and the route says so.
 */
export type RunAssistant = (c: Context, person: ScopeStub, threadId: string) => Promise<void>;

/**
 * The caller's attachment surface (list, open, remove), as that caller. A HOST concern: it needs the signed-in person's id,
 * which the local server has and the deployed worker's door does not hand a route yet, so the worker leaves it out and the
 * recording routes say so.
 */
export type ResolveAttachments = (c: Context) => Promise<ScopeAttachments>;

/** Which transcriber this host has, per request (the worker reads its binding off the request's environment). */
export type ResolveTranscriber = (c: Context) => TranscriberChoice;

/** The longest clip the route accepts: ten seconds of 16 kHz speech is about 320 kB; this leaves room for a long one. */
export const CLIP_MAX_BYTES = 2 * 1024 * 1024;

/** Every operation that carries a URL. Sales OS composes no engine, so these are its own. */
const ROUTED = { ...salesOperations, ...assistantRoutes };

export function mountApi(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  app: Hono<any, any, any>,
  resolveStub: ResolveStub,
  runAssistant?: RunAssistant,
  attachments?: ResolveAttachments,
  transcriber?: ResolveTranscriber,
): { operation: string; method: string; path: string }[] {
  /**
   * One error vocabulary, shared with the platform surface: `problemResponse`
   * (@substrat-run/vertical-host) is built on the same `classifyError` that
   * `mountPlatformSurface` uses, so a permission denial is 403, a missing thing 404, a
   * broken invariant 409, a runtime fault 502 — identically on both hosts. "No opinion"
   * becomes the caller's 400.
   *
   * The body is RFC 9457 `application/problem+json`: a `code` from the closed taxonomy
   * when your throw declared one (`substratError('conflict', …)`), `about:blank` when it
   * did not. `{ error }` rides along for one deprecation window, so a client reading it
   * keeps working while you move to `code`.
   *
   * In `worker.ts` this handler is REPLACED: Hono keeps only the last-registered
   * `onError`, and `mountPlatformSurface` installs its own. That is harmless precisely
   * because both are built on the same vocabulary — same input, same answer. Registering
   * it here is what gives `server.ts`, which mounts no platform surface, the same
   * behaviour.
   */
  app.onError((err, c: Context) => problemResponse(c, err));

  // The one hand-written route, registered BEFORE the derived table so the
  // exception always wins. The kernel checks a permission inside EVERY operation,
  // so a generic route is exactly as safe as one route per operation — and it is
  // what keeps an operation reachable that has no URL of its own: an engine
  // operation this vertical deliberately did not bind (`workorder/complete`, which
  // `shop/complete-repair` wraps) is still callable here, on BOTH hosts.
  app.post('/api/invoke', async (c) => {
    const { op, input } = await c.req.json<{ op: string; input?: unknown }>();
    // Through the platform's one door (#2073), as the derived routes are: a caller cannot ask
    // for a page's row cursors, and none ever leave in a response.
    return externalJson(c, (await (await resolveStub(c)).invoke(op, externalInput(input))) ?? null);
  });

  // Whether this host can answer questions at all. A host that cannot run the model loop (the deployed worker, today)
  // must not be offered as one: the screen asks this before it shows Ask, so nobody types a question into a dead end.
  app.get('/api/assistant/status', async (c) => {
    await resolveStub(c);
    return c.json({ available: Boolean(runAssistant) });
  });

  // Take the turn a person opened with `assistant/send-message` and write the assistant's answer. The person's
  // stub does every read (a thread that is not theirs is `not_found`), so this is no way round a permission.
  // The client polls `assistant/read-events` meanwhile; this resolves once the turn is closed.
  app.post('/api/assistant/threads/:threadId/run', async (c) => {
    const person = await resolveStub(c);
    if (!runAssistant) throw substratError('unavailable', 'The assistant is not available on this host yet.');
    await runAssistant(c, person, c.req.param('threadId'));
    return c.json({ ok: true });
  });

  // A meeting's recordings. Starting one (`POST /api/meetings/{id}/recordings`, derived from `sales/start-recording`) is
  // an operation; these three move or remove BYTES, which never ride an operation. Each acts as the caller, so the
  // meeting's `crm:read` / `crm:write` decide, and each says plainly when this host cannot serve them.
  const files = async (c: Context): Promise<ScopeAttachments> => {
    await resolveStub(c); // 401 for nobody, before anything else
    if (!attachments) throw substratError('unavailable', 'Recordings are not available on this host yet.');
    return attachments(c);
  };
  app.get('/api/meetings/:meetingId/recordings', async (c) => {
    const list = await (await files(c)).list({ entityType: 'meeting', entityId: c.req.param('meetingId') });
    return c.json(list);
  });
  // Always a download, never run as our origin: audio is played by an <audio> element, which is unaffected.
  app.get('/api/recordings/:attachmentId', async (c) => {
    const opened = await (await files(c)).openStream(c.req.param('attachmentId'));
    if (!opened) throw substratError('not_found', 'recording not found');
    return new Response(opened.body.stream as unknown as ReadableStream, {
      headers: {
        'content-type': opened.contentType,
        'content-length': String(opened.body.length),
        'content-disposition': 'attachment',
        'x-content-type-options': 'nosniff',
        'content-security-policy': "default-src 'none'; sandbox",
        'cache-control': 'private, no-store',
      },
    });
  });
  app.delete('/api/recordings/:attachmentId', async (c) => {
    const removed = await (await files(c)).remove(c.req.param('attachmentId'));
    if (!removed) throw substratError('not_found', 'recording not found');
    return c.body(null, 204);
  });

  // Whether this host can turn speech into text, and which models it offers, so the recorder and the "transcribe again" panel
  // offer only what can run. Each model says what it can do, who handles the audio and what it costs.
  const transcriptionStatus = (c: Context) => {
    const choice = transcriber?.(c);
    const available = Boolean(choice && 'transcribe' in choice);
    return {
      available,
      ...(available ? {} : { reason: choice && 'reason' in choice ? choice.reason : 'Transcription is not available on this host yet.' }),
      models: TRANSCRIPTION_MODELS.map((m) => ({ ...m })),
    };
  };
  app.get('/api/transcription/status', async (c) => {
    await resolveStub(c);
    return c.json(transcriptionStatus(c));
  });
  app.get('/api/transcription/models', async (c) => {
    await resolveStub(c);
    return c.json(transcriptionStatus(c));
  });

  // One clip of speech in, text out. It holds no data: the audio is passed to the model and dropped. The kernel decides
  // who may (`sales/open-transcription`, `crm:write`), and a person who may not never reaches the model.
  app.post('/api/meetings/:meetingId/transcribe', async (c) => {
    const person = await resolveStub(c);
    await person.invoke('sales/open-transcription', { meetingId: c.req.param('meetingId') });
    const choice = transcriber?.(c);
    if (!choice || !('transcribe' in choice)) {
      throw substratError('unavailable', choice && 'reason' in choice ? choice.reason : 'Transcription is not available on this host yet.');
    }
    const asked = c.req.query('model') ?? 'whisper';
    const info = modelInfo(asked);
    if (!info || !info.live) throw substratError('validation_failed', 'that model cannot transcribe while recording');
    const declared = Number(c.req.header('content-length') ?? 0);
    if (declared > CLIP_MAX_BYTES) throw substratError('validation_failed', 'that clip is too large');
    const audio = new Uint8Array(await c.req.arrayBuffer());
    if (audio.length === 0) throw substratError('validation_failed', 'the clip is empty');
    if (audio.length > CLIP_MAX_BYTES) throw substratError('validation_failed', 'that clip is too large');
    const language = c.req.query('language');
    try {
      // Speaker numbers would restart in every ten-second clip, so a live clip never asks for them: that is what a later run is for.
      return c.json(await choice.transcribe(info.key, audio, { language: language === 'sv' || language === 'en' ? language : undefined, mime: c.req.header('content-type') ?? undefined }));
    } catch {
      throw substratError('unavailable', 'The transcription service did not answer. Try again.');
    }
  });

  // A stored recording, transcribed again with a model the person picks. The kernel is asked first (the consent tick, the limit on
  // runs, the permission), the model runs here (module code may not call one), and what it returns is saved as a NEW version.
  const againBody = z.object({
    recordingId: z.string().min(1),
    model: z.enum(TRANSCRIPTION_MODEL_KEYS),
    language: z.enum(['sv', 'en']).optional(),
    diarize: z.boolean().optional(),
    consent: z.boolean(),
  });
  app.post('/api/meetings/:meetingId/transcribe-again', async (c) => {
    const person = await resolveStub(c);
    const parsed = againBody.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) throw substratError('validation_failed', 'choose a recording and a model');
    const body = parsed.data;
    const info = modelInfo(body.model)!;
    const choice = transcriber?.(c);
    if (!choice || !('transcribe' in choice)) {
      throw substratError('unavailable', choice && 'reason' in choice ? choice.reason : 'Transcription is not available on this host yet.');
    }
    const meetingId = c.req.param('meetingId');
    const recordings = await (await files(c)).list({ entityType: 'meeting', entityId: meetingId });
    const recording = recordings.find((r) => r.id === body.recordingId);
    if (!recording) throw substratError('not_found', 'recording not found');
    if (body.diarize && !info.speakers) throw substratError('validation_failed', `${info.label} does not label who is speaking`);
    // A model that cannot be given this file is not tried: the person is told why and can pick another.
    if (recording.size > info.maxBytes) {
      throw substratError(
        'validation_failed',
        `${info.label} takes recordings up to about ${estimatedMinutes(info.maxBytes)} minutes, and this one is about ${estimatedMinutes(recording.size)}. Pick another model.`,
      );
    }
    const run = await person.invoke<{ id: string }>('sales/start-transcript-run', {
      meetingId,
      recordingId: recording.id,
      model: body.model,
      ...(body.language ? { language: body.language } : {}),
      ...(body.diarize ? { diarize: true } : {}),
      consent: body.consent,
    });
    let reason = 'The transcription service did not answer. Try again.';
    try {
      const opened = await (await files(c)).open(recording.id);
      if (!opened) throw new Error('the recording could not be read');
      const clip = await choice.transcribe(body.model, opened.body, { language: body.language, diarize: body.diarize, mime: opened.contentType });
      const segments = clip.segments
        .filter((s) => s.text.trim())
        .map((s) => ({
          startMs: Math.round(s.start * 1000),
          endMs: Math.round(s.end * 1000),
          text: s.text.trim().slice(0, 4000),
          ...(s.speaker ? { speaker: s.speaker } : {}),
        }));
      if (!segments.length) {
        reason = 'No speech was found in this recording.';
        throw new Error('no speech');
      }
      return c.json(await person.invoke('sales/finish-transcript-run', { runId: run.id, ...(clip.language ? { language: clip.language } : {}), segments }));
    } catch {
      // The earlier transcript stays as it was. The provider's own words are never repeated; the run is closed with a plain sentence.
      await person.invoke('sales/fail-transcript-run', { runId: run.id, reason }).catch(() => undefined);
      throw substratError('unavailable', reason);
    }
  });

  // Returns what it mounted, in registration order — a test pins the complete
  // method/path set, so a derived table that mounted nothing, moved a path or
  // changed a verb fails loudly rather than passing over an empty app.
  return mountOperations(app, ROUTED, resolveStub);
}
