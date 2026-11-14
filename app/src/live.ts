// ============================================================================
// Live transcription in the browser. The microphone is cut into clips of about ten seconds (16 kHz mono WAV, the form
// the model takes), each clip goes to our own server as it is finished, and the text that comes back is handed to the
// screen. A few seconds behind the speakers, by design: the model takes a finished clip, not a stream. A clip that fails
// is reported and skipped; it never stops the recording.
// ============================================================================

import { ApiError } from './api';

export interface Passage { startMs: number; endMs: number; text: string }

const RATE = 16000;
const CLIP_SECONDS = 10;
/** A clip quieter than this is silence, and a model asked to read silence invents words. */
const SILENCE_RMS = 0.004;

const WORKLET = `class Cap extends AudioWorkletProcessor { process(inputs) { const ch = inputs[0] && inputs[0][0]; if (ch) this.port.postMessage(ch.slice(0)); return true; } }
registerProcessor('cap', Cap);`;

function downsample(input: Float32Array, from: number): Float32Array {
  if (from === RATE) return input;
  const ratio = from / RATE;
  const out = new Float32Array(Math.floor(input.length / ratio));
  for (let i = 0; i < out.length; i++) out[i] = input[Math.floor(i * ratio)] ?? 0;
  return out;
}

function wav(samples: Float32Array): Blob {
  const buf = new ArrayBuffer(44 + samples.length * 2);
  const v = new DataView(buf);
  const w = (o: number, s: string) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
  w(0, 'RIFF'); v.setUint32(4, 36 + samples.length * 2, true); w(8, 'WAVE'); w(12, 'fmt ');
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, RATE, true); v.setUint32(28, RATE * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  w(36, 'data'); v.setUint32(40, samples.length * 2, true);
  samples.forEach((s, i) => v.setInt16(44 + i * 2, Math.max(-1, Math.min(1, s)) * 0x7fff, true));
  return new Blob([buf], { type: 'audio/wav' });
}

const rms = (a: Float32Array) => Math.sqrt(a.reduce((s, x) => s + x * x, 0) / Math.max(1, a.length));

interface ClipAnswer { text: string; segments: { start: number; end: number; text: string }[] }

export async function startLive(
  stream: MediaStream,
  o: { meetingId: string; language: string; model: string; onPassages: (p: Passage[]) => void; onError: (e: Error) => void },
): Promise<{ stop: () => Promise<Passage[]> }> {
  const ctx = new AudioContext({ sampleRate: RATE });
  const url = URL.createObjectURL(new Blob([WORKLET], { type: 'application/javascript' }));
  await ctx.audioWorklet.addModule(url);
  URL.revokeObjectURL(url);
  const node = new AudioWorkletNode(ctx, 'cap');
  const source = ctx.createMediaStreamSource(stream);
  source.connect(node);

  const all: Passage[] = [];
  let pending: Float32Array[] = [];
  let pendingLen = 0;
  let sentSamples = 0; // where the next clip starts, in samples at RATE
  let chain: Promise<void> = Promise.resolve();

  const send = (samples: Float32Array, startMs: number) => {
    if (rms(samples) < SILENCE_RMS) return;
    chain = chain.then(async () => {
      try {
        const res = await fetch(`/api/meetings/${o.meetingId}/transcribe?language=${encodeURIComponent(o.language)}&model=${encodeURIComponent(o.model)}`, {
          method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'audio/wav' }, body: wav(samples),
        });
        const body = (await res.json().catch(() => null)) as (ClipAnswer & { detail?: string; error?: string }) | null;
        if (!res.ok) throw new ApiError(res.status, body?.detail ?? body?.error ?? `transcription failed (${res.status})`);
        const found: Passage[] = (body?.segments ?? []).map((s) => ({
          startMs: startMs + Math.round(s.start * 1000),
          endMs: startMs + Math.round(Math.max(s.end, s.start) * 1000),
          text: s.text,
        }));
        if (found.length) {
          all.push(...found);
          o.onPassages([...all]);
        }
      } catch (e) {
        o.onError(e as Error);
      }
    });
  };

  const cut = (force: boolean) => {
    const need = CLIP_SECONDS * RATE;
    if (!force && pendingLen < need) return;
    if (pendingLen === 0) return;
    const joined = new Float32Array(pendingLen);
    let at = 0;
    for (const p of pending) { joined.set(p, at); at += p.length; }
    pending = [];
    pendingLen = 0;
    // A clip under a second is a breath, not speech.
    if (force && joined.length < RATE) return;
    send(joined, Math.round((sentSamples / RATE) * 1000));
    sentSamples += joined.length;
  };

  node.port.onmessage = (ev: MessageEvent<Float32Array>) => {
    const chunk = downsample(ev.data, ctx.sampleRate);
    pending.push(chunk);
    pendingLen += chunk.length;
    cut(false);
  };

  return {
    stop: async () => {
      source.disconnect();
      node.port.onmessage = null;
      cut(true);
      await chain;
      await ctx.close();
      return all;
    },
  };
}
