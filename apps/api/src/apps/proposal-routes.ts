import { entityFields, type CardData, type StoredDefinition } from '@platform/app-model';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { requireAuth, requireSession } from '../access/rules.js';
import type { AppContext } from '../context.js';
import { HttpError } from '../errors.js';
import type { AppRuntime, ProposalRow } from './runtime.js';
import { ActionResultOut, ProposalOut, RecordOut } from './schemas.js';

const ProposalParams = z.object({ proposalId: z.uuid() });
type FormBody = Record<string, string | string[]>;

const escape = (value: unknown): string =>
  String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

function sourceLabel(source: Record<string, unknown> | undefined): string {
  if (!source) return '';
  switch (source['source']) {
    case 'document':
      return `Read from ${escape(source['document'] ?? 'a document')}${source['location'] ? `, ${escape(source['location'])}` : ''}`;
    case 'agent':
      return `Inferred by the agent${source['note'] ? `: ${escape(source['note'])}` : ''}`;
    case 'person':
      return 'Edited by you';
    case 'platform':
      return 'Set by the app';
    default:
      return '';
  }
}

function formControl(definition: StoredDefinition, entity: string, name: string, value: unknown): string {
  const field = entityFields(definition.entities[entity]!).get(name)?.field;
  const id = `f-${escape(name)}`;
  const label = `<label for="${id}">${escape(field?.label ?? name)}</label>`;
  if (field?.type === 'choice') {
    const chosen = new Set(Array.isArray(value) ? value : [value]);
    const options = field.options.map((o) => `<option value="${escape(o.value)}"${chosen.has(o.value) ? ' selected' : ''}>${escape(o.label)}</option>`).join('');
    return `${label}<select id="${id}" name="${escape(name)}"${field.multiple ? ' multiple' : ''}>${field.multiple ? '' : '<option value=""></option>'}${options}</select>`;
  }
  if (field?.type === 'boolean') return `<span class="check"><input type="checkbox" id="${id}" name="${escape(name)}"${value === true ? ' checked' : ''}> ${label}</span>`;
  const type = field?.type === 'number' ? 'number' : field?.type === 'date' ? 'date' : field?.type === 'email' ? 'email' : 'text';
  const step = field?.type === 'number' ? ` step="${field.decimals ? (1 / 10 ** field.decimals).toFixed(field.decimals) : '1'}"` : '';
  return `${label}<input type="${type}"${step} id="${id}" name="${escape(name)}" value="${escape(value ?? '')}">`;
}

/** Form fields back to typed values, using the entity's field types. */
function fromForm(definition: StoredDefinition, entity: string, names: readonly string[], form: FormBody): Record<string, unknown> {
  const fields = entityFields(definition.entities[entity]!);
  const values: Record<string, unknown> = {};
  for (const name of names) {
    const field = fields.get(name)?.field;
    const raw = form[name];
    const one = Array.isArray(raw) ? raw[0] : raw;
    if (field?.type === 'boolean') values[name] = raw !== undefined;
    else if (field?.type === 'choice' && field.multiple) values[name] = raw === undefined ? [] : Array.isArray(raw) ? raw : [raw];
    else if (one === undefined || one === '') values[name] = null;
    else if (field?.type === 'number') values[name] = Number(one);
    else values[name] = one;
  }
  return values;
}

const STATUS_TEXT: Record<ProposalRow['status'], string> = {
  pending: 'Waiting for you to confirm',
  approved: 'Approved and submitted',
  rejected: 'Rejected',
  superseded: 'Replaced by a revised version',
  expired: 'Expired',
};

