import { entityFields, type CardData, type StoredDefinition, type StoredField } from '@platform/app-model';
import { serviceAccounts } from '@platform/db';
import { eq } from 'drizzle-orm';
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

function sourceTag(source: Record<string, unknown> | undefined): string {
  if (!source) return '';
  const tag = (kind: string, text: string) => `<span class="approval-source${kind ? ` ${kind}` : ''}">${text}</span>`;
  switch (source['source']) {
    case 'document':
      return tag('document', `Read from ${escape(source['document'] ?? 'a document')}${source['location'] ? `, ${escape(source['location'])}` : ''}`);
    case 'agent':
      return tag('agent', `Inferred by the agent${source['note'] ? `: ${escape(source['note'])}` : ''}`);
    case 'person':
      return tag('person', 'Edited by you');
    case 'model': {
      const confidence = typeof source['confidence'] === 'number' ? `, ${Math.round(source['confidence'] * 100)}% sure` : '';
      return tag('', `Predicted by ${escape(source['model'])}${source['version'] ? ` ${escape(source['version'])}` : ''}${confidence}`);
    }
    case 'platform':
      return tag('', 'Set by the app');
    default:
      return '';
  }
}

function formControl(definition: StoredDefinition, entity: string, name: string, value: unknown): string {
  const field = entityFields(definition.entities[entity]!).get(name)?.field;
  const id = `f-${escape(name)}`;
  const label = `<label for="${id}">${escape(field?.label ?? name)}</label>`;
  if (field?.type === 'boolean') {
    return `<div class="ambit-check"><input type="checkbox" id="${id}" name="${escape(name)}"${value === true ? ' checked' : ''}>${label}</div>`;
  }
  if (field?.type === 'choice') {
    const chosen = new Set(Array.isArray(value) ? value : [value]);
    const options = field.options.map((o) => `<option value="${escape(o.value)}"${chosen.has(o.value) ? ' selected' : ''}>${escape(o.label)}</option>`).join('');
    return `<div class="ambit-field">${label}<select class="ambit-input" id="${id}" name="${escape(name)}"${field.multiple ? ' multiple' : ''}>${field.multiple ? '' : '<option value=""></option>'}${options}</select></div>`;
  }
  const type = field?.type === 'number' ? 'number' : field?.type === 'date' ? 'date' : field?.type === 'email' ? 'email' : 'text';
  const step = field?.type === 'number' ? ` step="${field.decimals ? (1 / 10 ** field.decimals).toFixed(field.decimals) : '1'}"` : '';
  return `<div class="ambit-field">${label}<input class="ambit-input" type="${type}"${step} id="${id}" name="${escape(name)}" value="${escape(value ?? '')}"></div>`;
}

/** One labelled control for a field of a line. */
function lineFieldControl(field: StoredField, name: string, id: string, value: unknown): string {
  const label = `<label for="${id}">${escape(field.label)}</label>`;
  if (field.type === 'boolean') {
    return `<div class="ambit-check"><input type="checkbox" id="${id}" name="${escape(name)}"${value === true ? ' checked' : ''}>${label}</div>`;
  }
  if (field.type === 'choice') {
    const chosen = new Set(Array.isArray(value) ? value : [value]);
    const options = field.options.map((o) => `<option value="${escape(o.value)}"${chosen.has(o.value) ? ' selected' : ''}>${escape(o.label)}</option>`).join('');
    return `<div class="ambit-field">${label}<select class="ambit-input" id="${id}" name="${escape(name)}"${field.multiple ? ' multiple' : ''}>${field.multiple ? '' : '<option value=""></option>'}${options}</select></div>`;
  }
  const type = field.type === 'number' ? 'number' : field.type === 'date' ? 'date' : field.type === 'email' ? 'email' : 'text';
  const step = field.type === 'number' ? ` step="${field.decimals ? (1 / 10 ** field.decimals).toFixed(field.decimals) : '1'}"` : '';
  return `<div class="ambit-field">${label}<input class="ambit-input" type="${type}"${step} id="${id}" name="${escape(name)}" value="${escape(value ?? '')}"></div>`;
}

/**
 * A lines field in the edit form: each line as a small block of its fields, carrying its ID so the
 * platform knows which line changed, with a box to remove it; then an empty one to add a line.
 * Blocks rather than a table, so it fits a phone.
 */
