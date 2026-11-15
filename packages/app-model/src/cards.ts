import { z } from 'zod';
import { entityFields, type StoredDefinition } from './fields.js';
import type { Finding } from './rules.js';
import type { FieldType } from './schema.js';
import type { FieldValue, RecordValues } from './values.js';

/** Where a value came from (design §6.2). Without it, review turns into rubber-stamping. */
export const Provenance = z.discriminatedUnion('source', [
  /** Read from a document, such as a receipt, optionally with the place on it. */
  z.strictObject({ source: z.literal('document'), document: z.string().trim().min(1).max(500).optional(), location: z.string().trim().min(1).max(200).optional() }),
  /** Inferred by the agent, for example from a calendar entry. */
  z.strictObject({ source: z.literal('agent'), note: z.string().trim().min(1).max(500).optional() }),
  /** Entered or edited by the person. */
  z.strictObject({ source: z.literal('person') }),
  /** Set or computed by the platform, for example by an action. */
  z.strictObject({ source: z.literal('platform') }),
  /** Predicted by a model, with the model and version that produced it, and how sure it was. */
  z.strictObject({
    source: z.literal('model'),
    model: z.string().trim().min(1).max(200),
    version: z.string().trim().min(1).max(100).optional(),
    confidence: z.number().min(0).max(1).optional(),
  }),
]);
export type Provenance = z.infer<typeof Provenance>;

export interface CardField {
  readonly name: string;
  readonly label: string;
  readonly type: FieldType | 'system';
  readonly value: FieldValue;
  /** The value as a person reads it, for example an option's label rather than its value. */
  readonly display: string;
  readonly source?: Provenance;
}

/**
 * A review card in a neutral form that any channel can draw: a Teams or Slack adapter, an MCP
 * client, or the platform's own review page (design §6.4). It is built from the exact values a
 * proposal will write, never from an agent's summary of them.
 */
export interface CardData {
  readonly title: string;
  /** Rule findings come first: they are what a person most needs to look at. */
  readonly findings: Finding[];
  readonly fields: CardField[];
  readonly responses: Array<'approve' | 'edit' | 'reject'>;
}

/** How a value reads to a person. */
export function displayValue(definition: StoredDefinition, entity: string, field: string, value: FieldValue): string {
  if (value === null) return '—';
  const declared = definition.entities[entity]?.fields.find((f) => f.name === field);
  if (declared?.type === 'choice') {
    const label = (v: string) => declared.options.find((option) => option.value === v)?.label ?? v;
    return Array.isArray(value) ? value.map(label).join(', ') : label(value as string);
  }
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  if (typeof value === 'number' && declared?.type === 'number') {
    return value.toLocaleString('en-US', { minimumFractionDigits: declared.decimals, maximumFractionDigits: declared.decimals });
  }
  return Array.isArray(value) ? value.join(', ') : String(value);
}

export function buildCard(input: {
  readonly definition: StoredDefinition;
  readonly entity: string;
  /** The card to use. Without one, the card shows `show` under the `title` given. */
  readonly card?: string;
  readonly title?: string;
  readonly show?: readonly string[];
  readonly values: RecordValues;
  readonly findings: readonly Finding[];
  readonly provenance?: Readonly<Record<string, Provenance>>;
}): CardData {
  const { definition, entity, values } = input;
  const card = input.card ? definition.cards[input.card] : undefined;
  const fields = entityFields(definition.entities[entity]!);
  const show = card?.show ?? input.show ?? Object.keys(values);
  const titleTemplate = card?.title ?? input.title ?? definition.entities[entity]!.label;
  return {
    title: titleTemplate.replace(/\{\{\s*([a-z][a-z0-9_]*)\s*\}\}/g, (_, name: string) => displayValue(definition, entity, name, values[name] ?? null)),
    findings: [...input.findings],
    fields: show.flatMap((name) => {
      const info = fields.get(name);
      if (!info) return [];
      const value = values[name] ?? null;
      const source = input.provenance?.[name];
      return [{
        name,
        label: info.field?.label ?? name,
        type: info.field?.type ?? ('system' as const),
        value,
        display: displayValue(definition, entity, name, value),
        ...(source ? { source } : {}),
      }];
    }),
    responses: ['approve', 'edit', 'reject'],
  };
}