function page(input: { proposal: ProposalRow; card: CardData; definition: StoredDefinition | null; entity: string | null; inputs: readonly string[]; error?: string }): string {
  const { proposal, card } = input;
  const pending = proposal.status === 'pending';
  const findings = card.findings.length
    ? `<ul class="findings">${card.findings.map((f) => `<li class="${f.severity}"><strong>${f.severity === 'error' ? 'Blocked' : 'Check'}:</strong> ${escape(f.message)}</li>`).join('')}</ul>`
    : '<p class="ok">The app\'s rules found nothing to check.</p>';
  const fields = card.fields
    .map((f) => `<div class="row"><dt>${escape(f.label)}</dt><dd>${escape(f.display)}${f.source ? `<span class="source">${sourceLabel(f.source as Record<string, unknown>)}</span>` : ''}</dd></div>`)
    .join('');
  const effect = (proposal.effect as { input?: Record<string, unknown> }).input ?? {};
  const edit =
    pending && input.definition && input.entity && input.inputs.length
      ? `<details><summary>Edit the values</summary><form method="post" action="/review/${proposal.id}/revise" class="edit">${input.inputs
          .map((name) => `<div class="field">${formControl(input.definition!, input.entity!, name, effect[name])}</div>`)
          .join('')}<button type="submit">Save changes</button></form></details>`
      : '';
  const actions = pending
    ? `<div class="actions"><form method="post" action="/review/${proposal.id}/approve"><input type="hidden" name="digest" value="${escape(proposal.digest)}"><button type="submit" class="primary">Approve and submit</button></form>` +
      `<form method="post" action="/review/${proposal.id}/reject"><button type="submit">Reject</button></form></div>`
    : '';
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Review: ${escape(card.title)}</title>
<style>
:root{color-scheme:light dark;--fg:#1d1d1f;--muted:#5f6368;--line:#d9d9de;--bg:#fff;--card:#f7f7f9;--warn:#8a5a00;--warnbg:#fff4d6;--err:#a50e0e;--errbg:#fde7e7;--accent:#1f5eff}
@media (prefers-color-scheme:dark){:root{--fg:#ececf1;--muted:#a0a3ab;--line:#3a3b40;--bg:#17181b;--card:#202125;--warn:#ffcf66;--warnbg:#3a2f12;--err:#ff8a8a;--errbg:#3d1b1b;--accent:#7aa2ff}}
body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif}
main{max-width:640px;margin:0 auto;padding:24px 16px 48px}
.status{color:var(--muted);margin:0 0 4px;font-size:14px}h1{font-size:24px;margin:0 0 16px}
.findings{list-style:none;padding:0;margin:0 0 16px}.findings li{padding:10px 12px;border-radius:8px;margin-bottom:8px}
.findings .warning{background:var(--warnbg);color:var(--warn)}.findings .error{background:var(--errbg);color:var(--err)}
.ok{color:var(--muted)}dl{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:4px 16px;margin:0 0 16px}
.row{display:flex;gap:16px;padding:10px 0;border-bottom:1px solid var(--line)}.row:last-child{border-bottom:0}
dt{flex:0 0 38%;color:var(--muted)}dd{margin:0;flex:1;overflow-wrap:anywhere}.source{display:block;font-size:13px;color:var(--muted)}
details{margin:0 0 16px}summary{cursor:pointer;color:var(--accent)}.edit{display:grid;gap:12px;margin-top:12px}
.field{display:grid;gap:4px}input,select{font:inherit;padding:8px;border:1px solid var(--line);border-radius:8px;background:var(--bg);color:var(--fg)}
.check{display:flex;gap:8px;align-items:center}.actions{display:flex;gap:12px;flex-wrap:wrap}
button{font:inherit;padding:10px 16px;border-radius:8px;border:1px solid var(--line);background:var(--card);color:var(--fg);cursor:pointer}
button.primary{background:var(--accent);border-color:var(--accent);color:#fff}.error-box{background:var(--errbg);color:var(--err);padding:10px 12px;border-radius:8px;margin-bottom:16px}
.seal{color:var(--muted);font-size:13px;margin-top:24px;overflow-wrap:anywhere}
</style></head>
<body><main>
<p class="status">${escape(STATUS_TEXT[proposal.status])}</p>
<h1>${escape(card.title)}</h1>
${input.error ? `<p class="error-box">${escape(input.error)}</p>` : ''}
${findings}
<dl>${fields}</dl>
${edit}
${actions}
<p class="seal">You are approving exactly this change, sealed as ${escape(proposal.digest.slice(0, 16))}…. Expires ${escape(proposal.expiresAt.toISOString().slice(0, 16).replace('T', ' '))} UTC.</p>
</main></body></html>`;
}

/** Proposals: what agents prepared for a person, and the review page where they approve it (design §6.3). */
export function proposalRoutes(ctx: AppContext, runtime: AppRuntime): FastifyPluginAsyncZod {
  return async (app) => {
    app.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string', bodyLimit: 64 * 1024 }, (_request, body, done) => {
      const params = new URLSearchParams(body as string);
      const form: FormBody = {};
      for (const key of new Set(params.keys())) {
        const all = params.getAll(key);
        form[key] = all.length > 1 ? all : all[0]!;
      }
      done(null, form);
    });

    app.get(
      '/v1/proposals',
      {
        config: { access: { kind: 'authenticated' } },
        schema: { tags: ['proposals'], summary: 'Proposals waiting for your confirmation', response: { 200: z.object({ proposals: z.array(ProposalOut) }) } },
      },
      async (request) => ({ proposals: await runtime.proposalsFor(requireAuth(request)) }),
    );

    app.get(
      '/v1/proposals/:proposalId',
      {
        config: { access: { kind: 'authenticated' } },
        schema: { tags: ['proposals'], summary: 'One proposal made for you, with its review card', params: ProposalParams, response: { 200: ProposalOut } },
      },
      async (request) => runtime.toProposalOut(await runtime.proposalFor(requireAuth(request), request.params.proposalId)),
    );

    app.post(
      '/v1/proposals/:proposalId/approve',
      {
        config: { access: { kind: 'authenticated' } },
        schema: {
          tags: ['proposals'],
          summary: 'Approve a proposal, naming the digest you were shown. Only you, signed in, can',
          params: ProposalParams,
          body: z.object({ digest: z.string().min(1) }),
          response: { 200: z.object({ proposal: ProposalOut, record: RecordOut }) },
        },
      },
      async (request) => runtime.approve(request, requireSession(request), request.params.proposalId, request.body.digest),
    );

    app.post(
      '/v1/proposals/:proposalId/reject',
      {
        config: { access: { kind: 'authenticated' } },
        schema: {
          tags: ['proposals'],
          summary: 'Reject a proposal, or withdraw it as the agent that made it',
          params: ProposalParams,
          body: z.object({ note: z.string().trim().max(500).optional() }).default({}),
          response: { 200: ProposalOut },
        },
      },
      async (request) => runtime.reject(request, requireAuth(request), request.params.proposalId, request.body.note),
    );

    app.post(
      '/v1/proposals/:proposalId/revise',
      {
        config: { access: { kind: 'authenticated' } },
        schema: {
          tags: ['proposals'],
          summary: 'Edit the values of a proposal. Your edits are marked as yours, and the new version waits for your approval',
          params: ProposalParams,
          body: z.object({ values: z.record(z.string(), z.unknown()) }),
          response: { 200: ActionResultOut, 202: ActionResultOut },
        },
      },
      async (request, reply) => {
        const result = await runtime.revise(request, requireSession(request), request.params.proposalId, request.body.values);
        return reply.status(result.status === 'needs_confirmation' ? 202 : 200).send(result);
      },
    );

    const render = async (request: FastifyRequest, reply: FastifyReply, id: string, error?: HttpError) => {
      const auth = requireAuth(request);
      const proposal = await runtime.proposalFor(auth, id);
      const loaded = await ctx.apps.load(proposal.appId).catch(() => null);
      const action = loaded?.definition.actions[proposal.action];
      reply.header('cache-control', 'no-store').type('text/html; charset=utf-8').status(error?.statusCode ?? 200);
      return page({
        proposal,
        card: proposal.card as unknown as CardData,
        definition: loaded?.definition ?? null,
        entity: action?.entity ?? null,
        inputs: action?.input ?? [],
        ...(error ? { error: error.message } : {}),
      });
    };
    const attempt = async (request: FastifyRequest, reply: FastifyReply, id: string, work: () => Promise<string | undefined>) => {
      try {
        const next = await work();
        return reply.redirect(`/review/${next ?? id}`, 303);
      } catch (error) {
        if (error instanceof HttpError && error.statusCode < 500) return render(request, reply, id, error);
        throw error;
      }
    };
    const FormSchema = z.record(z.string(), z.union([z.string(), z.array(z.string())])).default({});

    app.get(
      '/review/:proposalId',
      { config: { access: { kind: 'authenticated' } }, schema: { hide: true, params: ProposalParams } },
      async (request, reply) => render(request, reply, request.params.proposalId),
    );

    app.post(
      '/review/:proposalId/approve',
      { config: { access: { kind: 'authenticated' } }, schema: { hide: true, params: ProposalParams, body: FormSchema } },
      async (request, reply) =>
        attempt(request, reply, request.params.proposalId, async () => {
          const digest = request.body['digest'];
          await runtime.approve(request, requireSession(request), request.params.proposalId, typeof digest === 'string' ? digest : '');
          return undefined;
        }),
    );

    app.post(
      '/review/:proposalId/reject',
      { config: { access: { kind: 'authenticated' } }, schema: { hide: true, params: ProposalParams, body: FormSchema } },
      async (request, reply) =>
        attempt(request, reply, request.params.proposalId, async () => {
          await runtime.reject(request, requireSession(request), request.params.proposalId);
          return undefined;
        }),
    );

    app.post(
      '/review/:proposalId/revise',
      { config: { access: { kind: 'authenticated' } }, schema: { hide: true, params: ProposalParams, body: FormSchema } },
      async (request, reply) =>
        attempt(request, reply, request.params.proposalId, async () => {
          const auth = requireSession(request);
          const proposal = await runtime.proposalFor(auth, request.params.proposalId);
          const loaded = await ctx.apps.load(proposal.appId);
          const action = loaded.definition.actions[proposal.action];
          if (!action) throw new HttpError(409, 'definition_changed', 'The app changed since this was proposed.');
          const result = await runtime.revise(request, auth, proposal.id, fromForm(loaded.definition, action.entity, action.input, request.body));
          return result.status === 'needs_confirmation' ? result.proposal.id : undefined;
        }),
    );
  };
}
