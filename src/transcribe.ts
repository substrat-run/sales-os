import { TRANSCRIPTION_MODEL_KEYS, type TranscriptionModelKey } from './entities.js';

// ============================================================================
// Turning speech into text. A HOST concern: it calls a model over the network, which module code may not do, so the
// routes in `routes.ts` call this and the operations never see audio. Both entrypoints supply one: the worker through
// the Workers AI binding (`env.AI`, no key; asked for with `substrat.usesModels`), the local server through Cloudflare's
// HTTP API with a token held in the environment. A host with neither says so, and recording is unaffected.
//
// Which models exist, and what each can do, is the list below: the dropdown reads it, and the operations hold only
// the KEYS (`TRANSCRIPTION_MODEL_KEYS`), so a model is never named in two places.
// ============================================================================

export interface TranscriptionModelInfo {
  key: TranscriptionModelKey;
  label: string;
  /** One plain line: what it is good for. */
  description: string;
  /** Who handles the audio while it is transcribed. The consent line names these. */
  processors: readonly string[];
  /** Can it be fed a ten-second clip while recording? */
  live: boolean;
  /** Does it say who is speaking? */
  speakers: boolean;
  /** List price, in US dollars per minute of audio (Cloudflare may change it). */
  usdPerMinute: number;
  /** The largest stored recording it is given, in bytes. Whisper's is a cautious figure: see the spec's risks. */
  maxBytes: number;
}

export const TRANSCRIPTION_MODELS: readonly TranscriptionModelInfo[] = [
  {
    key: 'whisper',
    label: 'Whisper large-v3-turbo',
    description: 'Swedish and English, no speaker labels. Hosted by Cloudflare.',
    processors: ['Cloudflare'],
    live: true,
    speakers: false,
    usdPerMinute: 0.000513,
    // Not confirmed against Workers AI's request limit; kept small on purpose (about 16 minutes at the recorder's bit rate).
    maxBytes: 4 * 1024 * 1024,
  },
  {
    key: 'grok-stt',
    label: 'Grok STT',
    description: 'Labels who is speaking. xAI’s model, reached through Cloudflare.',
    processors: ['Cloudflare', 'xAI'],
    live: true,
    speakers: true,
    usdPerMinute: 0.001667,
    // The gateway takes a file up to 25 MB.
    maxBytes: 25 * 1000 * 1000,
  },
];

export function modelInfo(key: string): TranscriptionModelInfo | undefined {
  return (TRANSCRIPTION_MODEL_KEYS as readonly string[]).includes(key) ? TRANSCRIPTION_MODELS.find((m) => m.key === key) : undefined;
}

/** The recorder writes about 32 kbit/s, so a stored file's length can be estimated from its size. */
export function estimatedMinutes(bytes: number): number {
  return Math.max(1, Math.round(bytes / (32_000 / 8) / 60));
}

export interface TranscribedPassage {
  start: number;
  end: number;
  text: string;
  /** 1, 2, 3… in order of first appearance, when the model says who is speaking. */
  speaker?: number;
}
export interface TranscribedClip {
  text: string;
  /** Passages with times in SECONDS from the start of the audio. */
  segments: TranscribedPassage[];
  language: string | null;
}
export interface TranscribeOptions {
  language?: string | undefined;
  diarize?: boolean | undefined;
  /** The audio's media type, for a model that wants it named. */
  mime?: string | undefined;
}
export type Transcribe = (model: TranscriptionModelKey, audio: Uint8Array, options?: TranscribeOptions) => Promise<TranscribedClip>;

/** The slice of Cloudflare's `Ai` binding this uses. */
export interface AiBinding {
  run(model: string, input: Record<string, unknown>): Promise<unknown>;
}
type RunModel = (model: string, input: Record<string, unknown>) => Promise<unknown>;

