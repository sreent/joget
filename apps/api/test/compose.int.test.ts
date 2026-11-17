import { auditEvents } from '@platform/db';
import { and, eq } from 'drizzle-orm';
import type { InjectOptions } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestApp, type Session, type TestApp } from './helpers.js';
import { callTool, modelMessage, say, scriptedModel, type ScriptedModel } from './scripted-model.js';

/**
 * Vibe composition (design §6.5): the studio's chat changes an app's definition on the
 * installation's model, with edits that the definition's checks run on. It answers with a draft,
 * and saves nothing; the builder saves the draft through the usual checks.
 */

let t: TestApp;
let off: TestApp;
let model: ScriptedModel;
let alice: Session;
let bob: Session;
let appId: string;

const as = (session: Session) => ({ cookies: session.cookies });
async function inject(app: TestApp, options: InjectOptions, expected: number) {
  const response = await app.app.inject(options);
  expect(response.statusCode, response.body).toBe(expected);
  return response.json();
}
const compose = (payload: Record<string, unknown>, expected = 200, session = alice) => inject(t, { method: 'POST', url: `/v1/apps/${appId}/compose`, ...as(session), payload }, expected);
const destination = { name: 'destination', label: 'Destination', type: 'text' };

beforeAll(async () => {
  model = scriptedModel();
  t = await startTestApp({ AI_PROVIDER: 'anthropic', AI_MODEL: 'test-model', AI_API_KEY_FILE: '/run/secrets/unused' }, { models: model.client });
  off = await startTestApp();
  [alice, bob] = [await t.login('alice'), await t.login('bob')];
  const started = await inject(t, { method: 'POST', url: `/v1/spaces/${alice.personalSpaceId}/apps/import`, ...as(alice), payload: { name: 'Leave', template: 'leave' } }, 201);
  appId = started.app.id;
});

afterAll(async () => {
  await t?.close();
  await off?.close();
});