function linesControl(definition: StoredDefinition, field: Extract<StoredField, { type: 'lines' }>, lines: ReadonlyArray<Record<string, unknown>>): string {
  const lineEntity = definition.entities[field.entity]!;
  const block = (line: Record<string, unknown> | null, index: number) => {
    const at = (f: string) => `${field.name}[${index}][${f}]`;
    const id = (f: string) => `f-${escape(field.name)}-${index}-${escape(f)}`;
    const title = line ? `${lineEntity.label} ${index + 1}` : `Add a ${lineEntity.label.toLowerCase()} (optional)`;
    const fields = lineEntity.fields.map((f) => lineFieldControl(f, at(f.name), id(f.name), line?.[f.name] ?? null)).join('');
    const keep = line && typeof line['id'] === 'string' ? `<input type="hidden" name="${at('id')}" value="${escape(line['id'])}">` : '';
    const remove = line ? `<div class="ambit-check"><input type="checkbox" id="${id('remove')}" name="${at('remove')}"><label for="${id('remove')}">Remove this ${escape(lineEntity.label.toLowerCase())}</label></div>` : '';
    return `<div class="approval-line${line ? '' : ' new'}"><p class="approval-line-title">${escape(title)}</p>${keep}<div class="approval-line-fields">${fields}</div>${remove}</div>`;
  };
  return `<fieldset class="approval-line-edit"><legend>${escape(field.label)}</legend>${[...lines.map(block), block(null, lines.length)].join('')}</fieldset>`;
}

/** A form value as a typed value, using its field's type. */
function typed(field: StoredField | undefined, raw: string | string[] | undefined): unknown {
  const one = Array.isArray(raw) ? raw[0] : raw;
  if (field?.type === 'boolean') return raw !== undefined;
  if (field?.type === 'choice' && field.multiple) return raw === undefined ? [] : Array.isArray(raw) ? raw : [raw];
  if (one === undefined || one === '') return null;
  return field?.type === 'number' ? Number(one) : one;
}

/** Form fields back to typed values, using the entity's field types. Lines come back as rows, without those removed or left empty. */
function fromForm(definition: StoredDefinition, entity: string, names: readonly string[], form: FormBody): Record<string, unknown> {
  const declared = definition.entities[entity]!;
  const fields = entityFields(declared);
  const values: Record<string, unknown> = {};
  for (const name of names) {
    const linesField = declared.fields.find((f) => f.name === name && f.type === 'lines');
    if (linesField?.type !== 'lines') {
      values[name] = typed(fields.get(name)?.field, form[name]);
      continue;
    }
    const lineFields = definition.entities[linesField.entity]!.fields;
    const rows = new Map<number, Record<string, string | string[]>>();
    for (const [key, raw] of Object.entries(form)) {
      const match = /^([a-z][a-z0-9_]*)\[(\d{1,4})\]\[([a-z][a-z0-9_]*)\]$/.exec(key);
      if (match?.[1] !== name) continue;
      const index = Number(match[2]);
      rows.set(index, { ...(rows.get(index) ?? {}), [match[3]!]: raw });
    }
    values[name] = [...rows.entries()]
      .sort(([a], [b]) => a - b)
      .flatMap(([, row]) => {
        if (row['remove'] !== undefined) return [];
        const line: Record<string, unknown> = Object.fromEntries(lineFields.map((f) => [f.name, typed(f, row[f.name])]));
        const id = typeof row['id'] === 'string' && row['id'] ? row['id'] : undefined;
        // An empty row the person didn't fill in isn't a line.
        if (!id && lineFields.every((f) => line[f.name] === null || line[f.name] === false || (Array.isArray(line[f.name]) && !(line[f.name] as unknown[]).length))) return [];
        return [id ? { id, ...line } : line];
      });
  }
  return values;
}

const STATUS: Record<ProposalRow['status'], { text: string; tone: 'warn' | 'good' | 'bad' | 'idle' }> = {
  pending: { text: 'Waiting for you to confirm', tone: 'warn' },
  approved: { text: 'Approved and submitted', tone: 'good' },
  rejected: { text: 'Rejected', tone: 'bad' },
  superseded: { text: 'Replaced by a revised version', tone: 'idle' },
  expired: { text: 'Expired', tone: 'idle' },
};

