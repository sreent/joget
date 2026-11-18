import { type StoredDefinition, TEMPLATES, validateDefinition } from '@platform/app-model';
import type { FastifyRequest } from 'fastify';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { checkPermission } from '../access/check.js';
import { loadSpace, spaceResource } from '../access/resources.js';
import { requireUser } from '../access/rules.js';
import { auditScopeFor, recordAudit } from '../audit/writer.js';
import type { AppContext } from '../context.js';
import type { Delivery } from '../delivery/service.js';
import { notFound, unprocessable } from '../errors.js';
import { type AppBuilder, digestOf } from './builder.js';
import { appResource } from './resources.js';
import { describeApp } from './routes.js';
import type { AppRuntime } from './runtime.js';
import { AppOut, AppParams, PlanOut } from './schemas.js';

/** The format of an exported app: its definition, with where it came from and a digest of it. */
export const BUNDLE_FORMAT = 'ambit.app/v1' as const;

const BundleOut = z.object({
  format: z.literal(BUNDLE_FORMAT),
  exportedAt: z.string(),
  app: z.object({ name: z.string(), handle: z.string(), description: z.string().nullable() }),
  revision: z.number().int(),
  /** SHA-256 of the definition's canonical JSON, as it was exported. */
  digest: z.string(),
  definition: z.record(z.string(), z.unknown()),
});

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

/** The labels of an app's record entities, for a template's summary. */
function entitiesOf(definition: (typeof TEMPLATES)[number]['definition']): string[] {
  const entities = definition.entities ?? {};
  const lines = new Set(Object.values(entities).flatMap((entity) => entity.fields.flatMap((field) => (field.type === 'lines' ? [field.entity] : []))));
  return Object.entries(entities).flatMap(([name, entity]) => (lines.has(name) ? [] : [entity.pluralLabel ?? entity.label]));
}

/**
 * Templates, export and import (design §6.6): definitions are readable files. An exported app can
 * be imported again, here or in another installation, and edited on the way. Data never travels
 * with it. In a team space, an import is a change request, reviewed like any change.
 */
