import { AppDefinition, lintDefinition, validateDefinition } from '@platform/app-model';
import type { FastifyRequest } from 'fastify';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { requireAuth } from '../access/rules.js';
import { auditScopeFor, recordAudit } from '../audit/writer.js';
import { changeRequestRequired } from '../apps/builder.js';
import { isTeamApp } from '../apps/catalog.js';
import { appResource } from '../apps/resources.js';
import { AppParams } from '../apps/schemas.js';
import type { AppContext } from '../context.js';
import { Attachment, composeError, Focus, Turn, type Composer, type DraftCheck } from './composer.js';

const ComposeBody = z.strictObject({
  prompt: z.string().trim().min(1).max(8000),
  /** The definition the builder works on, which may be unsaved. Without it, the app's current definition. */
  definition: z.unknown().optional(),
  focus: Focus.optional(),
  /** What the chat and the builder said before, oldest first. */
  history: z.array(Turn).max(20).default([]),
  attachments: z.array(Attachment).max(3).default([]),
});

const ComposeOut = z.object({
  reply: z.string(),
  /** The draft, when the chat changed the definition: the builder reviews it and saves it. */
  changed: z.boolean(),
  definition: z.unknown(),
  /** How many problems the checks still find in the draft. The builder sees them when they review the draft. */
  problems: z.int(),
  edits: z.int(),
  turns: z.int(),
  stopped: z.enum(['turns', 'length', 'declined']).nullable(),
  usage: z.object({ input: z.int(), output: z.int(), cacheRead: z.int(), cacheWrite: z.int() }),
});

/**
 * Vibe composition (design §6.5): the studio's chat, on the installation's model. It answers with
 * a draft, which the builder saves through the usual checks; it saves nothing itself.
 */
export function composeRoutes(ctx: AppContext, composer: Composer): FastifyPluginAsyncZod {
  const theRef = (request: FastifyRequest) => ctx.apps.ref((request.params as { appId: string }).appId);
  return async (app) => {
    app.get(
      '/v1/compose',
      {
        config: { access: { kind: 'authenticated' } },
        schema: { tags: ['compose'], summary: "Whether the installation's chat builds apps: an admin sets a model provider for it", response: { 200: z.object({ enabled: z.boolean() }) } },
      },
      async () => ({ enabled: composer.enabled }),
    );

    app.post(
      '/v1/apps/:appId/compose',
      {
        config: { access: { kind: 'permission', action: 'app.compose', resource: async (request: FastifyRequest) => appResource(ctx.org.id, await theRef(request)) } },
        // Pictures and PDFs of what the app should do come with the request.
        bodyLimit: 25 * 1024 * 1024,
        schema: {
          tags: ['compose'],
          summary: "Ask the installation's model to change an app's definition. It answers with a draft for the builder to review and save",
          params: AppParams,
          body: ComposeBody,
          response: { 200: ComposeOut },
        },
      },
      async (request) => {
        requireAuth(request);
        const ref = await theRef(request);
        if (isTeamApp(ref)) throw changeRequestRequired(ref);
        const previous = await ctx.apps.mainDefinition(ref);
        const body = request.body;
        // The same checks as a save, and the same findings as a change request.
        const check = (draft: unknown): DraftCheck => {
          const result = validateDefinition(draft, previous);
          if (!result.ok) return { issues: result.issues, findings: [] };
          return { issues: [], findings: lintDefinition(result.definition) };
        };
        // The history starts with what the builder said.
        const first = body.history.findIndex((turn) => turn.role === 'user');
        const history = first < 0 ? [] : body.history.slice(first);
        let result;
        try {
          result = await composer.compose({ prompt: body.prompt, definition: body.definition ?? previous, focus: body.focus, history, attachments: body.attachments }, check);
        } catch (error) {
          throw composeError(error) ?? error;
        }
        // The draft as the designers take it: in the format, with its defaults. A draft that doesn't
        // fit the format can't be shown, so the builder's definition stays as it was.
        let draft: unknown = null;
        let problems = 0;
        let reply = result.reply;
        if (result.draft.changed) {
          problems = check(result.draft.definition).issues.length;
          const parsed = AppDefinition.safeParse(result.draft.definition);
          if (parsed.success) draft = parsed.data;
          else reply = `${reply}\n\nThe draft doesn't fit the app's format, so the studio can't show it: your definition stays as it was. Ask again in smaller steps.`;
        }
        const now = ctx.now();
        await recordAudit(ctx.db, auditScopeFor(request, ctx.org.id, now), {
          action: 'app.compose',
          target: { type: 'app', id: ref.app.id, name: ref.app.name },
          spaceId: ref.space.id,
          appId: ref.app.id,
          reason: {
            model: result.model,
            prompt: body.prompt.slice(0, 500),
            attachments: body.attachments.map((file) => ({ name: file.name, mediaType: file.mediaType })),
            changed: draft !== null,
            problems,
            edits: result.edits,
            turns: result.turns,
            stopped: result.stopped,
            usage: result.usage,
          },
        });
        return {
          reply: reply.trim(),
          changed: draft !== null,
          definition: draft,
          problems,
          edits: result.edits,
          turns: result.turns,
          stopped: result.stopped,
          usage: result.usage,
        };
      },
    );
  };
}