/** The review page, drawn in Ocean (packages/design): one approval card, built from the stored proposal. */
function page(input: {
  proposal: ProposalRow;
  card: CardData;
  definition: StoredDefinition | null;
  entity: string | null;
  inputs: readonly string[];
  agentName: string | null;
  error?: string;
}): string {
  const { proposal, card } = input;
  const pending = proposal.status === 'pending';
  const status = STATUS[proposal.status];
  // Agents are drawn in the agent tone, and people never are.
  const byAgent = proposal.proposedWithToken !== null || proposal.proposedByType !== 'user' || proposal.proposedBy !== proposal.onBehalfOf;
  const from = byAgent
    ? `<p class="approval-from">Prepared by ${input.agentName ? escape(input.agentName) : 'an agent'}, acting for you</p>`
    : '<p class="approval-from person">Revised by you</p>';
  const findings = card.findings.length
    ? `<ul class="approval-findings">${card.findings
        .map(
          (f) =>
            `<li class="approval-finding${f.severity === 'error' ? ' error' : ''}"><strong>${f.severity === 'error' ? 'Blocked' : 'Check'}:</strong> ${
              f.line ? `Line ${f.line.index + 1}: ` : ''
            }${escape(f.message)}</li>`,
        )
        .join('')}</ul>`
    : '<p class="approval-clear">The app\'s rules found nothing to check.</p>';
  const fields = card.fields
    .map((f) => `<div class="pair"><dt>${escape(f.label)}</dt><dd>${escape(f.display)}${sourceTag(f.source as Record<string, unknown> | undefined)}</dd></div>`)
    .join('');
  const tables = (card.tables ?? [])
    .map(
      (table) =>
        `<section class="approval-lines"><h2>${escape(table.label)}</h2><div class="approval-table-wrap"><table class="approval-table"><thead><tr>${table.columns
          .map((c) => `<th${c.type === 'number' ? ' class="number"' : ''}>${escape(c.label)}</th>`)
          .join('')}</tr></thead><tbody>${table.rows
          .map(
            (row) =>
              `<tr>${row.cells
                .map((cell) => `<td${cell.type === 'number' ? ' class="number"' : ''}>${escape(cell.display)}${sourceTag(cell.source as Record<string, unknown> | undefined)}</td>`)
                .join('')}</tr>`,
          )
          .join('')}</tbody></table></div></section>`,
    )
    .join('');
  const effect = (proposal.effect as { input?: Record<string, unknown> }).input ?? {};
  const control = (name: string) => {
    const field = input.definition!.entities[input.entity!]!.fields.find((f) => f.name === name);
    return field?.type === 'lines'
      ? linesControl(input.definition!, field, (effect[name] as Array<Record<string, unknown>> | undefined) ?? [])
      : formControl(input.definition!, input.entity!, name, effect[name]);
  };
  const edit =
    pending && input.definition && input.entity && input.inputs.length
      ? `<details class="approval-edit"><summary>Edit the values</summary><form method="post" action="/review/${proposal.id}/revise">${input.inputs
          .map(control)
          .join('')}<button type="submit" class="ambit-button">Save changes</button></form></details>`
      : '';
  const actions = pending
    ? `<div class="approval-actions"><form method="post" action="/review/${proposal.id}/approve"><input type="hidden" name="digest" value="${escape(proposal.digest)}"><button type="submit" class="ambit-button primary">Approve and submit</button></form>` +
      `<form method="post" action="/review/${proposal.id}/reject"><button type="submit" class="ambit-button">Reject</button></form></div>`
    : '';
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Review: ${escape(card.title)}</title>
<link rel="stylesheet" href="/assets/ocean.css"><link rel="stylesheet" href="/assets/ambit.css">
</head>
<body class="ambit-page"><main class="ambit-review">
<p><span class="badge ${status.tone}">${escape(status.text)}</span></p>
${input.error ? `<p class="ambit-error" role="alert">${escape(input.error)}</p>` : ''}
<article class="approval" aria-labelledby="approval-title">
<div class="approval-stripe"></div>
<div class="approval-body">
${from}
<h1 class="approval-title" id="approval-title">${escape(card.title)}</h1>
${findings}
<dl class="approval-changes">${fields}</dl>
${tables}
${edit}
${actions}
<p class="approval-signed">You are approving exactly this change, sealed as <code>${escape(proposal.digest.slice(0, 16))}</code>…. Expires ${escape(proposal.expiresAt.toISOString().slice(0, 16).replace('T', ' '))} UTC.</p>
</div></article>
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
      const [agent] =
        proposal.proposedByType === 'service_account' && proposal.proposedBy
          ? await ctx.db.select({ name: serviceAccounts.name }).from(serviceAccounts).where(eq(serviceAccounts.id, proposal.proposedBy))
          : [];
      reply.header('cache-control', 'no-store').type('text/html; charset=utf-8').status(error?.statusCode ?? 200);
      return page({
        proposal,
        card: proposal.card as unknown as CardData,
        definition: loaded?.definition ?? null,
        entity: action?.entity ?? null,
        inputs: action?.input ?? [],
        agentName: agent?.name ?? null,
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
