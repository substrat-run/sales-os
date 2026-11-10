import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MockLanguageModelV4, convertArrayToReadableStream } from 'ai/test';
import { assistantModule } from '@substrat-run/engine-assistant';
import type { SqliteScopeHost } from '@substrat-run/adapter-sqlite';
import type { ScopeStub } from '@substrat-run/kernel';
import { NoTurnWaiting, runAssistantTurn } from '../src/assistant-host.js';
import { resolveAssistantModel } from '../src/assistant-model.js';
import { buildSalesHost, seedSales, type SalesWorld } from '../src/seed.js';

// ============================================================================
// The assistant's HOST loop, against a scripted model: what it asks, what it is shown, what lands on the
// person's record, and every way a turn can end. No network, no key.
// ============================================================================

const usage = {
  inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 1, text: 1, reasoning: 0 },
};
const finish = (unified: 'stop' | 'tool-calls') => ({ type: 'finish' as const, finishReason: { unified, raw: unified }, usage });
const text = (id: string, ...deltas: string[]) => [
  { type: 'text-start' as const, id },
  ...deltas.map((delta) => ({ type: 'text-delta' as const, id, delta })),
  { type: 'text-end' as const, id },
];
const call = (id: string, toolName: string, input: unknown) => ({
  type: 'tool-call' as const, toolCallId: id, toolName, input: JSON.stringify(input),
});
/** One scripted step per model call, in order. */
const scripted = (...steps: unknown[][]) => {
  let i = 0;
  return new MockLanguageModelV4({
    doStream: async () => ({
      stream: convertArrayToReadableStream([{ type: 'stream-start', warnings: [] }, ...(steps[i++] ?? steps[steps.length - 1]!)] as never),
    }),
  });
};

