import { isComputed, lineOwners, type StoredDefinition, type StoredEntity, type StoredField } from '@platform/app-model';
import type { FastifyRequest } from 'fastify';
import type { LoadedApp } from '../apps/catalog.js';
import type { AppRuntime } from '../apps/runtime.js';
import type { AuthContext } from '../context.js';
import { HttpError } from '../errors.js';

/** How many sample records each entity gets. */
const SAMPLES = 3;

/** Records whose entities refer to others come after those others, so references have something to point at. */
function inReferenceOrder(definition: StoredDefinition, names: readonly string[]): string[] {
  const ordered: string[] = [];
  const visiting = new Set<string>();
  const visit = (name: string) => {
    if (ordered.includes(name) || visiting.has(name)) return;
    visiting.add(name);
    for (const field of definition.entities[name]!.fields) {
      if (field.type === 'reference' && names.includes(field.entity)) visit(field.entity);
    }
    ordered.push(name);
  };
  for (const name of names) visit(name);
  return ordered;
}

/** A plausible value for a field, or undefined to leave it empty. Computed, file and unknown fields stay empty. */
function sampleValue(
  definition: StoredDefinition,
  entity: StoredEntity,
  field: StoredField,
  n: number,
  context: { readonly userId: string; readonly today: Date; readonly samples: ReadonlyMap<string, readonly string[]> },
): unknown {
  // The platform works these out.
  if (isComputed(field)) return undefined;
  switch (field.type) {
    case 'text': {
      if (field.default !== undefined) return field.default;
      const base = entity.titleField === field.name || field.name === 'title' || field.name === 'name' ? `Sample ${entity.label.toLowerCase()}` : `Sample ${field.label.toLowerCase()}`;
      return `${base} ${n}`.slice(0, field.maxLength);
    }
    case 'email':
      return `sample${n}@example.com`;
    case 'number': {
      if (field.default !== undefined) return field.default;
      const low = field.min ?? 0;
      const value = Math.min(field.max ?? Number.MAX_SAFE_INTEGER, low + 10 * n + (field.decimals ? 0.5 : 0));
      return Number(value.toFixed(field.decimals));
    }
    case 'boolean':
      return field.default ?? n % 2 === 0;
    case 'date':
      return new Date(context.today.getTime() - n * 86_400_000).toISOString().slice(0, 10);
    case 'datetime':
      return new Date(context.today.getTime() - n * 3_600_000).toISOString();
    case 'choice': {
      if (field.default !== undefined) return field.default;
      const option = field.options[(n - 1) % field.options.length]!.value;
      return field.multiple ? [option] : option;
    }
    case 'user':
      return context.userId;
    case 'reference': {
      const targets = context.samples.get(field.entity) ?? [];
      return targets.length ? targets[(n - 1) % targets.length] : undefined;
    }
    case 'lines': {
      const lineEntity = definition.entities[field.entity]!;
      return [1, 2].slice(0, field.max).map((m) => valuesFor(definition, lineEntity, n * 10 + m, context));
    }
    case 'file':
      return undefined;
  }
}

function valuesFor(definition: StoredDefinition, entity: StoredEntity, n: number, context: Parameters<typeof sampleValue>[4]): Record<string, unknown> {
  const values: Record<string, unknown> = {};
  for (const field of entity.fields) {
    const value = sampleValue(definition, entity, field, n, context);
    if (value !== undefined) values[field.name] = value;
  }
  return values;
}

/**
 * Give a new working copy some sample records, so the builder has something to try their change
 * on. They go through the normal create path, so the app's rules and permissions apply; a record
 * the rules refuse is simply left out. Prod data never comes into a personal space.
 */
export async function addSampleRecords(runtime: AppRuntime, request: FastifyRequest, auth: AuthContext, loaded: LoadedApp, today: Date): Promise<number> {
  const definition = loaded.definition;
  const lineEntities = lineOwners(definition);
  const names = Object.keys(definition.entities).filter((name) => !lineEntities.has(name));
  const samples = new Map<string, string[]>();
  let created = 0;
  for (const name of inReferenceOrder(definition, names)) {
    const ids: string[] = [];
    for (let n = 1; n <= SAMPLES; n++) {
      const values = valuesFor(definition, definition.entities[name]!, n, { userId: auth.actor.id, today, samples });
      const provenance = Object.fromEntries(Object.keys(values).map((field) => [field, { source: 'platform' }]));
      try {
        const record = await runtime.create(request, auth, loaded, name, { values, provenance });
        ids.push(record.id);
        created++;
      } catch (error) {
        // Sample values that the app's own rules refuse: leave that record out.
        if (!(error instanceof HttpError) || error.statusCode >= 500) throw error;
      }
    }
    samples.set(name, ids);
  }
  return created;
}