function toBase64(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

/** Cloudflare wraps answers in `{ result }` and the gateway adds `{ state, result }`: take what is inside. */
function unwrap(raw: unknown): Record<string, unknown> {
  let r = (raw ?? {}) as Record<string, unknown>;
  for (let i = 0; i < 2; i++) {
    if (r.result && typeof r.result === 'object') r = r.result as Record<string, unknown>;
  }
  return r;
}

/** What Workers AI answers for Whisper, reduced to what the screen needs. Tolerates a missing `segments`. */
export function whisperClipOf(raw: unknown): TranscribedClip {
  const r = unwrap(raw) as {
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

const LANGUAGE_CODES: Record<string, string> = { swedish: 'sv', english: 'en' };

/**
 * Grok answers with words and their times (and a speaker number when asked). Group them into passages: a new one starts when the
 * speaker changes, after a pause, at the end of a sentence once it is long enough, or when it gets too long to read.
 */
export function grokClipOf(raw: unknown): TranscribedClip {
  const r = unwrap(raw) as {
    text?: string;
    language?: string;
    words?: { text?: string; start?: number; end?: number; speaker?: number }[];
  };
  const words = (r.words ?? []).filter((w) => (w.text ?? '').trim());
  const numbers = new Map<number, number>();
  const speakerOf = (w: { speaker?: number }) => {
    if (w.speaker === undefined || w.speaker === null) return undefined;
    if (!numbers.has(w.speaker)) numbers.set(w.speaker, numbers.size + 1);
    return numbers.get(w.speaker);
  };
  const segments: TranscribedPassage[] = [];
  let cur: { start: number; end: number; parts: string[]; speaker: number | undefined } | null = null;
  const flush = () => {
    if (cur) {
      const passage: TranscribedPassage = { start: cur.start, end: cur.end, text: cur.parts.join(' ') };
      if (cur.speaker !== undefined) passage.speaker = cur.speaker;
      segments.push(passage);
    }
    cur = null;
  };
  for (const w of words) {
    const text = w.text!.trim();
    const start = w.start ?? 0;
    const end = w.end ?? start;
    const speaker = speakerOf(w);
    if (cur) {
      const endedSentence = /[.!?]$/.test(cur.parts[cur.parts.length - 1]!);
      if (speaker !== cur.speaker || start - cur.end > 1.2 || cur.parts.length >= 40 || (endedSentence && cur.parts.length >= 8)) flush();
    }
    if (!cur) cur = { start, end, parts: [], speaker };
    cur.parts.push(text);
    cur.end = end;
  }
  flush();
  const text = (r.text ?? segments.map((s) => s.text).join(' ')).trim();
  const language = r.language ? (LANGUAGE_CODES[r.language.toLowerCase()] ?? null) : null;
  return { text, segments: segments.length ? segments : text ? [{ start: 0, end: 0, text }] : [], language };
}

/** Both models over one way of running a model: the binding, or the HTTP API. */
function transcriberOver(run: RunModel): Transcribe {
  return async (model, audio, options = {}) => {
    if (model === 'grok-stt') {
      const mime = options.mime && options.mime.startsWith('audio/') ? options.mime : 'audio/wav';
      return grokClipOf(
        await run('xai/grok-stt', {
          file: `data:${mime};base64,${toBase64(audio)}`,
          ...(options.language ? { language: options.language } : {}),
          ...(options.diarize ? { diarize: true } : {}),
        }),
      );
    }
    return whisperClipOf(
      await run('@cf/openai/whisper-large-v3-turbo', {
        audio: toBase64(audio),
        ...(options.language ? { language: options.language } : {}),
        vad_filter: true,
      }),
    );
  };
}

/** Through the binding: nothing to hold, leak or rotate. */
export function bindingTranscriber(ai: AiBinding): Transcribe {
  return transcriberOver((model, input) => ai.run(model, input));
}

/** Over Cloudflare's HTTP API, for a host with no binding (the local server). */
export function httpTranscriber(accountId: string, token: string, fetchImpl: typeof fetch = fetch): Transcribe {
  return transcriberOver(async (model, input) => {
    // A Workers AI model is addressed in the path; a gateway model (xAI) is named in the body.
    const workersAi = model.startsWith('@cf/');
    const res = await fetchImpl(
      workersAi ? `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/run/${model}` : `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/run`,
      {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify(workersAi ? input : { model, input }),
      },
    );
    // The provider's own words are not repeated to the screen.
    if (!res.ok) throw new Error(`transcription failed (${res.status})`);
    return res.json();
  });
}

export type TranscriberChoice = { transcribe: Transcribe } | { reason: string };

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