describe('assistant host', () => {
  let dir: string;
  let host: SqliteScopeHost;
  let w: SalesWorld;
  let nora: ScopeStub;
  let markus: ScopeStub;
  let system: ScopeStub;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'substrat-sales-os-host-'));
    host = buildSalesHost(dir);
    w = await seedSales(host, dir);
    nora = await host.getScope(w.nora, w.t1, w.s1);
    markus = await host.getScope(w.markus, w.t1, w.s1);
    system = await host.getSystemScope(assistantModule.manifest.id, w.t1, w.s1);
    const acme = await markus.invoke<{ id: string }>('sales/create-company', { companyName: 'Acme AB', domain: 'acme.se', source: 'manual' });
    await markus.invoke('sales/create-contact', { companyId: acme.id, name: 'Anna Lindqvist', email: 'anna@acme.se' });
    for (const [title, body, approve] of [
      ['Pilot pricing', 'A pilot is priced per site for three months.', true],
      ['Pilot discount idea', 'A 50 percent pilot discount, not agreed.', false],
    ] as const) {
      const k = await markus.invoke<{ id: string }>('sales/create-knowledge', { title, body, category: 'pricing', source: 'test' });
      if (approve) await markus.invoke('sales/approve-knowledge', { knowledgeId: k.id });
    }
  });
  afterAll(async () => {
    await host.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const ask = async (stub: ScopeStub, question: string) => {
    const t = await stub.invoke<{ id: string }>('assistant/create-thread', {});
    await stub.invoke('assistant/send-message', { threadId: t.id, text: question });
    return t.id;
  };
  const record = async (stub: ScopeStub, threadId: string) =>
    (await stub.invoke<{ events: Record<string, unknown>[] }>('assistant/read-events', { threadId, after: 0 })).events;
  const types = (events: Record<string, unknown>[]) => events.map((e) => e.t);

  it('a grounded answer: searches the knowledge base, is shown approved entries only, cites what it used', async () => {
    const threadId = await ask(nora, 'What do we say about pilot pricing?');
    const model = scripted(
      [call('c1', 'sales_find_knowledge', { query: 'pilot pricing' }), finish('tool-calls')],
      [...text('a', 'A pilot is priced per site ', 'for three months.'), finish('stop')],
    );
    await runAssistantTurn({ threadId, person: nora, system, model });

    const events = await record(nora, threadId);
    expect(types(events)).toEqual([
      'user-message', 'turn-start', 'tool-input', 'tool-output', 'text-start', 'text-delta', 'text-end', 'source', 'turn-finish',
    ]);
    const answer = events.filter((e) => e.t === 'text-delta').map((e) => e.delta).join('');
    expect(answer).toBe('A pilot is priced per site for three months.');
    // The citation is the entry the tool really returned, not the model's say-so.
    const source = events.find((e) => e.t === 'source')!;
    expect(source).toMatchObject({ title: 'Pilot pricing' });
    expect(String(source.ref)).toMatch(/^knowledge\//);
    // What the model was shown on its second step: the approved entry, and NOT the draft.
    const shown = JSON.stringify(model.doStreamCalls[1]!.prompt);
    expect(shown).toContain('priced per site');
    expect(shown).not.toContain('50 percent');
    // The instructions carry the grounding rule and the three claim labels.
    const instructions = JSON.stringify(model.doStreamCalls[0]!.prompt);
    expect(instructions).toContain('not in the knowledge base');
    expect(instructions).toContain('built_unproven');
  });

  it('tools run as the person and return no personal data: the model is never shown a contact', async () => {
    const threadId = await ask(nora, 'Tell me about Acme');
    const model = scripted(
      [call('c1', 'sales_find_companies', { query: 'acme' }), finish('tool-calls')],
      [...text('a', 'Acme AB is a company we track.'), finish('stop')],
    );
    await runAssistantTurn({ threadId, person: nora, system, model });
    const shown = JSON.stringify(model.doStreamCalls[1]!.prompt);
    expect(shown).toContain('Acme AB');
    for (const leaked of ['Anna', 'Lindqvist', 'anna@acme.se']) expect(shown).not.toContain(leaked);
    expect(types(await record(nora, threadId))).toContain('turn-finish');
  });

  it('when nothing supports an answer, the record says what the tool found: nothing', async () => {
    const threadId = await ask(nora, 'Do we support quantum teleportation?');
    const model = scripted(
      [call('c1', 'sales_find_knowledge', { query: 'quantum teleportation' }), finish('tool-calls')],
      [...text('a', 'That is not in the knowledge base. Ask a person.'), finish('stop')],
    );
    await runAssistantTurn({ threadId, person: nora, system, model });
    const events = await record(nora, threadId);
    expect(events.find((e) => e.t === 'tool-output')).toMatchObject({ output: { entries: [] } });
    expect(events.some((e) => e.t === 'source')).toBe(false); // nothing consulted, nothing cited
  });

  it('with no key the turn closes with a plain "not set up" and the person can ask again', async () => {
    const choice = resolveAssistantModel({});
    expect(choice.model).toBeNull();
    const threadId = await ask(nora, 'Hello?');
    await runAssistantTurn({ threadId, person: nora, system, model: null, notConfigured: 'model' in choice && choice.model ? '' : 'reason' in choice ? choice.reason : '' });
    const events = await record(nora, threadId);
    expect(events.at(-1)).toMatchObject({ t: 'turn-error', code: 'not_configured' });
    expect(String(events.at(-1)!.message)).toMatch(/not set up/);
    // Not locked out: the turn is closed, so a new question is accepted.
    await expect(nora.invoke('assistant/send-message', { threadId, text: 'Hello again' })).resolves.toBeTruthy();
  });

  it('a model failure closes the turn with a plain sentence, never the provider’s text, and frees the lease', async () => {
    const threadId = await ask(nora, 'Anything?');
    const model = new MockLanguageModelV4({ doStream: async () => { throw new Error('401 invalid x-api-key sk-secret-123'); } });
    await runAssistantTurn({ threadId, person: nora, system, model });
    const events = await record(nora, threadId);
    expect(events.at(-1)).toMatchObject({ t: 'turn-error', code: 'model_error' });
    expect(JSON.stringify(events)).not.toContain('sk-secret');
    // The lease was released: the next question gets a fresh run.
    await nora.invoke('assistant/send-message', { threadId, text: 'Try again' });
    await runAssistantTurn({ threadId, person: nora, system, model: scripted([...text('a', 'Fine.'), finish('stop')]) });
    expect(types(await record(nora, threadId)).at(-1)).toBe('turn-finish');
  });

  it('only the owner’s question is answered: an admin cannot run a colleague’s thread, and nothing is written', async () => {
    const threadId = await ask(nora, 'A private question');
    const before = await record(nora, threadId);
    await expect(runAssistantTurn({ threadId, person: markus, system, model: scripted([...text('a', 'x'), finish('stop')]) })).rejects.toThrow(/not.found|not found/i);
    expect(await record(nora, threadId)).toEqual(before);
    // …the control: the owner's run proceeds.
    await runAssistantTurn({ threadId, person: nora, system, model: scripted([...text('a', 'ok'), finish('stop')]) });
    expect(types(await record(nora, threadId)).at(-1)).toBe('turn-finish');
  });

  it('there is nothing to run when no question is waiting', async () => {
    const t = await nora.invoke<{ id: string }>('assistant/create-thread', {});
    await expect(runAssistantTurn({ threadId: t.id, person: nora, system, model: scripted([...text('a', 'x'), finish('stop')]) })).rejects.toBeInstanceOf(NoTurnWaiting);
  });
});
