import { z } from 'zod';
import { entityFields, type StoredDefinition } from './fields.js';
import type { Finding } from './rules.js';
import type { FieldType } from './schema.js';
import type { FieldValue, RecordLines, RecordValues } from './values.js';

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

/** A lines field on a card: one row per line, with the columns the card names. */
export interface CardTable {
  readonly field: string;
  readonly label: string;
  readonly columns: Array<{ readonly name: string; readonly label: string; readonly type: FieldType }>;
  /** Each line's cells, in the columns' order. New lines have no ID yet. */
  readonly rows: Array<{ readonly id: string | null; readonly cells: CardField[] }>;
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
  /** Lines, as tables. Cards made before line items have none. */
  readonly tables?: CardTable[];
  readonly responses: Array<'approve' | 'edit' | 'reject'>;
  /** The a7c skills the change starts once it is saved, in order. Their input is not shown: it may hold values the person can't read. */
  readonly then?: Array<{ readonly label: string; readonly skill: string }>;
}

/** A file as cards and screens name it. */
export interface FileInfo {
  readonly name: string;
  readonly contentType: string;
  readonly size: number;
}

/** How a value reads to a person. A file reads as its name, if known. */
export function displayValue(definition: StoredDefinition, entity: string, field: string, value: FieldValue, files: Readonly<Record<string, FileInfo>> = {}): string {
  if (value === null) return '—';
  const declared = definition.entities[entity]?.fields.find((f) => f.name === field);
  if (declared?.type === 'file') return typeof value === 'string' && files[value] ? files[value].name : 'A file';
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
  /** The record's lines, by lines field, as they will be. */
  readonly lines?: RecordLines;
  readonly findings: readonly Finding[];
  /** Where values came from, by field; for a line's value, as `lines[2].amount`. */
  readonly provenance?: Readonly<Record<string, Provenance>>;
  /** The files the values name, so the card can show their names. */
  readonly files?: Readonly<Record<string, FileInfo>>;
  /** The a7c skills the change starts once it is saved. */
  readonly skills?: ReadonlyArray<{ readonly label: string; readonly skill: string }>;
}): CardData {
  const { definition, entity, values } = input;
  const card = input.card ? definition.cards[input.card] : undefined;
  const fields = entityFields(definition.entities[entity]!);
  const show = card?.show ?? input.show ?? Object.keys(values);
  const titleTemplate = card?.title ?? input.title ?? definition.entities[entity]!.label;
  const linesFields = definition.entities[entity]!.fields.flatMap((f) => (f.type === 'lines' ? [f] : []));
  // A card's table names its lines and columns; without one, any lines field it shows gets every column.
  const shown = card?.table
    ? [{ of: card.table.of, columns: card.table.columns }]
    : show.flatMap((name) => {
        const lines = linesFields.find((f) => f.name === name);
        return lines ? [{ of: name, columns: definition.entities[lines.entity]!.fields.map((f) => f.name) }] : [];
      });
  const tables = shown.flatMap(({ of, columns }): CardTable[] => {
    const lines = linesFields.find((f) => f.name === of);
    if (!lines || !input.lines?.[of]) return [];
    const lineEntity = definition.entities[lines.entity]!;
    const declared = columns.flatMap((name) => lineEntity.fields.filter((f) => f.name === name));
    return [{
      field: of,
      label: lines.label,
      columns: declared.map((f) => ({ name: f.name, label: f.label, type: f.type })),
      rows: input.lines[of]!.map((line, index) => ({
        id: line.id,
        cells: declared.map((f) => {
          const value = line.values[f.name] ?? null;
          const source = input.provenance?.[`${of}[${index}].${f.name}`];
          return { name: f.name, label: f.label, type: f.type, value, display: displayValue(definition, lines.entity, f.name, value, input.files), ...(source ? { source } : {}) };
        }),
      })),
    }];
  });
  return {
    title: titleTemplate.replace(/\{\{\s*([a-z][a-z0-9_]*)\s*\}\}/g, (_, name: string) => displayValue(definition, entity, name, values[name] ?? null)),
    findings: [...input.findings],
    ...(tables.length ? { tables } : {}),
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
        display: displayValue(definition, entity, name, value, input.files),
        ...(source ? { source } : {}),
      }];
    }),
    responses: ['approve', 'edit', 'reject'],
    ...(input.skills?.length ? { then: input.skills.map(({ label, skill }) => ({ label, skill })) } : {}),
  };
}
