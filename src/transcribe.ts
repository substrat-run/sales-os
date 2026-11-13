// ============================================================================
// Turning a clip of speech into text. A HOST concern: it calls a model over the network, which module code may not
// do, so the clip route in `routes.ts` calls this and the operations never see audio. Both entrypoints supply one:
// the worker through the Workers AI binding (`env.AI`, no key), the local server through Cloudflare's HTTP API with a
// token held in the environment. A host with neither says so, and recording is unaffected.
// ============================================================================

/** The model: Whisper large-v3-turbo handles Swedish and English, and takes a finished clip rather than a stream. */
export const TRANSCRIBE_MODEL = '@cf/openai/whisper-large-v3-turbo';

export interface TranscribedClip {
  text: string;
  /** Passages with times in SECONDS from the start of the clip. */
  segments: { start: number; end: number; text: string }[];
  language: string | null;
}
export type Transcriber = (audio: Uint8Array, language?: string) => Promise<TranscribedClip>;

/** The slice of Cloudflare's `Ai` binding this uses. */
export interface AiBinding {
  run(model: string, input: Record<string, unknown>): Promise<unknown>;
}

function toBase64(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

/** What Workers AI answers for Whisper, reduced to what the screen needs. Tolerates a missing `segments`. */
function clipOf(raw: unknown): TranscribedClip {
  const r = (raw ?? {}) as {
    text?: string;
    transcription_info?: { language?: string };
    segments?: { start?: number; end?: number; text?: string }[];
  };
  const segments = (r.segments ?? [])
    .map((s) => ({ start: s.start ?? 0, end: s.end ?? s.start ?? 0, text: (s.text ?? '').trim() }))
    .filter((s) => s.text);
  const text = (r.text ?? segments.map((s) => s.text).join(' ')).trim();
  return { text, segments: segments.length ? segments : text ? [{ start: 0, end: 0, text }] : [], language: r.transcription_info?.language ?? null };
}

/** Through the binding: nothing to hold, leak or rotate. */
export function bindingTranscriber(ai: AiBinding): Transcriber {
  return async (audio, language) =>
    clipOf(await ai.run(TRANSCRIBE_MODEL, { audio: toBase64(audio), ...(language ? { language } : {}), vad_filter: true }));
}

/** Over Cloudflare's HTTP API, for a host with no binding (the local server). */
export function httpTranscriber(accountId: string, token: string, fetchImpl: typeof fetch = fetch): Transcriber {
  return async (audio, language) => {
    const res = await fetchImpl(`https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/run/${TRANSCRIBE_MODEL}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ audio: toBase64(audio), ...(language ? { language } : {}), vad_filter: true }),
    });
    // The provider's own words are not repeated to the screen.
    if (!res.ok) throw new Error(`transcription failed (${res.status})`);
    const body = (await res.json()) as { result?: unknown };
    return clipOf(body.result);
  };
}

export type TranscriberChoice = { transcribe: Transcriber } | { reason: string };

/** The local server: a token and an account in the environment, or an honest reason there is none. */
export function resolveLocalTranscriber(env: Record<string, string | undefined>): TranscriberChoice {
  const accountId = env.CLOUDFLARE_ACCOUNT_ID;
  const token = env.CLOUDFLARE_AI_API_TOKEN;
  if (!accountId || !token) {
    return { reason: 'Transcription is not set up: set CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_AI_API_TOKEN where the server runs.' };
  }
  return { transcribe: httpTranscriber(accountId, token) };
}

/** The worker: the platform's Workers AI binding, if this install was given one. */
export function resolveBindingTranscriber(ai: AiBinding | undefined): TranscriberChoice {
  return ai ? { transcribe: bindingTranscriber(ai) } : { reason: 'Transcription is not set up on this deployment yet.' };
}