export function bundleRoutes(ctx: AppContext, builder: AppBuilder, delivery: Delivery, runtime: AppRuntime): FastifyPluginAsyncZod {
  return async (app) => {
    app.get(
      '/v1/templates',
      {
        config: { access: { kind: 'authenticated' } },
        schema: {
          tags: ['apps'],
          summary: 'The apps a builder can start from, besides a blank one',
          response: {
            200: z.object({ templates: z.array(z.object({ id: z.string(), name: z.string(), description: z.string(), entities: z.array(z.string()) })) }),
          },
        },
      },
      async () => ({
        templates: TEMPLATES.map((template) => ({
          id: template.id,
          name: template.name,
          description: template.description,
          entities: entitiesOf(template.definition),
        })),
      }),
    );

    app.get(
      '/v1/apps/:appId/export',
      {
        config: {
          access: {
            kind: 'permission',
            action: 'app.export',
            resource: async (request: FastifyRequest) => appResource(ctx.org.id, await ctx.apps.ref((request.params as { appId: string }).appId)),
          },
        },
        schema: {
          tags: ['apps'],
          summary: "Download an app's definition as a file: its main line, never its data. Import it again, here or elsewhere",
          params: AppParams,
          response: { 200: BundleOut },
        },
      },
      async (request, reply) => {
        const ref = await ctx.apps.ref(request.params.appId);
        const definition = await ctx.apps.mainDefinition(ref);
        const digest = digestOf(definition);
        const now = ctx.now();
        await recordAudit(ctx.db, auditScopeFor(request, ctx.org.id, now), {
          action: 'app.export',
          target: { type: 'app', id: ref.app.id, name: ref.app.name },
          spaceId: ref.space.id,
          appId: ref.app.id,
          reason: { revision: ref.app.currentRevision, digest },
        });
        void reply.header('content-disposition', `attachment; filename="${ref.app.handle}.ambit.json"`);
        return {
          format: BUNDLE_FORMAT,
          exportedAt: now.toISOString(),
          app: { name: ref.app.name, handle: ref.app.handle, description: ref.app.description },
          revision: ref.app.currentRevision,
          digest,
          definition: definition as unknown as Record<string, unknown>,
        };
      },
    );

    app.post(
      '/v1/spaces/:spaceId/apps/import',
      {
        // A personal space checks app.create; a team space also change.open, as its import is a change request.
        config: { access: { kind: 'authenticated' } },
        schema: {
          tags: ['apps'],
          summary: 'Start an app from a template or from an exported file: in your personal space at once, or in a team space as a change request',
          params: z.object({ spaceId: z.uuid() }),
          body: z
            .object({
              name: z.string().trim().min(1).max(100).optional(),
              template: z.string().max(63).optional(),
              /** An exported file, or a bare definition. */
              bundle: z.record(z.string(), z.unknown()).optional(),
            })
            .refine((body) => (body.template === undefined) !== (body.bundle === undefined), { message: 'Give a template or a bundle, not both' }),
          response: {
            201: z.object({
              app: AppOut,
              plan: PlanOut.nullable(),
              changeRequest: z.object({ id: z.uuid(), number: z.number().int() }).nullable(),
              /** For a file: whether its definition is still as it was exported. Edited files import too. */
              asExported: z.boolean().nullable(),
            }),
          },
        },
      },
      async (request, reply) => {
        const auth = requireUser(request);
        const space = await loadSpace(ctx.db, ctx.org.id, request.params.spaceId);
        await checkPermission(ctx, request, auth, 'app.create', spaceResource(ctx.org.id, space));
        const { template: templateId, bundle } = request.body;
        let definition: unknown;
        let name: string;
        let description: string | null = null;
        let asExported: boolean | null = null;
        if (templateId !== undefined) {
          const template = TEMPLATES.find((t) => t.id === templateId);
          if (!template) throw notFound('Template');
          definition = template.definition;
          name = request.body.name ?? template.name;
        } else if (bundle && bundle['format'] === BUNDLE_FORMAT) {
          definition = bundle['definition'];
          const about = isObject(bundle['app']) ? bundle['app'] : {};
          name = request.body.name ?? (typeof about['name'] === 'string' ? about['name'] : 'Imported app');
          description = typeof about['description'] === 'string' ? about['description'] : null;
          const validated = validateDefinition(definition);
          asExported = validated.ok && digestOf(validated.definition as StoredDefinition) === bundle['digest'];
        } else if (bundle && bundle['format'] !== undefined) {
          throw unprocessable('unknown_format', `This file is in a format Ambit doesn't know: ${String(bundle['format'])}`);
        } else {
          definition = bundle;
          name = request.body.name ?? 'Imported app';
        }
        const source = templateId !== undefined ? { template: templateId } : { file: true, ...(asExported !== null ? { asExported } : {}) };

        if (space.kind === 'personal') {
          const { appId, plan } = await builder.create(request, auth, space, { name, ...(description ? { description } : {}), definition });
          await recordAudit(ctx.db, auditScopeFor(request, ctx.org.id, ctx.now()), {
            action: 'app.import',
            target: { type: 'app', id: appId, name },
            spaceId: space.id,
            appId,
            reason: source,
          });
          return reply.status(201).send({ app: await describeApp(ctx, runtime, auth, await ctx.apps.ref(appId)), plan, changeRequest: null, asExported });
        }
        const brought = await delivery.bringIn(request, auth, space, {
          name,
          description,
          definition,
          title: templateId !== undefined ? `Start ${name} from a template` : `Bring in ${name} from a file`,
          body:
            templateId !== undefined
              ? `${name} starts from the ${templateId} template.`
              : `${name} starts from an exported definition${asExported === false ? ', changed since it was exported' : ''}. No data comes with it.`,
        });
        await recordAudit(ctx.db, auditScopeFor(request, ctx.org.id, ctx.now()), {
          action: 'app.import',
          target: { type: 'app', id: brought.appId, name },
          spaceId: space.id,
          appId: brought.appId,
          reason: { ...source, changeRequestId: brought.changeRequest.id },
        });
        return reply.status(201).send({
          app: await describeApp(ctx, runtime, auth, await ctx.apps.ref(brought.appId)),
          plan: null,
          changeRequest: { id: brought.changeRequest.id, number: brought.changeRequest.number },
          asExported,
        });
      },
    );
  };
}
