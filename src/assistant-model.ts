import { createAnthropic } from '@ai-sdk/anthropic';
import { createModel, ProviderError } from '@substrat-run/model-providers';
import type { LanguageModel } from 'ai';

// ============================================================================
// Which model answers, and with whose key. HARNESS code (a network call to a third party): never imported
// by module code, which has no network. The model provider is a subprocessor of whatever text it is sent;
// `src/assistant-host.ts` sends only what the assistant's read-only tools return (see src/operations.ts).
// ============================================================================

/** The default model, as `provider:model`. Override per install with the ASSISTANT_MODEL setting. */
export const DEFAULT_ASSISTANT_MODEL = 'anthropic:claude-sonnet-5-5';

export type ModelChoice = { model: LanguageModel; label: string } | { model: null; reason: string };

/**
 * Resolve the configured model from an environment record (`process.env` locally; delivered settings
 * hosted). A missing key is an answer, not an exception: the Ask tab then says it is not set up and the
 * rest of the app is unaffected.
 */
export function resolveAssistantModel(env: Record<string, string | undefined>): ModelChoice {
  const spec = env.ASSISTANT_MODEL?.trim() || DEFAULT_ASSISTANT_MODEL;
  try {
    // Two patch versions of the SDK's provider types sit in the tree; the runtime shapes agree.
    const { model, label } = createModel(spec, env, { factories: { anthropic: createAnthropic as never } });
    return { model: model as LanguageModel, label };
  } catch (e) {
    // A ProviderError names the next step ("ANTHROPIC_API_KEY is not set"), and never carries a secret.
    const reason = e instanceof ProviderError ? e.message : 'The configured model could not be loaded.';
    return { model: null, reason };
  }
}
