import { AssistantModel, type AssistantEvent, type AssistantSource } from '@substrat-run/elements/assistant-model';
import { get, post, qs } from './api';

// ============================================================================
// The Ask tab's conversation. The server keeps the record (the assistant engine); this asks, starts the
// answer, and reads the record as the assistant writes it: the same events the engine stores, which are
// the ones `<sub-assistant>` draws.
// ============================================================================

let threadId: string | null = null;

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    const t = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => { clearTimeout(t); resolve(); }, { once: true });
  });

const source: AssistantSource = {
  async *send({ text }, { signal }) {
    // A refusal from the server (not entitled, not allowed, unavailable) is the platform talking to us, not the assistant
    // answering, and its text can carry operational detail. Say one plain thing instead.
    const unavailable = () => new Error('The assistant is not available in this workspace right now.');
    let id: string;
    let sent: { lastSeq: number };
    try {
      if (!threadId) threadId = (await post<{ id: string }>('/assistant/threads', {})).id;
      id = threadId;
      sent = await post<{ lastSeq: number }>(`/assistant/threads/${id}/messages`, { threadId: id, text });
    } catch {
      threadId = null; // a thread that cannot take a question is left behind; the next one starts fresh
      throw unavailable();
    }

    // Start the answer without waiting for it: it resolves when the turn is closed, and the record is read meanwhile.
    const run: { error: Error | null } = { error: null };
    void post(`/assistant/threads/${id}/run`, {}).catch((e: Error) => { run.error = e; });

    let after = sent.lastSeq;
    while (!signal.aborted) {
      const page = await get<{ events: AssistantEvent[] }>(`/assistant/threads/${id}/events` + qs({ after }));
      for (const e of page.events) {
        after = e.id ?? after;
        yield e;
        if (e.t === 'turn-finish' || e.t === 'turn-error') return;
      }
      if (run.error && !page.events.length) {
        // The answer never started, so this turn has no writer and the thread cannot take another question.
        threadId = null;
        yield { t: 'turn-error', code: 'run_failed', message: unavailable().message };
        return;
      }
      await sleep(300, signal);
    }
  },
};

let model: AssistantModel | null = null;
/** One conversation per page load: closing the palette keeps it, a reload starts a new one. */
export function assistantModel(): AssistantModel {
  return (model ??= new AssistantModel({ source }));
}