describe('the chat that builds apps', () => {
  it('is off until an admin sets a model provider', async () => {
    const carol = await off.login('carol');
    expect(await inject(off, { method: 'GET', url: '/v1/compose', ...as(carol) }, 200)).toEqual({ enabled: false });
    const app = await inject(off, { method: 'POST', url: `/v1/spaces/${carol.personalSpaceId}/apps/import`, ...as(carol), payload: { name: 'Leave', template: 'leave' } }, 201);
    expect(await inject(off, { method: 'POST', url: `/v1/apps/${app.app.id}/compose`, ...as(carol), payload: { prompt: 'Add a field' } }, 409)).toMatchObject({ error: 'compose_off' });
    expect(await inject(t, { method: 'GET', url: '/v1/compose', ...as(alice) }, 200)).toEqual({ enabled: true });
  });

  it('changes the definition with checked edits, and answers with a draft that it does not save', async () => {
    model.requests.length = 0;
    model.reply(
      // A first edit that leads nowhere: it changes nothing, and the model hears why.
      modelMessage([callTool('edit_definition', { edits: [{ op: 'add', path: '/entities/leave/fields/-', value: destination }] })], 'tool_use'),
      modelMessage([say('Adding the field.'), callTool('edit_definition', { edits: [{ op: 'add', path: '/entities/leave_request/fields/-', value: destination }] })], 'tool_use'),
      modelMessage([say('I added a Destination field to leave requests. Put it on the request form if people should fill it in.')]),
    );
    const answer = await compose({ prompt: 'Leave requests need a destination', focus: { kind: 'entity', name: 'leave_request' } });
    expect(answer).toMatchObject({ changed: true, problems: 0, edits: 1, turns: 3, stopped: null, reply: 'I added a Destination field to leave requests. Put it on the request form if people should fill it in.' });
    // The draft comes in the format as the designers take it, with its defaults.
    expect(answer.definition.entities.leave_request.fields.at(-1)).toEqual({ ...destination, required: false, unique: false, classification: 'internal', maxLength: 1000, multiline: false });
    expect(answer.usage).toEqual({ input: 3000, output: 150, cacheRead: 2700, cacheWrite: 0 });

    // What Ambit sent: its instructions with the format, cached; the definition and the request; and each tool's result.
    const [first, second, third] = model.requests;
    expect(first!.url).toContain('/v1/messages');
    expect(first!.headers['anthropic-beta']).toContain('server-side-fallback-2026-07-01');
    expect(first!.body).toMatchObject({ model: 'test-model', max_tokens: 16000, fallbacks: 'default', output_config: { effort: 'high' }, cache_control: { type: 'ephemeral' } });
    expect(first!.body['thread']).toBeUndefined();
    expect(first!.body['system'][0]).toMatchObject({ type: 'text', cache_control: { type: 'ephemeral' } });
    expect(first!.body['system'][0].text).toContain('<format>');
    expect(first!.body['tools'].map((tool: { name: string }) => tool.name)).toEqual(['read_definition', 'edit_definition']);
    const asked = first!.body['messages'][0].content;
    expect(asked[0].text).toContain('"leave_request"');
    expect(asked.at(-1).text).toBe('The builder looks at the entity leave_request.\n\nLeave requests need a destination');
    const failed = second!.body['messages'].at(-1).content[0];
    expect(failed).toMatchObject({ type: 'tool_result', is_error: true });
    expect(JSON.stringify(failed.content)).toContain('Nothing changed: edit 1 failed: add /entities/leave/fields/-: nothing is at leave');
    expect(JSON.stringify(third!.body['messages'].at(-1).content[0].content)).toContain('Applied 1 edit.');

    // Nothing was saved, and the audit log says who asked what of which model.
    const stored = await inject(t, { method: 'GET', url: `/v1/apps/${appId}/definition`, ...as(alice) }, 200);
    expect(stored.definition.entities.leave_request.fields.map((field: { name: string }) => field.name)).not.toContain('destination');
    const [event] = await t.handle.db.select().from(auditEvents).where(and(eq(auditEvents.action, 'app.compose'), eq(auditEvents.appId, appId)));
    expect(event).toMatchObject({ actor: { type: 'user', id: alice.userId }, outcome: 'success' });
    expect(event!.reason).toMatchObject({ model: 'test-model', prompt: 'Leave requests need a destination', changed: true, edits: 1, turns: 3 });

    // The builder saves the draft, as any other change.
    await inject(t, { method: 'PUT', url: `/v1/apps/${appId}/definition`, ...as(alice), payload: { definition: answer.definition, baseRevision: stored.revision } }, 200);
  });

  it("reports the checks' problems to the model, which fixes them before it finishes", async () => {
    model.requests.length = 0;
    const stored = await inject(t, { method: 'GET', url: `/v1/apps/${appId}/definition`, ...as(alice) }, 200);
    const at = stored.definition.entities.leave_request.fields.length;
    model.reply(
      modelMessage([callTool('edit_definition', { edits: [{ op: 'add', path: '/entities/leave_request/fields/-', value: { name: 'budget', label: 'Budget', type: 'money' } }] })], 'tool_use'),
      modelMessage([callTool('edit_definition', { edits: [{ op: 'replace', path: `/entities/leave_request/fields/${at}/type`, value: 'number' }] })], 'tool_use'),
      modelMessage([say('I added a Budget field.')]),
    );
    const answer = await compose({ prompt: 'Add a budget' });
    expect(answer).toMatchObject({ changed: true, edits: 2 });
    expect(JSON.stringify(model.requests[1]!.body['messages'].at(-1).content[0].content)).toContain('The checks found');
    expect(JSON.stringify(model.requests[2]!.body['messages'].at(-1).content[0].content)).toContain('The definition passes the checks.');

    // A draft that the model leaves with problems comes back with their count. One that doesn't fit the format doesn't come back.
    model.reply(
      modelMessage([callTool('edit_definition', { edits: [{ op: 'replace', path: '/entities/leave_request/titleField', value: 'nothing' }] })], 'tool_use'),
      modelMessage([say('I changed the title.')]),
    );
    expect(await compose({ prompt: 'Change the title' })).toMatchObject({ changed: true, problems: 1 });
    model.reply(
      modelMessage([callTool('edit_definition', { edits: [{ op: 'replace', path: '/entities/leave_request/fields/0/type', value: 'colour' }] })], 'tool_use'),
      modelMessage([say('I changed the type.')]),
    );
    const broken = await compose({ prompt: 'Make the first field a colour' });
    expect(broken).toMatchObject({ changed: false, definition: null, problems: 1 });
    expect(broken.reply).toContain("The draft doesn't fit the app's format");
  });

  it('carries the conversation, and says when the model declines or the provider fails', async () => {
    model.requests.length = 0;
    model.reply(modelMessage([say('Which approver should decide long leave?')]));
    await compose({ prompt: 'And long leave goes to HR', history: [{ role: 'assistant', text: 'Hello' }, { role: 'user', text: 'Leave requests need a destination' }, { role: 'assistant', text: 'Done.' }] });
    // The history starts with what the builder said.
    expect(model.requests[0]!.body['messages'].slice(0, 2)).toEqual([
      { role: 'user', content: 'Leave requests need a destination' },
      { role: 'assistant', content: 'Done.' },
    ]);

    model.reply(modelMessage([callTool('edit_definition', { edits: [{ op: 'remove', path: '/roles' }] })], 'tool_use'), modelMessage([], 'refusal'));
    expect(await compose({ prompt: 'Something the model declines' })).toMatchObject({ changed: false, stopped: 'declined', definition: null });

    model.reply({ status: 429, error: { type: 'rate_limit_error', message: 'Slow down' } });
    expect(await compose({ prompt: 'Add a field' }, 429)).toMatchObject({ error: 'model_busy' });
  });

  it('is for those who build the app: a colleague without the permission is refused', async () => {
    expect(await compose({ prompt: 'Add a field' }, 403, bob)).toMatchObject({ error: 'forbidden', details: { action: 'app.compose' } });
  });
});
