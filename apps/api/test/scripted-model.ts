import Anthropic from '@anthropic-ai/sdk';
import type { ModelClient } from '../src/compose/composer.js';

/**
 * A model provider for tests: it answers each request to the Messages API with the next reply
 * the test scripted, and keeps the requests, so a test can check what Ambit sent. The real SDK
 * runs the loop; only the network is scripted.
 */
export interface ScriptedModel {
  readonly client: ModelClient;
  /** The requests so far: their address, headers and JSON body. */
  readonly requests: Array<{ readonly url: string; readonly headers: Record<string, string>; readonly body: Record<string, any> }>;
  /** Script the next replies: a message, or an error with its HTTP status. */
  reply(...replies: Array<Record<string, unknown> | { readonly status: number; readonly error: Record<string, unknown> }>): void;
}

export function scriptedModel(): ScriptedModel {
  const queue: Array<Record<string, unknown> | { readonly status: number; readonly error: Record<string, unknown> }> = [];
  const requests: ScriptedModel['requests'] = [];
  const respond = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'request-id': 'req_test' } });
  const fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    requests.push({
      url: String(input instanceof Request ? input.url : input),
      headers: Object.fromEntries(new Headers(init?.headers)),
      body: JSON.parse(String(init?.body ?? '{}')),
    });
    const next = queue.shift();
    if (!next) return respond(500, { type: 'error', error: { type: 'api_error', message: 'The test scripted no more replies' } });
    if ('status' in next && 'error' in next) return respond(Number(next.status), { type: 'error', error: next.error });
    return respond(200, next);
  };
  return {
    client: async () => new Anthropic({ apiKey: 'test-key', fetch, maxRetries: 0 }),
    requests,
    reply: (...replies) => queue.push(...replies),
  };
}

let counter = 0;

/** A reply of the model: its content blocks, and why it stopped. */
export function modelMessage(
  content: Array<Record<string, unknown>>,
  stopReason: 'end_turn' | 'tool_use' | 'refusal' | 'max_tokens' = 'end_turn',
): Record<string, unknown> {
  counter++;
  return {
    id: `msg_test_${counter}`,
    type: 'message',
    role: 'assistant',
    model: 'test-model',
    content,
    stop_reason: stopReason,
    stop_sequence: null,
    usage: { input_tokens: 1000, output_tokens: 50, cache_creation_input_tokens: 0, cache_read_input_tokens: 900 },
  };
}

export const say = (text: string) => ({ type: 'text', text });
export const callTool = (name: string, input: Record<string, unknown>) => ({ type: 'tool_use', id: `toolu_test_${++counter}`, name, input });
